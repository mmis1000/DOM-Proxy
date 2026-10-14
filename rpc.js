// @ts-check

class RpcTimeoutError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.name = 'RpcTimeoutError'
    }
}

class RpcThreadDeadError extends Error {
    /** @param {number} thread */
    constructor(thread) {
        super('thread #' + thread + ' is dead')
        this.name = 'RpcThreadDeadError'
        this.thread = thread
    }
}

/** Thrown in a call whose caller already gave up on it (timeout or dead thread further up) */
class RpcAbortedError extends Error {
    constructor() {
        super('the call was abandoned by its caller')
        this.name = 'RpcAbortedError'
    }
}

/**
 * @typedef {object} ListenOptions
 * @property {number} [timeout]
 *   ms a call may take (including the wait for the lock) before it fails with RpcTimeoutError, default Infinity
 * @property {number} [deadAfter]
 *   ms without a heartbeat before a thread counts as dead, default 2000
 * @property {number} [heartbeatInterval]
 *   ms between heartbeats, default 100
 * @property {false | ((ia32: Int32Array, index: number, interval: number) => void)} [startHeartbeat]
 *   starts something that keeps incrementing `ia32[index]` for as long as this thread lives, even while it is busy.
 *   The default spawns a nested worker, which the browser terminates together with this thread. false turns it off.
 */

/**
 * The default heartbeat: a nested worker that dies together with the thread that created it.
 * It sleeps with Atomics.wait instead of timers, so it is not throttled.
 * @param {Int32Array} ia32
 * @param {number} index
 * @param {number} interval
 */
function startWorkerHeartbeat(ia32, index, interval) {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return
    }

    const code = `
        onmessage = (event) => {
            const [ia32, index, interval] = event.data
            while (true) {
                Atomics.add(ia32, index, 1)
                Atomics.wait(ia32, index, Atomics.load(ia32, index), interval)
            }
        }
    `
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    const worker = new Worker(url)
    // without a heartbeat the thread counts as alive forever
    worker.onerror = () => Atomics.store(ia32, index, 0)
    worker.postMessage([ia32, index, interval])
    startWorkerHeartbeat.workers.push(worker)
}
/** keep the heartbeat workers referenced */
startWorkerHeartbeat.workers = /** @type {Worker[]} */ ([])

/**
 *
 * @param {(from: number, message: any)=>any} handler
 * @param {Int32Array} ia32
 * @param {ListenOptions} [options]
 */
function listen(handler, ia32, options = {}) {
    const {
        timeout = Infinity,
        deadAfter = 2000,
        heartbeatInterval = 100,
        startHeartbeat = startWorkerHeartbeat,
    } = options

    /**
     *
     * @param {*} msg
     * @param  {...any} arg
     */
    function log (msg, ...arg) {
        console.debug('[#' + Atomics.add(ia32, OFFSET_LOG_ID, 1) + ']: #' + current + ' ' + msg, ...arg)
    }

    /**
     * GIL layout
     * ```
     * bits   0-2   | 3-10 | 11-18 | 19-31
     * field  state | from | to    | epoch
     * ```
     * The epoch changes whenever a caller abandons a call, so a thread that was given up on
     * can never write again: all writes are compare-and-swap from the GIL value at which the
     * writer got its turn.
     */
    const STATE_IDLE = 0
    const STATE_PREPARE = 1   // `from` owns the turn and has nothing in flight
    const STATE_WRITING = 2   // `from` is writing the buffer
    const STATE_SEND = 3      // request from `from` to `to`
    const STATE_RESPONSE = 4  // response from `from` to `to`

    const EPOCH_MASK = 0x1fff

    /**
     * @param {number} state
     * @param {number} from
     * @param {number} to
     * @param {number} epoch
     */
    function makeGIL(state, from, to, epoch) {
        return state | from << 3 | to << 11 | (epoch & EPOCH_MASK) << 19
    }
    /** @param {number} GIL */
    const stateOf = (GIL) => GIL & 0x7
    /** @param {number} GIL */
    const fromOf = (GIL) => (GIL >>> 3) & 0xff
    /** @param {number} GIL */
    const toOf = (GIL) => (GIL >>> 11) & 0xff
    /** @param {number} GIL */
    const epochOf = (GIL) => (GIL >>> 19) & EPOCH_MASK

    /**
     * the thread that has to act next
     * @param {number} GIL
     */
    function turnOwner(GIL) {
        switch (stateOf(GIL)) {
            case STATE_PREPARE:
            case STATE_WRITING:
                return fromOf(GIL)
            case STATE_SEND:
            case STATE_RESPONSE:
                return toOf(GIL)
        }
        return 0
    }

    /**
     *
     * @param {number} GIL
     */
    function explainGIL(GIL) {
        return `0x${(GIL >>> 0).toString(16)} (state: ${stateOf(GIL)}, from: ${fromOf(GIL)}, to: ${toOf(GIL)}, epoch: ${epochOf(GIL)})`
    }

    const MAX_THREAD_ID = 0xff
    const MAX_DEPTH = 256

    /**
     * memory layout (Int32Array indexes)
     * ```
     * name        Log id | Thread index | GIL | Buffer size | Depth | Frame | Frame counter | Stack top | Heartbeats | Stack frames | Stack threads | Data
     * size        1      | 1            | 1   | 1           | 1     | 1     | 1             | 1         | 256        | 256          | 256           | rest
     * ```
     * The stack holds the frames of the call chain that owns the GIL, frame 0 being the thread that acquired it.
     * Depth and Frame describe the frame a SEND creates on the receiving side.
     */
    const OFFSET_LOG_ID = 0
    const OFFSET_THREAD_INDEX = 1
    const OFFSET_GIL = 2
    const OFFSET_BUFFER_SIZE = 3
    const OFFSET_DEPTH = 4
    const OFFSET_FRAME = 5
    const OFFSET_FRAME_COUNTER = 6
    const OFFSET_STACK_TOP = 7
    const OFFSET_HEARTBEAT = 8
    const OFFSET_STACK_FRAME = OFFSET_HEARTBEAT + MAX_THREAD_ID + 1
    const OFFSET_STACK_THREAD = OFFSET_STACK_FRAME + MAX_DEPTH
    const OFFSET_DATA = OFFSET_STACK_THREAD + MAX_DEPTH

    const capacity = ia32.byteLength - OFFSET_DATA * 4

    if (capacity <= 0) {
        throw new RangeError('the shared buffer is too small, it needs more than ' + OFFSET_DATA * 4 + ' bytes')
    }

    // Thread ids start at 1, so a zero `to` field never addresses a real thread
    const current = Atomics.add(ia32, OFFSET_THREAD_INDEX, 1) + 1

    if (current > MAX_THREAD_ID) {
        throw new Error('too many threads, at most ' + MAX_THREAD_ID + ' are supported')
    }

    // how often blocked threads wake up to check for timeouts and dead threads
    const POLL_INTERVAL = 50
    const SPIN_LOOP_LIMIT = 100

    /**
     * Wait sync, falls back to spinning where Atomics.wait is not allowed (the main thread)
     * @param {number} offset
     * @param {number} old
     * @param {number} timeout
     */
    function wait(offset, old, timeout) {
        const start = performance.now()

        try {
            Atomics.wait(ia32, offset, old, timeout)
            return
        } catch (err) { }

        while (Atomics.load(ia32, offset) === old) {
            if (performance.now() - start >= Math.min(SPIN_LOOP_LIMIT, timeout)) {
                return
            }
        }
    }

    /**
     * Wait async
     * @param {number} offset
     * @param {number} old
     * @returns {Promise<string>}
     */
    function waitAsync(offset, old) {
        // @ts-ignore
        const res = Atomics.waitAsync(ia32, offset, old)

        // the polyfill returns a promise, the native one returns { async, value }
        if (typeof res.then === 'function') {
            return res
        }

        return res.async ? res.value : Promise.resolve(res.value)
    }

    /**
     * last heartbeat seen per thread
     * @type {Map<number, {beat: number, at: number}>}
     */
    const heartbeats = new Map()

    /**
     * whether a thread is alive, as far as its heartbeat tells.
     * A thread without a heartbeat (0) always counts as alive.
     * @param {number} thread
     */
    function isAlive(thread) {
        if (thread === current) return true

        const beat = Atomics.load(ia32, OFFSET_HEARTBEAT + thread)
        if (beat === 0) return true

        const now = performance.now()
        const last = heartbeats.get(thread)

        if (!last || last.beat !== beat) {
            heartbeats.set(thread, { beat, at: now })
            return true
        }

        return now - last.at < deadAfter
    }

    /**
     * @typedef {object} Frame
     * @property {number} depth position in the call chain
     * @property {number} id unique id, the frame is abandoned once the stack holds another id at its depth
     * @property {number} turn the GIL value at which this frame got its turn, all its writes start from it
     */

    /**
     * the frame this thread is currently running, null when it is not part of a call chain
     * @type {Frame | null}
     */
    let currentFrame = null

    /** @param {Frame} frame */
    function isValid(frame) {
        return Atomics.load(ia32, OFFSET_STACK_FRAME + frame.depth) === frame.id
    }

    function newFrameId() {
        let id = 0
        // 0 marks an empty stack slot
        while (id === 0) {
            id = (Atomics.add(ia32, OFFSET_FRAME_COUNTER, 1) + 1) | 0
        }
        return id
    }

    /**
     * claim the turn for writing, fails if someone took it from us
     * @param {number} turn
     */
    function claim(turn) {
        const writing = makeGIL(STATE_WRITING, current, 0, epochOf(turn))
        return Atomics.compareExchange(ia32, OFFSET_GIL, turn, writing) === turn
    }

    /** @param {number} GIL */
    function publish(GIL) {
        Atomics.store(ia32, OFFSET_GIL, GIL)
        Atomics.notify(ia32, OFFSET_GIL)
    }

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    /**
     * serialize before touching any shared state, so failures leave it untouched
     * @param {any} value
     */
    function encode(value) {
        const bytes = encoder.encode(JSON.stringify(value))

        if (bytes.byteLength > capacity) {
            throw new RangeError('message too large: ' + bytes.byteLength + ' bytes, buffer holds ' + capacity)
        }

        return bytes
    }

    /** @param {Uint8Array} bytes */
    function writeBytes(bytes) {
        new Uint8Array(ia32.buffer, ia32.byteOffset + OFFSET_DATA * 4, bytes.byteLength).set(bytes)
        Atomics.store(ia32, OFFSET_BUFFER_SIZE, bytes.byteLength)
    }

    function readBytes() {
        const size = Atomics.load(ia32, OFFSET_BUFFER_SIZE)
        // copy, the buffer gets reused as soon as we give the turn away
        return new Uint8Array(new Uint8Array(ia32.buffer, ia32.byteOffset + OFFSET_DATA * 4, size))
    }

    /** @param {Uint8Array} bytes */
    function decode(bytes) {
        return JSON.parse(decoder.decode(bytes))
    }

    /**
     * @param {any} err
     * @returns {{error: string, name: string}}
     */
    function toErrorResponse(err) {
        return {
            error: String(err && err.message || err),
            name: String(err && err.name || 'Error')
        }
    }

    /**
     * Poll requests while the thread is idle.
     * Requests that arrive while the thread is blocked in `send` are handled there instead.
     */
    async function pollRequests() {
        while (true) {
            const GIL = Atomics.load(ia32, OFFSET_GIL)

            if (stateOf(GIL) === STATE_SEND && toOf(GIL) === current) {
                try {
                    handleRequest(GIL)
                } catch (err) {
                    console.error(err)
                }
                continue
            }

            // wait on the value we saw rather than on idle,
            // so a busy GIL doesn't turn this into a hot loop
            try {
                await waitAsync(OFFSET_GIL, GIL)
            } catch (err) {
                console.error(err)
                await new Promise(resolve => setTimeout(resolve, SPIN_LOOP_LIMIT))
            }
        }
    }

    /**
     * handle a request sent to us, always tries to write a response back
     * @param {number} GIL a SEND to this thread
     */
    function handleRequest(GIL) {
        const from = fromOf(GIL)
        const depth = Atomics.load(ia32, OFFSET_DEPTH)
        const id = Atomics.load(ia32, OFFSET_FRAME)
        const bytes = readBytes()

        if (Atomics.load(ia32, OFFSET_GIL) !== GIL) {
            // the caller gave up before we picked the request up, what we read may be garbage
            return
        }

        /** @type {Frame} */
        const frame = { depth, id, turn: GIL }
        const outer = currentFrame
        currentFrame = frame

        /** @type {any} */
        let response

        try {
            response = { ok: handler(from, decode(bytes).message) }
        } catch (err) {
            response = toErrorResponse(err)
        } finally {
            currentFrame = outer
        }

        let responseBytes
        try {
            responseBytes = encode(response)
        } catch (err) {
            responseBytes = encode(toErrorResponse('failed to send response: ' + toErrorResponse(err).error))
        }

        if (!claim(frame.turn)) {
            // our caller gave up on this call, nobody is waiting for the response
            return
        }

        writeBytes(responseBytes)
        Atomics.store(ia32, OFFSET_STACK_TOP, frame.depth - 1)
        publish(makeGIL(STATE_RESPONSE, current, from, epochOf(frame.turn)))
    }

    /**
     * whether a thread deeper in the chain than `depth` is alive, it will deal with a dead thread below it
     * @param {number} depth
     */
    function aliveBelow(depth) {
        const top = Atomics.load(ia32, OFFSET_STACK_TOP)

        for (let d = depth + 1; d <= top; d++) {
            const thread = Atomics.load(ia32, OFFSET_STACK_THREAD + d)
            if (thread !== current && isAlive(thread)) return true
        }

        return false
    }

    /**
     * Give up on the call `frame` is waiting for: take the turn back, drop the frames below us, then throw.
     * Returns instead when something for us arrived in the meantime.
     * @param {Frame} frame
     * @param {Error} error
     */
    function abandon(frame, error) {
        while (true) {
            const GIL = Atomics.load(ia32, OFFSET_GIL)
            const state = stateOf(GIL)

            if (toOf(GIL) === current && (state === STATE_SEND || state === STATE_RESPONSE)) {
                return
            }

            if (!isValid(frame)) {
                throw new RpcAbortedError()
            }

            if (state === STATE_WRITING && isAlive(fromOf(GIL))) {
                // let the writer finish, it can't take long
                wait(OFFSET_GIL, GIL, POLL_INTERVAL)
                continue
            }

            const epoch = epochOf(GIL) + 1

            if (Atomics.compareExchange(ia32, OFFSET_GIL, GIL, makeGIL(STATE_WRITING, current, 0, epoch)) !== GIL) {
                continue
            }

            const top = Atomics.load(ia32, OFFSET_STACK_TOP)
            for (let d = frame.depth + 1; d <= top; d++) {
                Atomics.store(ia32, OFFSET_STACK_FRAME + d, 0)
            }
            Atomics.store(ia32, OFFSET_STACK_TOP, frame.depth)

            frame.turn = makeGIL(STATE_PREPARE, current, 0, epoch)
            publish(frame.turn)

            throw error
        }
    }

    /**
     * wait for the response of the call `frame` made, handling any request sent to us in the meantime
     * @param {Frame} frame
     * @param {number} target
     * @param {number} deadline
     */
    function waitForResponse(frame, target, deadline) {
        while (true) {
            const GIL = Atomics.load(ia32, OFFSET_GIL)
            const state = stateOf(GIL)

            if (toOf(GIL) === current && (state === STATE_SEND || state === STATE_RESPONSE)) {
                if (!isValid(frame)) {
                    throw new RpcAbortedError()
                }

                if (state === STATE_RESPONSE && fromOf(GIL) === target) {
                    frame.turn = GIL
                    return
                }

                if (state === STATE_SEND) {
                    // we got a side quest
                    handleRequest(GIL)
                    continue
                }

                throw new Error('unexpected GIL state while waiting for #' + target + ': ' + explainGIL(GIL))
            }

            if (!isValid(frame)) {
                throw new RpcAbortedError()
            }

            if (performance.now() >= deadline) {
                abandon(frame, new RpcTimeoutError('call to thread #' + target + ' timed out'))
                continue
            }

            const owner = turnOwner(GIL)
            if (owner !== 0 && !isAlive(owner) && !aliveBelow(frame.depth)) {
                abandon(frame, new RpcThreadDeadError(owner))
                continue
            }

            wait(OFFSET_GIL, GIL, POLL_INTERVAL)
        }
    }

    /**
     * make a call from `frame`, which must hold the turn
     * @param {Frame} frame
     * @param {number} target
     * @param {Uint8Array} bytes
     * @param {number} deadline
     */
    function call(frame, target, bytes, deadline) {
        const depth = frame.depth + 1

        if (depth >= MAX_DEPTH) {
            throw new RangeError('call chain too deep, at most ' + MAX_DEPTH + ' nested calls are supported')
        }

        if (!claim(frame.turn)) {
            throw new RpcAbortedError()
        }

        const id = newFrameId()
        writeBytes(bytes)
        Atomics.store(ia32, OFFSET_DEPTH, depth)
        Atomics.store(ia32, OFFSET_FRAME, id)
        Atomics.store(ia32, OFFSET_STACK_FRAME + depth, id)
        Atomics.store(ia32, OFFSET_STACK_THREAD + depth, target)
        Atomics.store(ia32, OFFSET_STACK_TOP, depth)
        publish(makeGIL(STATE_SEND, current, target, epochOf(frame.turn)))

        waitForResponse(frame, target, deadline)

        const response = decode(readBytes())

        if (response.error !== undefined) {
            const err = new Error(response.error)
            err.name = response.name
            throw err
        }

        return response.ok
    }

    /**
     * reset a GIL whose whole call chain is dead
     * @param {number} GIL
     */
    function recoverDeadChain(GIL) {
        const owner = turnOwner(GIL)
        if (owner === 0 || isAlive(owner)) return

        const top = Atomics.load(ia32, OFFSET_STACK_TOP)
        for (let d = 0; d <= top; d++) {
            if (isAlive(Atomics.load(ia32, OFFSET_STACK_THREAD + d))) return
        }

        const epoch = epochOf(GIL) + 1

        if (Atomics.compareExchange(ia32, OFFSET_GIL, GIL, makeGIL(STATE_WRITING, current, 0, epoch)) !== GIL) {
            return
        }

        for (let d = 0; d <= top; d++) {
            Atomics.store(ia32, OFFSET_STACK_FRAME + d, 0)
        }

        publish(makeGIL(STATE_IDLE, 0, 0, epoch))
    }

    /**
     * acquire the GIL and start a call chain
     * @param {number} deadline
     * @returns {Frame}
     */
    function acquire(deadline) {
        while (true) {
            const GIL = Atomics.load(ia32, OFFSET_GIL)
            const state = stateOf(GIL)

            if (state === STATE_IDLE) {
                const turn = makeGIL(STATE_PREPARE, current, 0, epochOf(GIL))

                if (Atomics.compareExchange(ia32, OFFSET_GIL, GIL, turn) === GIL) {
                    const id = newFrameId()
                    Atomics.store(ia32, OFFSET_STACK_FRAME, id)
                    Atomics.store(ia32, OFFSET_STACK_THREAD, current)
                    Atomics.store(ia32, OFFSET_STACK_TOP, 0)
                    return { depth: 0, id, turn }
                }

                continue
            }

            if (state === STATE_SEND && toOf(GIL) === current) {
                // This will block until all triggered rpc exited, includes those trigger in the middle
                handleRequest(GIL)
                continue
            }

            if (performance.now() >= deadline) {
                throw new RpcTimeoutError('timed out waiting for other calls to finish')
            }

            recoverDeadChain(GIL)
            wait(OFFSET_GIL, GIL, POLL_INTERVAL)
        }
    }

    /**
     * @param {number} target
     * @param {any} message
     */
    function send(target, message) {
        if (target === current) {
            console.trace('you can\'t send to yourself!!!')
            throw new Error('err')
        }

        if (!isAlive(target)) {
            throw new RpcThreadDeadError(target)
        }

        // may throw (unserializable / too large), nothing is touched yet if it does
        const bytes = encode({ message })
        const deadline = performance.now() + timeout

        if (currentFrame !== null) {
            // in the middle of handling a request, the GIL belongs to the call chain we are part of
            return call(currentFrame, target, bytes, deadline)
        }

        const frame = acquire(deadline)
        currentFrame = frame

        try {
            return call(frame, target, bytes, deadline)
        } finally {
            currentFrame = null

            // fails only if someone reset the GIL because they thought we were dead
            const idle = makeGIL(STATE_IDLE, 0, 0, epochOf(frame.turn))
            if (Atomics.compareExchange(ia32, OFFSET_GIL, frame.turn, idle) === frame.turn) {
                Atomics.notify(ia32, OFFSET_GIL)
            }
        }
    }

    if (startHeartbeat) {
        // the slot stays 0 (alive, as far as anyone can tell) until the first beat:
        // a nested worker may not start before this thread is idle for a moment
        startHeartbeat(ia32, OFFSET_HEARTBEAT + current, heartbeatInterval)
    }

    pollRequests()

    return {
        current,
        send (/** @type {number} */targetThread, /** @type {any} */message) {
            // I really don't know why, but leave this here makes chrome happy
            console.debug(message)
            return send(targetThread, message)
        }
    }
}
