// Runs index.html in Chromium: `npm run test:browser`
// (needs `npm install` and `npx playwright install chromium` once)
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { chromium } = require('playwright')
const { createServer } = require('../../serve.js')

/**
 * Load the demo, run it and collect what happened.
 * @param {Parameters<typeof createServer>[0]} options
 * @param {(page: import('playwright').Page) => Promise<void>} [interact]
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
            /** @type {string[]} */ dialogs: [],
            /** @type {string[]} */ workers: [],
            isolated: false,
        }

        page.on('console', msg => {
            if (msg.type() === 'error') result.errors.push(msg.text())
            else result.logs.push(msg.text())
        })
        page.on('pageerror', err => result.errors.push(err.message))
        page.on('dialog', dialog => {
            result.dialogs.push(dialog.message())
            dialog.accept()
        })
        page.on('worker', worker => result.workers.push(worker.url()))

        const address = /** @type {import('net').AddressInfo} */ (server.address())
        await page.goto(`http://localhost:${address.port}/`)
        result.isolated = await page.evaluate(() => crossOriginIsolated)

        if (interact) await interact(page)

        return result
    } finally {
        await browser.close()
        server.close()
    }
}

/**
 * @param {import('playwright').Page} page
 */
async function clickInjectedElement(page) {
    // the worker creates this element in the page, its click handler lives in the worker
    await page.getByText('click me').click({ timeout: 10000 })
    await page.waitForTimeout(200)
}

for (const forcePolyfill of [false, true]) {
    test(`demo runs with ${forcePolyfill ? 'the await-async.js polyfill' : 'native Atomics.waitAsync'}`, async () => {
        const result = await runDemo({ forcePolyfill }, clickInjectedElement)

        assert.deepStrictEqual(result.errors, [])
        assert.strictEqual(result.isolated, true)
        assert.deepStrictEqual(result.dialogs, ['how the fuck?', 'callback in worker'])
        // worker0 called worker1 through a function the page handed over
        assert.ok(result.logs.includes('called in worker2'), 'worker to worker call')
        assert.ok(result.logs.includes('yep'), 'worker finished run()')

        const helpers = result.workers.filter(url => url.startsWith('data:'))
        assert.strictEqual(helpers.length > 0, forcePolyfill, 'polyfill helper workers used: ' + helpers.length)
    })
}

test('demo needs the cross-origin isolation headers', async () => {
    const result = await runDemo({ isolate: false })

    assert.strictEqual(result.isolated, false)
    assert.ok(result.errors.some(err => /SharedArrayBuffer is not defined/.test(err)), result.errors.join('\n'))
})
