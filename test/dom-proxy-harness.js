// Runs one dom-proxy.js scenario with real threads, see harness.js for the setup.
// Needs --expose-gc for the garbage collection scenario.
'use strict'

const { Worker, isMainThread, workerData, parentPort } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

delete globalThis.setImmediate
delete globalThis.clearImmediate
console.debug = () => { }

for (const file of ['rpc.js', 'dom-proxy.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { filename: file })
}
const DomProxy = /** @type {any} */ (globalThis).DomProxy

/** @param {number} ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function collectGarbage() {
    for (let i = 0; i < 5; i++) {
        /** @type {any} */ (globalThis).gc()
        // let finalization callbacks and the batched unref run
        await sleep(20)
    }
}

/**
 * @param {any} actual
 * @param {any} expected
 * @param {string} what
 */
function eq(actual, expected, what) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

if (!isMainThread) {
    const workerRoot = {}
    const proxy = DomProxy.create(workerData.ia32, () => workerRoot)
    const page = proxy.getRemote(workerData.page)

    /** @type {Record<string, () => any>} */
    const steps = {
        'read and write'() {
            eq(page.title, 'page', 'property')
            eq(page.nested.n, 1, 'nested property')
            eq(page.add(2, 3), 5, 'call')
            eq(page.nested === page.nested, true, 'same proxy for same object')
            page.written = 42
            page.fromWorker = { k: 'v' }
            page.double = (/** @type {number} */ x) => x * 2
        },
        'fetch and drop'() {
            let sum = 0
            for (let i = 0; i < 20; i++) sum += page.make().a
            return sum
        },
        collect: collectGarbage,
        'fetch again'() {
            eq(page.make().a, 1, 'new object after collection')
            eq(page.nested.n, 1, 'still works')
        },
    }

    parentPort?.on('message', async (name) => {
        try {
            parentPort?.postMessage({ value: await steps[name]() })
        } catch (err) {
            parentPort?.postMessage({ error: String(/** @type {any} */ (err).stack || err) })
        }
    })
    parentPort?.postMessage({ ready: proxy.current })
} else {
    Atomics.wait = () => { throw new TypeError('Atomics.wait cannot be called in this context') }

    const ia32 = new Int32Array(new SharedArrayBuffer(1024 * 1024))
    /** @type {WeakRef<any>[]} */
    const made = []
    /** @type {any} */
    const pageRoot = {
        title: 'page',
        nested: { n: 1 },
        add: (/** @type {number} */ a, /** @type {number} */ b) => a + b,
        make() {
            const obj = { a: 1 }
            made.push(new WeakRef(obj))
            return obj
        },
    }
    const proxy = DomProxy.create(ia32, () => pageRoot)

    function spawn() {
        return new Promise((resolve, reject) => {
            const worker = new Worker(__filename, { workerData: { ia32, page: proxy.current } })
            worker.once('error', reject)
            worker.once('message', () => {
                const pending = /** @type {((v: any) => void)[]} */ ([])
                worker.on('message', (reply) => pending.shift()?.(reply))
                resolve({
                    /** @param {string} name */
                    async run(name) {
                        const res = await new Promise((r) => {
                            pending.push(r)
                            worker.postMessage(name)
                        })
                        if (res.error) throw new Error('worker step "' + name + '" failed: ' + res.error)
                        return res.value
                    }
                })
            })
        })
    }

    /** @type {Record<string, () => Promise<void>>} */
    const scenarios = {
        async 'worker uses page objects and page calls back into the worker'() {
            const w = await spawn()
            await w.run('read and write')
            eq(pageRoot.written, 42, 'written by worker')
            eq(pageRoot.fromWorker.k, 'v', 'worker object read by page')
            eq(pageRoot.double(21), 42, 'worker function called by page')
        },

        async 'collected proxies release the page objects'() {
            const w = await spawn()
            eq(await w.run('fetch and drop'), 20, 'fetched')
            eq(made.length, 20, 'objects made')
            await w.run('collect')
            await collectGarbage()
            eq(made.filter(ref => ref.deref() !== undefined).length, 0, 'page objects still alive')
            await w.run('fetch again')
        },
    }

    const name = process.argv[2]
    if (!name) {
        console.log(JSON.stringify(Object.keys(scenarios)))
        process.exit(0)
    }
    scenarios[name]().then(() => {
        console.log('ok')
        process.exit(0)
    }, (err) => {
        console.error(err && err.stack || err)
        process.exit(1)
    })
}
