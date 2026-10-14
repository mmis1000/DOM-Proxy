'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const path = require('path')

const harness = path.join(__dirname, 'harness.js')
const scenarios = JSON.parse(spawnSync(process.execPath, [harness], { encoding: 'utf8' }).stdout)

for (const [label, env] of [['native waitAsync', {}], ['polyfill waitAsync', { RPC_TEST_POLYFILL_SHAPE: '1' }]]) {
    for (const name of scenarios) {
        test(`${name} (${label})`, () => {
            const res = spawnSync(process.execPath, [harness, name], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } })
            if (res.signal) {
                assert.fail(`timed out (deadlock?)\n${res.stdout}${res.stderr}`)
            }
            assert.strictEqual(res.status, 0, res.stdout + res.stderr)
        })
    }
}
