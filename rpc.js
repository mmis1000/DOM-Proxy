// @ts-check
const counter = (()=>{
    let i = 0;
    return () => i++
})()

const MASK_STATE = counter()
const MASK_FROM = counter()
const MASK_TO = counter()
const MASK_STACK_OFFSET = counter()

const MASK = {
    [MASK_STATE]:        0x000000ff,
    [MASK_FROM]:         0x0000ff00,
    [MASK_TO]:           0x00ff0000,
    [MASK_STACK_OFFSET]: 0xff000000
}
const MASK_OFFSET = {
    [MASK_STATE]:        0,
    [MASK_FROM]:         8,
    [MASK_TO]:           16,
    [MASK_STACK_OFFSET]: 24
}


class AbortError extends Error {}

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
        cancel () {
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
function wait(ia32, offset, old, timeout = 0) {
    const start = performance.now()

    try {
        return Atomics.wait(ia32, offset, old, timeout)
    } catch (err) { }

    while (Atomics.load(ia32, offset) === old) {
        if (performance.now() - start >= timeout) {
            return 'timed-out'
        }
    }

    //console.log('not-equal')
    return 'not-equal'
}

/**
 * Wait async
 * @param {Int32Array} ia32
 * @param {number} offset
 * @param {number} old
 * @param {number} timeout
 * @returns {Promise<AtomicReturnValue>}
 */
function waitAsync(ia32, offset, old, timeout = 0) {
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

const SIZE_THREAD_INDEX = 4
const SIZE_GIL = 4
const SIZE_THREAD_LOCK = 4 * 256
const SIZE_BUFFER_SIZE = 4

const OFFSET_THREAD_INDEX = 0
const OFFSET_GIL =         OFFSET_THREAD_INDEX + SIZE_THREAD_INDEX
const OFFSET_THREAD_LOCK = OFFSET_GIL          + SIZE_GIL 
const OFFSET_BUFFER_SIZE = OFFSET_THREAD_LOCK  + SIZE_THREAD_LOCK
const OFFSET_DATA =        OFFSET_BUFFER_SIZE  + SIZE_BUFFER_SIZE

const STATE_PREPARE = 0
const STATE_SEND = 1
const STATE_RESPONSE = 2

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
 * mark the GIL to ready state
 * @param {Int32Array} typedArray 
 * @param {number} index
 */
function markReady(typedArray, index) {
    Atomics.or(typedArray, index, STATE_SEND << MASK_OFFSET[MASK_STATE])
    Atomics.notify(typedArray, index, Infinity)
}

/**
 * release the GIL
 * @param {Int32Array} typedArray 
 * @param {number} index
 */
function releaseGIL(typedArray, index) {
    Atomics.store(typedArray, index, 0)
    Atomics.notify(typedArray, index, Infinity)
}

let pollSwitch = 0

/**
 * stop async the poll loop
 */
function stopAsyncPolling() {
    pollSwitch++
    // TODO:
}

/**
 * start async poll loop
 * @param {Int32Array} ia32 
 * @param {number} currentThread 
 */
function startAsyncPolling(ia32, currentThread) {
    pollSwitch--
    if (pollSwitch !== 0) {
        return ()=>{}
    }

    let cancelCurrent = () => {}

    async function loop () {
        while (true) {
            try {
                let { promise, cancel } = pollRequestAsync(ia32, currentThread)
                cancelCurrent = cancel
                await promise

                handleMessage(ia32, currentThread)
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

    return cancelCurrent
}

/**
 * handle request
 * @param {Int32Array} ia32 
 * @param {number} current 
 */
function handleMessage(ia32, current) {
    // TODO:
}

/**
 * poll the request once using own channel
 * @param {Int32Array} ia32 
 * @param {number} currentThread 
 */
function pollRequestAsync(ia32, currentThread) {
    const IDLE = 0

    return cancelable(async function () {
        await waitAsync(ia32, OFFSET_THREAD_LOCK + currentThread, IDLE)
        Atomics.sub(ia32, OFFSET_THREAD_LOCK + currentThread, 1)
    } ())
}

/**
 * poll the response back
 * @param {Int32Array} ia32 
 * @param {number} GIL 
 * @param {number} currentThread
 */
function pollResponse(ia32, GIL, currentThread) {
    while (true) {
        /**
         * @type {number}
         */
        let to;
    
        do {
            wait(ia32, OFFSET_GIL, GIL)
            GIL = Atomics.load(ia32, OFFSET_GIL)
    
            to = field(GIL, MASK_TO)
        } while (to !== currentThread)

        if (field(GIL, MASK_STATE) === STATE_RESPONSE) {
            return getMessage(ia32)
        } else if (field(GIL, MASK_STATE) === STATE_SEND) {
            // we got a side quest
            stopAsyncPolling()
            handleMessage(ia32, currentThread)
            startAsyncPolling(ia32, currentThread)
        } else {
            // we fuck up, really hard
            debugger;
        }
    }
}

/**
 * access bit field
 * @param {number} GIL 
 * @param {number} field 
 */
function field (GIL, field) {
    return (GIL & MASK[field]) >> MASK_OFFSET[field]
}

/**
 * 
 * @param {Int32Array} int32 
 * @param {any} message 
 */
function setMessage(int32, message) {}

/**
 * 
 * @param {Int32Array} int32  
 * @returns {any}
 */
function getMessage(int32) {}

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
        let GIL = 
            currentThread << MASK_OFFSET[MASK_FROM] |
            targetThread << MASK_OFFSET[MASK_TO] |
            STATE_SEND << MASK_OFFSET[MASK_STATE]
        
        setMessage(ia32, message)

        // send the message via GIL if the target is in block mode
        Atomics.store(ia32, OFFSET_GIL, GIL)
        Atomics.notify(ia32, OFFSET_GIL, Infinity)

        // opt the target worker into block mode
        Atomics.add(ia32, OFFSET_THREAD_LOCK + targetThread, 1)
        Atomics.notify(ia32, OFFSET_THREAD_LOCK + targetThread, Infinity)

        return pollResponse(ia32, GIL, currentThread)
    }

    if (threadState === THREAD_STATE_NORMAL) {
        // async mode

        // try acquire GIL
        let { success, current: currentGIL } = acquireGIL(ia32, OFFSET_GIL, currentThread)
        threadState = THREAD_STATE_BLOCKING

        while (!success) {
            // handle the state
            if (field (currentGIL, MASK_TO) === currentThread) {
                // This will block until all triggered rpc exited, includes those trigger in the middle
                handleMessage(ia32, currentThread)
            } else {
                // not my business, just wait next turn
                wait(ia32, OFFSET_GIL, currentGIL)
            }


            const result = acquireGIL(ia32, OFFSET_GIL, currentThread)
            success = result.success
            currentGIL = result.current
        }

        const result = actualSend()

        threadState = THREAD_STATE_NORMAL
        releaseGIL(ia32, OFFSET_GIL)

        return result
    } else {
        // sync mode, in middle of handling a message sync ...etc
        // just send it directly and hard wait
        return actualSend()
    }

}