// Runs one rpc.js scenario with real threads. Spawned by rpc.test.js in its own
// process so a deadlock shows up as a timeout instead of hanging the runner.
//
// The main thread plays the browser page: Atomics.wait is disabled there, the
// same as in a real window. Workers play web workers.
'use strict'

const { Worker, isMainThread, workerData, parentPort } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// Behave like a browser: no setImmediate, quiet debug logging.
delete globalThis.setImmediate
delete globalThis.clearImmediate
console.debug = () => { }

// Track the waitAsync calls that are still pending, to detect leaked poll loops.
let liveWaiters = 0
const nativeWaitAsync = Atomics.waitAsync
Atomics.waitAsync = function (...args) {
    const res = nativeWaitAsync.apply(Atomics, args)
    if (process.env.RPC_TEST_POLYFILL_SHAPE) {
        // await-async.js returns a bare promise instead of { async, value }
        if (!res.async) return Promise.resolve(res.value)
        liveWaiters++
        return res.value.finally(() => { liveWaiters-- })
    }
    if (!res.async) return { async: false, value: res.value }
    liveWaiters++
    return { async: true, value: res.value.finally(() => { liveWaiters-- }) }
}

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'rpc.js'), 'utf8'), { filename: 'rpc.js' })
const listen = /** @type {any} */ (globalThis).listen

// Node has no web Worker, so start the heartbeat in a nested worker_threads worker,
// which like a nested web worker dies together with the thread that started it.
const heartbeatCode = `
    const { workerData: [ia32, index, interval] } = require('worker_threads')
    while (true) {
        Atomics.add(ia32, index, 1)
        Atomics.wait(ia32, index, Atomics.load(ia32, index), interval)
    }
`
const listenOptions = {
    deadAfter: 400,
    heartbeatInterval: 25,
    startHeartbeat(/** @type {Int32Array} */ ia32, /** @type {number} */ index, /** @type {number} */ interval) {
        new Worker(heartbeatCode, { eval: true, workerData: [ia32, index, interval] }).unref()
    },
}

/**
 * @param {number} ms
 */
function busy(ms) {
    const end = Date.now() + ms
    while (Date.now() < end) { }
}

/**
 * The same request handler on every thread.
 * @param {() => any} getRpc
 */
function makeHandler(getRpc) {
    return (/** @type {number} */ from, /** @type {any} */ msg) => {
        switch (msg.op) {
            case 'echo': return msg.arg
            case 'undefined': return undefined
            case 'throw': throw new Error('boom')
            case 'call': return getRpc().send(msg.target, msg.msg)
            case 'busy': busy(msg.arg); return 'done'
            case 'from': return from
            case 'big': return 'x'.repeat(msg.arg)
            // die in the middle of handling a call
            case 'exit': process.exit(0)
        }
        throw new Error('unknown op ' + msg.op)
    }
}

/**
 * @param {() => any} fn
 */
function capture(fn) {
    const start = performance.now()
    try {
        return { value: fn() }
    } catch (err) {
        const e = /** @type {any} */ (err)
        return { error: String(e && e.message || e), name: e && e.name, elapsed: performance.now() - start }
    }
}

if (!isMainThread) {
    /** @type {any} */
    let rpc
    rpc = listen(makeHandler(() => rpc), workerData.ia32, { ...listenOptions, timeout: workerData.timeout })
    /** @type {any} */
    let ticker
    let ticks = 0

    parentPort?.on('message', (cmd) => {
        switch (cmd.type) {
            case 'send':
                parentPort?.postMessage(capture(() => rpc.send(cmd.target, cmd.msg)))
                break
            case 'start-ticks':
                ticks = 0
                ticker = setInterval(() => ticks++, 5)
                parentPort?.postMessage({ value: true })
                break
            case 'stop-ticks':
                clearInterval(ticker)
                parentPort?.postMessage({ value: ticks })
                break
            case 'live-waiters':
                setTimeout(() => parentPort?.postMessage({ value: liveWaiters }), 50)
                break
        }
    })
    // heartbeat slot of this thread, see the memory layout in rpc.js
    const heartbeat = 8 + rpc.current
    const waitForHeartbeat = () => Atomics.load(workerData.ia32, heartbeat) !== 0
        ? parentPort?.postMessage({ ready: rpc.current })
        : setTimeout(waitForHeartbeat, 5)
    waitForHeartbeat()
} else {
    Atomics.wait = () => { throw new TypeError('Atomics.wait cannot be called in this context') }

    const ia32 = new Int32Array(new SharedArrayBuffer(64 * 1024))
    /** @type {any} */
    let rpc
    rpc = listen(makeHandler(() => rpc), ia32, listenOptions)

    /** @type {Worker[]} */
    const workers = []

    /**
     * @param {{ timeout?: number }} [options]
     * @returns {Promise<any>}
     */
    function spawn({ timeout = Infinity } = {}) {
        return new Promise((resolve, reject) => {
            const worker = new Worker(__filename, { workerData: { ia32, timeout } })
            workers.push(worker)
            worker.once('error', reject)
            worker.once('message', (m) => {
                const pending = /** @type {((v: any) => void)[]} */ ([])
                worker.on('message', (reply) => pending.shift()?.(reply))
                resolve({
                    id: m.ready,
                    worker,
                    /** @param {any} cmd */
                    run(cmd) {
                        return new Promise((res) => {
                            pending.push(res)
                            worker.postMessage(cmd)
                        })
                    }
                })
            })
        })
    }

    /** @param {number} ms */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))

    /**
     * @param {any} actual
     * @param {any} expected
     * @param {string} what
     */
    function eq(actual, expected, what) {
        const a = JSON.stringify(actual), e = JSON.stringify(expected)
        if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
    }

    /** @type {Record<string, () => Promise<void>>} */
    const scenarios = {
        async 'thread ids start at 1'() {
            const a = await spawn()
            const b = await spawn()
            eq([rpc.current, a.id, b.id], [1, 2, 3], 'ids')
        },

        async 'request and response in both directions'() {
            const a = await spawn()
            eq(await a.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 'hi' } }), { value: 'hi' }, 'worker -> page')
            eq(capture(() => rpc.send(a.id, { op: 'echo', arg: [1, 2] })), { value: [1, 2] }, 'page -> worker')
            eq(capture(() => rpc.send(a.id, { op: 'from' })), { value: rpc.current }, 'sender id')
        },

        async 'nested call with a callback into the waiting thread'() {
            const a = await spawn()
            const b = await spawn()
            // a -> page -> b -> page (page is blocked waiting on b at that point)
            const msg = { op: 'call', target: b.id, msg: { op: 'call', target: rpc.current, msg: { op: 'echo', arg: 'deep' } } }
            for (let i = 0; i < 5; i++) {
                eq(await a.run({ type: 'send', target: rpc.current, msg }), { value: 'deep' }, 'nested result ' + i)
            }
            await sleep(100)
            eq(liveWaiters, 1, 'page poll loops after callbacks')
            eq(await a.run({ type: 'live-waiters' }), { value: 1 }, 'worker a poll loops')
            eq(await b.run({ type: 'live-waiters' }), { value: 1 }, 'worker b poll loops')
        },

        async 'handler returning undefined'() {
            const a = await spawn()
            eq(await a.run({ type: 'send', target: rpc.current, msg: { op: 'undefined' } }), { value: undefined }, 'result')
        },

        async 'handler throwing does not deadlock'() {
            const a = await spawn()
            const b = await spawn()
            const res = await a.run({ type: 'send', target: rpc.current, msg: { op: 'throw' } })
            if (!/boom/.test(res.error)) throw new Error('expected boom error, got ' + JSON.stringify(res))
            eq(await b.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } }), { value: 1 }, 'other thread afterwards')
            eq(await a.run({ type: 'send', target: b.id, msg: { op: 'echo', arg: 2 } }), { value: 2 }, 'same thread afterwards')
        },

        async 'unserializable message does not deadlock'() {
            const a = await spawn()
            const b = await spawn()
            /** @type {any} */
            const circular = {}
            circular.self = circular
            const res = capture(() => rpc.send(a.id, { op: 'echo', arg: circular }))
            if (!res.error) throw new Error('expected an error')
            eq(await b.run({ type: 'send', target: a.id, msg: { op: 'echo', arg: 1 } }), { value: 1 }, 'other thread afterwards')
            eq(capture(() => rpc.send(a.id, { op: 'echo', arg: 2 })), { value: 2 }, 'same thread afterwards')
        },

        async 'oversized message and response do not deadlock'() {
            const a = await spawn()
            const b = await spawn()
            const big = 'x'.repeat(128 * 1024)
            const res = await a.run({ type: 'send', target: b.id, msg: { op: 'echo', arg: big } })
            if (!res.error) throw new Error('expected an error for oversized request')
            const res2 = await a.run({ type: 'send', target: b.id, msg: { op: 'call', target: rpc.current, msg: { op: 'echo', arg: big.slice(0, 40 * 1024) } } })
            eq(res2.error === undefined, true, 'nested 40KB echo works: ' + res2.error)
            const res3 = await a.run({ type: 'send', target: b.id, msg: { op: 'big', arg: 128 * 1024 } })
            if (!/too large/.test(res3.error)) throw new Error('expected an error for oversized response, got ' + JSON.stringify(res3).slice(0, 200))
            eq(await b.run({ type: 'send', target: a.id, msg: { op: 'echo', arg: 3 } }), { value: 3 }, 'afterwards')
        },

        async 'idle threads keep running while the lock is held'() {
            const a = await spawn()
            const b = await spawn()
            const c = await spawn()
            await c.run({ type: 'start-ticks' })
            // b holds the request for 300ms; c is not involved and should keep ticking.
            eq(await a.run({ type: 'send', target: b.id, msg: { op: 'busy', arg: 300 } }), { value: 'done' }, 'busy call')
            const { value: ticks } = await c.run({ type: 'stop-ticks' })
            if (ticks < 10) throw new Error('idle worker event loop starved, only ' + ticks + ' ticks')
        },

        async 'concurrent senders'() {
            const ws = [await spawn(), await spawn(), await spawn()]
            const jobs = []
            for (let round = 0; round < 20; round++) {
                ws.forEach((w, i) => {
                    const target = ws[(i + 1) % ws.length].id
                    jobs.push(w.run({ type: 'send', target, msg: { op: 'call', target: rpc.current, msg: { op: 'echo', arg: round * 10 + i } } })
                        .then((r) => eq(r, { value: round * 10 + i }, 'concurrent result')))
                })
            }
            await Promise.all(jobs)
        },

        async 'callee dies mid-call'() {
            const a = await spawn()
            const b = await spawn()
            const res = capture(() => rpc.send(b.id, { op: 'exit' }))
            expectError(res, 'RpcThreadDeadError')
            eq(await a.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } }), { value: 1 }, 'worker -> page afterwards')
            eq(capture(() => rpc.send(a.id, { op: 'echo', arg: 2 })), { value: 2 }, 'page -> worker afterwards')
            const again = capture(() => rpc.send(b.id, { op: 'echo', arg: 3 }))
            expectError(again, 'RpcThreadDeadError', 50)
        },

        async 'nested callee dies'() {
            const a = await spawn()
            const b = await spawn()
            const res = await a.run({ type: 'send', target: rpc.current, msg: { op: 'call', target: b.id, msg: { op: 'exit' } } })
            expectError(res, 'RpcThreadDeadError')
            eq(await a.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } }), { value: 1 }, 'afterwards')
        },

        async 'caller dies while holding the lock'() {
            const a = await spawn()
            const b = await spawn()
            const c = await spawn()
            // a holds the lock while b works, then dies before b responds
            a.run({ type: 'send', target: b.id, msg: { op: 'busy', arg: 600 } })
            await sleep(150)
            await a.worker.terminate()
            const res = await c.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } })
            eq(res, { value: 1 }, 'lock recovered')
        },

        async 'busy thread is not mistaken for dead'() {
            const a = await spawn()
            const b = await spawn()
            // three times the dead threshold
            eq(await a.run({ type: 'send', target: b.id, msg: { op: 'busy', arg: 1200 } }), { value: 'done' }, 'long call')
        },

        async 'timeout on a stuck callee'() {
            const a = await spawn({ timeout: 300 })
            const b = await spawn()
            const c = await spawn()
            const res = await a.run({ type: 'send', target: b.id, msg: { op: 'busy', arg: 1500 } })
            expectError(res, 'RpcTimeoutError', 800)
            // the lock is free again while b is still busy
            eq(await c.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } }), { value: 1 }, 'lock released')
            // b's late response was dropped, it does not answer the next call
            await sleep(1500)
            eq(await a.run({ type: 'send', target: b.id, msg: { op: 'echo', arg: 'fresh' } }), { value: 'fresh' }, 'b afterwards')
        },

        async 'timeout aborts the calls below it'() {
            const a = await spawn({ timeout: 300 })
            const b = await spawn()
            const c = await spawn()
            // a -> page -> b, b is too slow for a
            const res = await a.run({ type: 'send', target: rpc.current, msg: { op: 'call', target: b.id, msg: { op: 'busy', arg: 1000 } } })
            expectError(res, 'RpcTimeoutError', 800)
            eq(await c.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } }), { value: 1 }, 'page afterwards')
            await sleep(1000)
            eq(capture(() => rpc.send(b.id, { op: 'echo', arg: 2 })), { value: 2 }, 'b afterwards')
            eq(await a.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 3 } }), { value: 3 }, 'a afterwards')
        },

        async 'waiting for the lock times out'() {
            const a = await spawn({ timeout: 300 })
            const b = await spawn()
            const c = await spawn()
            const slow = c.run({ type: 'send', target: b.id, msg: { op: 'busy', arg: 1000 } })
            await sleep(100)
            const res = await a.run({ type: 'send', target: rpc.current, msg: { op: 'echo', arg: 1 } })
            expectError(res, 'RpcTimeoutError', 800)
            eq(await slow, { value: 'done' }, 'the lock holder is unaffected')
        },
    }

    /**
     * @param {any} res
     * @param {string} name
     * @param {number} [within] ms
     */
    function expectError(res, name, within = Infinity) {
        if (res.name !== name) throw new Error('expected ' + name + ', got ' + JSON.stringify(res))
        if (res.elapsed !== undefined && res.elapsed > within) throw new Error(`${name} took ${res.elapsed}ms, expected at most ${within}ms`)
    }

    const name = process.argv[2]
    if (!name) {
        console.log(JSON.stringify(Object.keys(scenarios)))
        process.exit(0)
    }
    const scenario = scenarios[name]
    if (!scenario) {
        console.error('unknown scenario ' + name)
        process.exit(2)
    }
    scenario().then(() => {
        console.log('ok')
        process.exit(0)
    }, (err) => {
        console.error(err && err.stack || err)
        process.exit(1)
    })
}
