// Runs index.html in Chromium: `npm run test:browser`
// (needs `npm install` and `npx playwright install chromium` once)
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { chromium } = require('playwright')
const { createServer } = require('../../serve.js')

/**
 * Load the demo, run it and collect what happened.
 * @param {Parameters<typeof createServer>[0] & { path?: string }} options
 * @param {(page: import('playwright').Page) => Promise<object>} [interact]
 */
async function runDemo(options, interact) {
    const server = createServer(options)
    await new Promise(resolve => server.listen(0, () => resolve(undefined)))
    const browser = await chromium.launch()

    try {
        const page = await browser.newPage()
        const result = {
            /** @type {string[]} */ logs: [],
            /** @type {string[]} */ errors: [],
            /** @type {string[]} */ workers: [],
            isolated: false,
        }

        page.on('console', msg => {
            if (msg.type() === 'error') result.errors.push(msg.text())
            else result.logs.push(msg.text())
        })
        page.on('pageerror', err => result.errors.push(err.message))
        page.on('worker', worker => result.workers.push(worker.url()))

        const address = /** @type {import('net').AddressInfo} */ (server.address())
        await page.goto(`http://localhost:${address.port}/${options && options.path || ''}`)
        result.isolated = await page.evaluate(() => crossOriginIsolated)

        const used = interact ? await interact(page) : undefined

        return { ...result, used, page: options && options.path ? await page.evaluate(() => /** @type {any} */ (window).result) : undefined }
    } finally {
        await browser.close()
        server.close()
    }
}

/**
 * Use the demo like a person would. Everything in #app is built by worker A,
 * and every click below runs a listener in worker A.
 * @param {import('playwright').Page} page
 */
async function useDemo(page) {
    const text = (/** @type {string} */ selector) => page.locator(selector).textContent()
    const used = {}

    await page.locator('#counter-plus').click({ timeout: 10000 })
    await page.locator('#counter-plus').click()
    used.counter = await text('#counter-value')

    await page.locator('#todo-input').fill('buy milk')
    await page.locator('#todo-add').click()
    await page.locator('#todo-input').fill('write tests')
    await page.locator('#todo-input').press('Enter')
    used.todos = await page.locator('#todo-list li').allTextContents()
    used.inputCleared = await page.locator('#todo-input').inputValue()

    used.facts = await page.locator('#app dd').allTextContents()

    await page.locator('#primes-input').fill('1000')
    await page.locator('#primes-run').click()
    await page.locator('#primes-result', { hasText: 'primes below' }).waitFor()
    used.primes = await text('#primes-result')

    // worker B dies, the next call into it fails instead of hanging
    await page.locator('#stop-b').click()
    await page.locator('#primes-run').click()
    await page.locator('#primes-result', { hasText: 'Error' }).waitFor({ timeout: 15000 })
    used.afterStop = await text('#primes-result')

    // and worker A still works
    await page.locator('#counter-plus').click()
    used.counterAfterStop = await text('#counter-value')

    used.log = await page.locator('#log li').allTextContents()
    return used
}

for (const forcePolyfill of [false, true]) {
    test(`demo runs with ${forcePolyfill ? 'the await-async.js polyfill' : 'native Atomics.waitAsync'}`, async () => {
        const result = await runDemo({ forcePolyfill }, useDemo)
        const used = /** @type {any} */ (result.used)

        assert.deepStrictEqual(result.errors, [])
        assert.strictEqual(result.isolated, true)
        assert.strictEqual(used.counter, '2')
        assert.deepStrictEqual(used.todos, ['buy milk', 'write tests'])
        assert.strictEqual(used.inputCleared, '')
        assert.strictEqual(used.facts[2], 'true', 'window.document === document')
        assert.strictEqual(used.facts[3], 'true', 'Array.isArray')
        assert.strictEqual(used.facts[4], 'alpha, beta, gamma')
        assert.match(used.primes, /^168 primes below 1,000 /)
        assert.match(used.afterStop, /^RpcThreadDeadError: thread #\d+ is dead$/)
        assert.strictEqual(used.counterAfterStop, '3')
        assert.ok(used.log.includes('worker B: counted primes below 1000'), used.log.join('\n'))

        const helpers = result.workers.filter(url => url.startsWith('data:'))
        assert.strictEqual(helpers.length > 0, forcePolyfill, 'polyfill helper workers used: ' + helpers.length)
    })
}

test('demo explains the missing cross-origin isolation headers', async () => {
    const result = await runDemo({ isolate: false }, async page => ({ status: await page.locator('#status').textContent() }))

    assert.strictEqual(result.isolated, false)
    assert.deepStrictEqual(result.errors, [])
    assert.match(/** @type {any} */ (result.used).status, /not cross-origin isolated/)
})

test('a worker that dies in the middle of a call fails the call instead of hanging', async () => {
    const result = await runDemo({ path: 'test/browser/death.html' })

    assert.deepStrictEqual(result.errors, [])
    const { busy, dead, echo, error } = result.page
    assert.strictEqual(error, undefined)
    // busy for three times the dead threshold, but its heartbeat kept going
    assert.strictEqual(busy, 'done')
    assert.strictEqual(dead.name, 'RpcThreadDeadError', JSON.stringify(dead))
    // b would have been busy for 20s, Chromium takes a second or two to stop a busy worker
    assert.ok(dead.elapsed < 8000, 'noticed after ' + dead.elapsed + 'ms')
    assert.strictEqual(echo, 1)
})
