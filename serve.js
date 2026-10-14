// Static server for the demo. SharedArrayBuffer is only available on
// cross-origin isolated pages, which needs the COOP and COEP headers below.
//
// usage: node serve.js [port]
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
}

/**
 * @param {{ root?: string, isolate?: boolean, forcePolyfill?: boolean }} [options]
 *   isolate: send the cross-origin isolation headers (only turned off by tests)
 *   forcePolyfill: drop the native Atomics.waitAsync before await-async.js runs, to test the polyfill
 */
function createServer({ root = __dirname, isolate = true, forcePolyfill = false } = {}) {
    return http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
        const file = path.join(root, pathname)

        if (!file.startsWith(root + path.sep)) {
            res.writeHead(403).end()
            return
        }

        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404).end()
                return
            }

            if (forcePolyfill && pathname === '/await-async.js') {
                data = Buffer.concat([Buffer.from('delete Atomics.waitAsync;\n'), data])
            }

            res.writeHead(200, {
                'Content-Type': TYPES[/** @type {keyof TYPES} */ (path.extname(file))] || 'application/octet-stream',
                ...(isolate ? {
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                } : {}),
            })
            res.end(data)
        })
    })
}

if (require.main === module) {
    const port = Number(process.argv[2]) || 8080
    createServer().listen(port, () => {
        console.log(`demo at http://localhost:${port}/`)
    })
}

module.exports = { createServer }
