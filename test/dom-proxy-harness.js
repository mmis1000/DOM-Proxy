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
        'symbols and syntax'() {
            const items = []
            for (const item of page.list) items.push(item)
            eq(items, [1, 2, 3], 'for of')
            eq([...page.list], [1, 2, 3], 'spread')
            eq(`${page.list}`, '1,2,3', 'template literal')
            eq(page.date - 0, 0, 'Symbol.toPrimitive with number hint')
            eq(Object.prototype.toString.call(page.tagged), '[object Tagged]', 'Symbol.toStringTag')
            eq(page.point instanceof page.Point, true, 'instanceof through Symbol.hasInstance')
            eq(page.tagged[Symbol.for('dom-proxy.test')], 'registered', 'registered symbol key')
            eq(Object.getOwnPropertySymbols(page.tagged).map(String), ['Symbol(dom-proxy.test)', 'Symbol(Symbol.toStringTag)'], 'symbol keys')

            const local = Symbol('local')
            eq(page.tagged[local], undefined, 'unique symbol get')
            eq(local in page.tagged, false, 'unique symbol in')
            expectThrow(() => { page.tagged[local] = 1 }, TypeError, 'unique symbol set')

            eq('list' in page, true, 'in, existing')
            eq('nope' in page, false, 'in, missing')
            eq(Object.hasOwn(page, 'nope'), false, 'hasOwn on a missing key')
            eq(Object.getOwnPropertyDescriptor(page, 'nope'), undefined, 'descriptor of a missing key')
            eq(delete page.temp, true, 'delete')
            Object.defineProperty(page, 'defined', { value: 5, writable: true, enumerable: true, configurable: true })
            eq(Object.keys(page.identity), [], 'Object.keys on a remote function')

            Object.keys(page.first)
            eq(Object.getOwnPropertyDescriptor(page.second, 'x')?.value, 2, 'descriptor of another object after Object.keys')
            const setterOnly = Object.getOwnPropertyDescriptor(page.withSetter, 'only')
            eq([typeof setterOnly?.get, typeof setterOnly?.set], ['undefined', 'function'], 'setter only accessor')
        },
        values() {
            const s = page.special
            eq([Number.isNaN(s.nan), Object.is(s.negZero, -0), s.inf === Infinity, s.negInf === -Infinity, s.big === 10n], [true, true, true, true, true], 'from the page')

            for (const value of [NaN, -0, Infinity, -Infinity, 10n, 2n ** 70n, undefined, null, '', 0]) {
                if (!Object.is(page.identity(value), value)) throw new Error('round trip changed ' + String(value))
            }
            eq(page.identity(Symbol.iterator) === Symbol.iterator, true, 'well-known symbol value')
            eq(page.identity(Symbol.for('k')) === Symbol.for('k'), true, 'registered symbol value')
            expectThrow(() => page.identity(Symbol('u')), TypeError, 'unique symbol value')

            page.got = { negZero: -0, nan: NaN, big: 3n }
        },
    }

    /**
     * @param {() => void} fn
     * @param {Function} type
     * @param {string} what
     */
    function expectThrow(fn, type, what) {
        try {
            fn()
        } catch (err) {
            if (err instanceof type) return
            throw new Error(what + ': expected ' + type.name + ', got ' + err)
        }
        throw new Error(what + ': expected ' + type.name + ', nothing thrown')
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
    class Point {
        constructor(/** @type {number} */ x) {
            this.x = x
        }
    }

    /** @type {any} */
    const pageRoot = {
        list: [1, 2, 3],
        date: new Date(0),
        Point,
        point: new Point(1),
        tagged: { [Symbol.for('dom-proxy.test')]: 'registered', [Symbol.toStringTag]: 'Tagged' },
        first: { x: 1 },
        second: { x: 2 },
        withSetter: Object.defineProperty({}, 'only', { set(v) { }, enumerable: true, configurable: true }),
        temp: 1,
        identity: (/** @type {any} */ x) => x,
        special: { nan: NaN, negZero: -0, inf: Infinity, negInf: -Infinity, big: 10n },
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

        async 'proxies support symbols and common syntax'() {
            const w = await spawn()
            await w.run('symbols and syntax')
            eq('temp' in pageRoot, false, 'deleted by the worker')
            eq(Object.getOwnPropertyDescriptor(pageRoot, 'defined'), { value: 5, writable: true, enumerable: true, configurable: true }, 'defined by the worker')
        },

        async 'values keep their exact value between threads'() {
            const w = await spawn()
            await w.run('values')
            const got = pageRoot.got
            eq([Object.is(got.negZero, -0), Number.isNaN(got.nan), got.big === 3n], [true, true, true], 'set by the worker')
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
