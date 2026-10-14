// @ts-check

/**
 *
 * @param {(from: number, message: any)=>any} handler
 * @param {Int32Array} ia32
 */
function listen(handler, ia32) {
    /**
     *
     * @param {*} msg
     * @param  {...any} arg
     */
    function log (msg, ...arg) {
        console.debug('[#' + Atomics.add(ia32, OFFSET_LOG_ID, 1) + ']: #' + current + ' ' + msg, ...arg)
    }

    /**
     *
     * @param {number} GIL
     */
    function explainGIL(GIL) {
        return `0x${GIL.toString(16)} (state: ${field(GIL, MASK_STATE)}, from: ${field(GIL, MASK_FROM)}, to: ${field(GIL, MASK_TO)})`
    }

    const counter = (() => {
        let i = 0;
        return () => i++
    })()

    const MASK_STATE = counter()
    const MASK_FROM = counter()
    const MASK_TO = counter()
    const MASK_STACK_OFFSET = counter()

    const MASK = {
        [MASK_STATE]: 0x000000ff,
        [MASK_FROM]: 0x0000ff00,
        [MASK_TO]: 0x00ff0000,
        [MASK_STACK_OFFSET]: 0xff000000
    }
    const MASK_OFFSET = {
        [MASK_STATE]: 0,
        [MASK_FROM]: 8,
        [MASK_TO]: 16,
        [MASK_STACK_OFFSET]: 24
    }

    /**
     * @typedef {'timed-out'|'not-equal'|'ok'} AtomicReturnValue
     */

    const SPIN_LOOP_LIMIT = 100
    /**
     * Wait sync, falls back to spinning where Atomics.wait is not allowed (the main thread)
     * @param {Int32Array} ia32
     * @param {number} offset
     * @param {number} old
     * @param {number} timeout
     * @returns {AtomicReturnValue}
     */
    function wait(ia32, offset, old, timeout = Infinity) {
        const start = performance.now()

        try {
            return Atomics.wait(ia32, offset, old, timeout)
        } catch (err) { }

        while (Atomics.load(ia32, offset) === old) {
            if (performance.now() - start >= Math.min(SPIN_LOOP_LIMIT, timeout)) {
                return 'timed-out'
            }
        }

        return 'not-equal'
    }

    /**
     * Wait async
     * @param {Int32Array} ia32
     * @param {number} offset
     * @param {number} old
     * @returns {Promise<AtomicReturnValue>}
     */
    function waitAsync(ia32, offset, old) {
        // @ts-ignore
        const res = Atomics.waitAsync(ia32, offset, old)

        // the polyfill returns a promise, the native one returns { async, value }
        if (typeof res.then === 'function') {
            return res
        }

        return res.async ? res.value : Promise.resolve(res.value)
    }

    /**
     * memory layout (offsets are Int32Array indexes)
     * ```
     * name   Log id | Thread index | GIL   | Buffer size | Data          |
     * value  int32  | int32        | int32 | int32       | user provided |
     * offset 0      | 4            | 8     | 12          | 16 - end      |
     * ```
     */

    const SIZE_LOG_ID_INDEX = 4
    const SIZE_THREAD_INDEX = 4
    const SIZE_GIL = 4
    const SIZE_BUFFER_SIZE = 4

    const OFFSET_LOG_ID = 0
    const OFFSET_THREAD_INDEX = OFFSET_LOG_ID + SIZE_LOG_ID_INDEX
    const OFFSET_GIL = OFFSET_THREAD_INDEX + SIZE_THREAD_INDEX
    const OFFSET_BUFFER_SIZE = OFFSET_GIL + SIZE_GIL
    const OFFSET_DATA = OFFSET_BUFFER_SIZE + SIZE_BUFFER_SIZE

    const STATE_PREPARE = 1
    const STATE_SEND = 2
    const STATE_RESPONSE = 3

    const MAX_THREAD_ID = 0xff

    // Thread ids start at 1, so a zero `to` field never addresses a real thread
    // (the idle GIL and the PREPARE state both have to = 0)
    const current = Atomics.add(ia32, OFFSET_THREAD_INDEX, 1) + 1

    if (current > MAX_THREAD_ID) {
        throw new Error('too many threads, at most ' + MAX_THREAD_ID + ' are supported')
    }

    /**
     * Acquire the GIL
     * @param {Int32Array} typedArray
     * @param {number} index
     * @param {number} currentThread
     * @returns {{current: number, success: boolean}}
     */
    function acquireGIL(typedArray, index, currentThread) {
        const newState = (currentThread << MASK_OFFSET[MASK_FROM]) | (STATE_PREPARE << MASK_OFFSET[MASK_STATE])
        const original = Atomics.compareExchange(typedArray, index, 0, newState)
        const success = original === 0
        const current = success ? newState : original

        return {
            current,
            success
        }
    }

    /**
     * release the GIL
     * @param {Int32Array} typedArray
     */
    function releaseGIL(typedArray) {
        Atomics.store(typedArray, OFFSET_GIL, 0)
        Atomics.notify(typedArray, OFFSET_GIL, Infinity)
    }

    /**
     * whether the GIL holds a request for this thread
     * @param {number} GIL
     * @param {number} currentThread
     */
    function isRequestFor(GIL, currentThread) {
        return field(GIL, MASK_STATE) === STATE_SEND && field(GIL, MASK_TO) === currentThread
    }

    /**
     * Poll requests while the thread is idle.
     * Requests that arrive while the thread is blocked in `send` are handled there instead.
     * @param {Int32Array} ia32
     * @param {number} currentThread
     */
    async function pollRequests(ia32, currentThread) {
        while (true) {
            const GIL = Atomics.load(ia32, OFFSET_GIL)

            if (isRequestFor(GIL, currentThread)) {
                try {
                    handleMessage(ia32, currentThread, GIL)
                } catch (err) {
                    console.error(err)
                }
                continue
            }

            // wait on the value we saw rather than on idle,
            // so a busy GIL doesn't turn this into a hot loop
            try {
                await waitAsync(ia32, OFFSET_GIL, GIL)
            } catch (err) {
                console.error(err)
                await new Promise(resolve => setTimeout(resolve, SPIN_LOOP_LIMIT))
            }
        }
    }

    /**
     * @param {any} err
     * @returns {string}
     */
    function errorMessage(err) {
        return String(err && err.message || err)
    }

    /**
     * handle request, always writes a response back so the sender never hangs
     * @param {Int32Array} ia32
     * @param {number} current
     * @param {number} GIL
     */
    function handleMessage(ia32, current, GIL) {
        if (!isRequestFor(GIL, current)) {
            throw new Error('not a request for #' + current + ': ' + explainGIL(GIL))
        }

        const from = field(GIL, MASK_FROM)

        /** @type {{ok?: any, error?: string}} */
        let response
        const oldThreadState = threadState
        threadState = THREAD_STATE_BLOCKING

        try {
            const message = getMessage(ia32, Atomics.load(ia32, OFFSET_BUFFER_SIZE))
            response = { ok: handler(from, message) }
        } catch (err) {
            response = { error: errorMessage(err) }
        } finally {
            threadState = oldThreadState
        }

        let size
        try {
            size = setMessage(ia32, response)
        } catch (err) {
            size = setMessage(ia32, { error: 'failed to send response: ' + errorMessage(err) })
        }
        Atomics.store(ia32, OFFSET_BUFFER_SIZE, size)

        let newGIL =
            current << MASK_OFFSET[MASK_FROM] |
            from << MASK_OFFSET[MASK_TO] |
            STATE_RESPONSE << MASK_OFFSET[MASK_STATE]

        Atomics.store(ia32, OFFSET_GIL, newGIL)
        Atomics.notify(ia32, OFFSET_GIL, Infinity)
    }

    /**
     * poll the response back, handling any request sent to us in the meantime
     * @param {Int32Array} ia32
     * @param {number} currentThread
     * @param {number} target
     * @returns {{ok?: any, error?: string}}
     */
    function pollResponse(ia32, currentThread, target) {
        let GIL = Atomics.load(ia32, OFFSET_GIL)

        while (true) {
            if (field(GIL, MASK_TO) === currentThread) {
                const state = field(GIL, MASK_STATE)

                if (state === STATE_RESPONSE && field(GIL, MASK_FROM) === target) {
                    return getMessage(ia32, Atomics.load(ia32, OFFSET_BUFFER_SIZE))
                }

                if (state === STATE_SEND) {
                    // we got a side quest
                    handleMessage(ia32, currentThread, GIL)
                    GIL = Atomics.load(ia32, OFFSET_GIL)
                    continue
                }

                throw new Error('unexpected GIL state while waiting for #' + target + ': ' + explainGIL(GIL))
            }

            wait(ia32, OFFSET_GIL, GIL)
            GIL = Atomics.load(ia32, OFFSET_GIL)
        }
    }

    /**
     * access bit field
     * @param {number} GIL
     * @param {number} field
     */
    function field(GIL, field) {
        return (GIL & MASK[field]) >>> MASK_OFFSET[field]
    }

    const encoder = new TextEncoder()
    /**
     *
     * @param {Int32Array} int32
     * @param {any} message
     * @returns {number} set size
     */
    function setMessage(int32, message) {
        /**
         * @type {SharedArrayBuffer}
         */
        const sab = /** @type {any} */ (int32.buffer)
        const encoded = encoder.encode(JSON.stringify(message))
        const capacity = sab.byteLength - OFFSET_DATA * 4

        if (encoded.byteLength > capacity) {
            throw new RangeError('message too large: ' + encoded.byteLength + ' bytes, buffer holds ' + capacity)
        }

        const targetBuffer = new Uint8Array(sab, OFFSET_DATA * 4, encoded.byteLength)
        targetBuffer.set(encoded)

        return encoded.byteLength
    }

    const decoder = new TextDecoder()
    /**
     *
     * @param {Int32Array} int32
     * @param {number} size
     * @returns {any}
     */
    function getMessage(int32, size) {
        /**
         * @type {SharedArrayBuffer}
         */
        const sab = /** @type {any} */ (int32.buffer)
        const targetBuffer = new Uint8Array(new Uint8Array(sab, OFFSET_DATA * 4, size))
        const text = decoder.decode(targetBuffer)

        return JSON.parse(text)
    }

    const THREAD_STATE_NORMAL = 0
    const THREAD_STATE_BLOCKING = 1
    let threadState = THREAD_STATE_NORMAL
    /**
     * @param {Int32Array} ia32
     * @param {number} currentThread
     * @param {number} targetThread
     * @param {any} message
     */
    function send(ia32, currentThread, targetThread, message) {
        function actualSend() {
            if (currentThread === targetThread) {
                console.trace('you can\'t send to yourself!!!')
                throw new Error('err')
            }

            let GIL =
                currentThread << MASK_OFFSET[MASK_FROM] |
                targetThread << MASK_OFFSET[MASK_TO] |
                STATE_SEND << MASK_OFFSET[MASK_STATE]

            // may throw (unserializable / too large), nothing is published yet if it does
            var size = setMessage(ia32, message)
            Atomics.store(ia32, OFFSET_BUFFER_SIZE, size)

            Atomics.store(ia32, OFFSET_GIL, GIL)
            Atomics.notify(ia32, OFFSET_GIL, Infinity)

            const response = pollResponse(ia32, currentThread, targetThread)

            if (response.error !== undefined) {
                throw new Error(response.error)
            }

            return response.ok
        }

        if (threadState === THREAD_STATE_BLOCKING) {
            // sync mode, in middle of handling a message sync ...etc
            // the GIL belongs to the call chain we are part of, just send it directly and hard wait
            return actualSend()
        }

        // async mode
        threadState = THREAD_STATE_BLOCKING

        try {
            // try acquire GIL
            let { success, current: currentGIL } = acquireGIL(ia32, OFFSET_GIL, currentThread)

            while (!success) {
                if (isRequestFor(currentGIL, currentThread)) {
                    // This will block until all triggered rpc exited, includes those trigger in the middle
                    handleMessage(ia32, currentThread, currentGIL)
                } else {
                    // not my business, just wait next turn
                    wait(ia32, OFFSET_GIL, currentGIL)
                }

                const result = acquireGIL(ia32, OFFSET_GIL, currentThread)
                success = result.success
                currentGIL = result.current
            }

            try {
                return actualSend()
            } finally {
                releaseGIL(ia32)
            }
        } finally {
            threadState = THREAD_STATE_NORMAL
        }
    }

    pollRequests(ia32, current)

    return {
        current,
        send (/** @type {number} */targetThread, /** @type {any} */message) {
            // I really don't know why, but leave this here makes chrome happy
            console.debug(message)
            return send(ia32, current, targetThread, message)
        }
    }
}
