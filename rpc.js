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
        // console.debug('[#' + Atomics.add(ia32, OFFSET_LOG_ID, 1) + ']: #' + current + ' ' + msg, ...arg)
    }

    /**
     * 
     * @param {number} GIL 
     */
    function explainGIL(GIL) {
        log(`
            NUM: ${GIL}
            HEX: ${GIL.toString(16)}
            STATE: ${field(GIL, MASK_STATE)}
            FROM: ${field(GIL, MASK_FROM)}
            TO: ${field(GIL, MASK_TO)}
        `)
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


    class AbortError extends Error { }

    /**
     * @typedef {'timed-out'|'not-equal'|'ok'} AtomicReturnValue
     */

    /**
     * @template T
     * @param {Promise<T>} promise 
     * @returns {{cancel: ()=>void, promise: Promise<T>}}
     */
    function cancelable(promise) {
        const token = {
            finished: false,
            err: null,
            /**
             * @param {any} err 
             */
            cancel(err) {
                if (!token.finished) {
                    token.finished = true
                    token.err = err
                    token.cbs.forEach(cb => cb(err))
                    token.cbs = []
                }
            },
            /**
             * @type {((err: any)=>void)[]}
             */
            cbs: [],
            /**
             * 
             * @param {(err: any)=>void} cb 
             */
            onCancel(cb) {
                if (token.finished) {
                    cb(token.err)
                    return
                }

                token.cbs.push(cb)
            }
        }

        return {
            cancel() {
                token.cancel(new AbortError('user abort'))
            },
            promise: new Promise(function (onResolve, onReject) {
                token.onCancel(err => onReject(err))
                promise.then(onResolve, onReject)
            })
        }
    }

    /**
     * Wait sync
     * @param {Int32Array} ia32
     * @param {number} offset
     * @param {number} old
     * @param {number} timeout
     * @returns {AtomicReturnValue}
     */
    function wait(ia32, offset, old, timeout = Infinity) {
        const start = performance.now()

        try {
            // console.trace('block wait start')
            var res = Atomics.wait(ia32, offset, old, timeout)
            // log('block wait end')
            return res
        } catch (err) { }

        while (Atomics.load(ia32, offset) === old) {
            if (performance.now() - start >= timeout) {
                return 'timed-out'
            }
        }

        //log('not-equal')
        return 'not-equal'
    }

    /**
     * Wait async
     * @param {Int32Array} ia32
     * @param {number} offset
     * @param {number} old
     * @param {number} timeout
     */
    function waitAsync(ia32, offset, old, timeout = Infinity) {
        // @ts-ignore
        return cancelable(Atomics.waitAsync(ia32, offset, old, timeout))
    }

    /**
     * memory layout
     * ```
     * name   Thread index | GIL   | Thread lock | Buffer size | Data          |
     * value  int32        | int32 | int32[256]  | int32       | user provided |
     * size   4            | 4     | 4 * 256     | 4           | All - other   |
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

    let current = 0

    while (Atomics.compareExchange(ia32, OFFSET_THREAD_INDEX, current, current + 1) !== current) {
        current++;
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

        // if (success) {
        //     log('set gil to ' + current)
        // }

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
        log('set gil to 0')
        Atomics.store(typedArray, OFFSET_GIL, 0)
        Atomics.load(typedArray, OFFSET_GIL)
        Atomics.notify(typedArray, OFFSET_GIL, Infinity)
    }

    let pollSwitch = 1
    let cancel = () => { }
    /**
     * stop async the poll loop
     */
    function stopAsyncPolling() {
        if (pollSwitch === 0) {
            cancel()
        }

        pollSwitch++
    }

    /**
     * start async poll loop
     * @param {Int32Array} ia32 
     * @param {number} currentThread 
     */
    function startAsyncPolling(ia32, currentThread) {
        pollSwitch--
        if (pollSwitch < 0) throw new Error('fuck you')
        if (pollSwitch !== 0) {
            return () => {}
        }


        let cancelCurrent = () => { }

        async function loop() {
            while (true) {
                try {
                    let { promise, cancel } = pollRequestAsync(ia32, currentThread)
                    cancelCurrent = cancel
                    await promise

                    const GIL = Atomics.load(ia32, OFFSET_GIL)
                    if (GIL === 0 || field(GIL, MASK_TO) !== currentThread) continue

                    handleMessage(ia32, currentThread, GIL)
                } catch (err) {
                    if (err instanceof AbortError) {
                        break
                    }

                    // rethrow it anyway
                    throw err
                }
            }
        }

        loop()

        cancel = () => {
            // console.trace('called cancel')
            cancelCurrent()
        }
    }

    /**
     * handle request
     * @param {Int32Array} ia32 
     * @param {number} current 
     * @param {number?} GIL 
     */
    function handleMessage(ia32, current, GIL = null) {
        GIL = GIL !== null ? GIL: Atomics.load(ia32, OFFSET_GIL)
        const OLD = GIL
        const state = field(GIL, MASK_STATE)

        if (state !== STATE_SEND) {
            // maybe preparing...
            wait(ia32, OFFSET_GIL, GIL)
            GIL = Atomics.load(ia32, OFFSET_GIL)
        }

        if (field(GIL, MASK_STATE) !== STATE_SEND) {
            log('I am ', current)
            explainGIL(OLD)
            explainGIL(GIL)
            debugger
            throw new Error('bad state 0x' + state.toString(16))
        }

        const from = field(GIL, MASK_FROM)

        const messageSize = Atomics.load(ia32, OFFSET_BUFFER_SIZE)
        const message = getMessage(ia32, messageSize)

        const response = handler(from, message)

        const size = setMessage(ia32, response)
        Atomics.store(ia32, OFFSET_BUFFER_SIZE, size)

        let newGIL =
            current << MASK_OFFSET[MASK_FROM] |
            from << MASK_OFFSET[MASK_TO] |
            STATE_RESPONSE << MASK_OFFSET[MASK_STATE]

        // send the message via GIL if the target is in block mode
        log('set gil to ' + newGIL)
        Atomics.store(ia32, OFFSET_GIL, newGIL)
        Atomics.notify(ia32, OFFSET_GIL, Infinity)
    }

    /**
     * poll the request once
     * @param {Int32Array} ia32 
     * @param {number} currentThread 
     */
    function pollRequestAsync(ia32, currentThread) {
        const IDLE = 0

        const GIL = Atomics.load(ia32, OFFSET_GIL)

        if (GIL !== IDLE) {
            return {
                cancel () {},
                promise: Promise.resolve('not-equal')
            }
        }

        const { cancel, promise } = waitAsync(ia32, OFFSET_GIL, IDLE)

        return {
            cancel,
            promise: promise.then((res) => {
                return res
            })
        }
    }

    /**
     * poll the response back
     * @param {Int32Array} ia32 
     * @param {number} GIL 
     * @param {number} currentThread
     * @param {number} target
     */
    function pollResponse(ia32, GIL, currentThread, target) {
        while (true) {
            let to;
            let from;

            do {
                wait(ia32, OFFSET_GIL, GIL)
                GIL = Atomics.load(ia32, OFFSET_GIL)
                explainGIL(GIL)
                to = field(GIL, MASK_TO)
                from = field(GIL, MASK_FROM)
            } while (to !== currentThread || from !== target)

            if (field(GIL, MASK_STATE) === STATE_RESPONSE) {
                log('response polled')
                explainGIL(GIL)
                return getMessage(ia32, Atomics.load(ia32, OFFSET_BUFFER_SIZE))
            } else if (field(GIL, MASK_STATE) === STATE_SEND) {
                // we got a side quest
                stopAsyncPolling()
                handleMessage(ia32, currentThread, GIL)
                startAsyncPolling(ia32, currentThread)
            } else {
                // we fuck up, really hard
                // debugger;
            }
        }
    }

    /**
     * access bit field
     * @param {number} GIL 
     * @param {number} field 
     */
    function field(GIL, field) {
        return (GIL & MASK[field]) >> MASK_OFFSET[field]
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
        const sab = (int32.buffer)
        const encoded = encoder.encode(JSON.stringify(message))
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
        const sab = (int32.buffer)
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
        //log('about to send ' + message + ' at #' + current)

        function actualSend() {
            let GIL =
                currentThread << MASK_OFFSET[MASK_FROM] |
                targetThread << MASK_OFFSET[MASK_TO] |
                STATE_SEND << MASK_OFFSET[MASK_STATE]


            log(`send from #${currentThread} to #${targetThread}`)
            
            var size = setMessage(ia32, message)
            Atomics.store(ia32, OFFSET_BUFFER_SIZE, size)

            // send the message via GIL if the target is in block mode
            Atomics.store(ia32, OFFSET_GIL, GIL)

            Atomics.load(ia32, OFFSET_GIL)

            // send the message via GIL if the target is in block mode
            Atomics.notify(ia32, OFFSET_GIL, Infinity)

            return pollResponse(ia32, GIL, currentThread, targetThread)
        }

        if (threadState === THREAD_STATE_NORMAL) {
            // async mode

            // try acquire GIL
            let { success, current: currentGIL } = acquireGIL(ia32, OFFSET_GIL, currentThread)
            threadState = THREAD_STATE_BLOCKING

            if (!success) {
                log('stuck')
                explainGIL(currentGIL)
            }

            while (!success) {
                // handle the state
                if (currentGIL !== 0 && field(currentGIL, MASK_TO) === currentThread) {
                    // This will block until all triggered rpc exited, includes those trigger in the middle
                    handleMessage(ia32, currentThread, currentGIL)
                } else {
                    // not my business, just wait next turn
                    wait(ia32, OFFSET_GIL, currentGIL)
                }


                log('trying to get lock again')
                const result = acquireGIL(ia32, OFFSET_GIL, currentThread)
                success = result.success
                currentGIL = result.current
                if (success) {
                    log('unstuck' )
                } else {
                    log('failed unstuck' )
                    explainGIL(currentGIL)
                }
            }

            log('gain lock')

            // log('start to send request at #' + current)
            const result = actualSend()

            threadState = THREAD_STATE_NORMAL

            log('release')
            releaseGIL(ia32)
            log('released, current GIL(cp) ' + Atomics.compareExchange(ia32, OFFSET_GIL, 0, 0))
            log('released, current GIL(lo) ' + Atomics.load(ia32, OFFSET_GIL))

            return result
        } else {
            // sync mode, in middle of handling a message sync ...etc
            // just send it directly and hard wait
            return actualSend()
        }
    }

    startAsyncPolling(ia32, current)

    return {
        current,
        send (/** @type {number} */targetThread, /** @type {any} */message) {
            return send(ia32, current, targetThread, message)
        }
    } 
}
/**
 * 
 * @param {number} from 
 * @param {any} message 
 */
function handler(from, message) {
    // TODO
}