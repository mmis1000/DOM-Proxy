'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const path = require('path')

const harness = path.join(__dirname, 'dom-proxy-harness.js')
const args = ['--expose-gc', harness]
const scenarios = JSON.parse(spawnSync(process.execPath, args, { encoding: 'utf8' }).stdout)

for (const name of scenarios) {
    test(name, () => {
        const res = spawnSync(process.execPath, [...args, name], { encoding: 'utf8', timeout: 10000 })
        if (res.signal) {
            assert.fail(`timed out (deadlock?)\n${res.stdout}${res.stderr}`)
        }
        assert.strictEqual(res.status, 0, res.stdout + res.stderr)
    })
}
