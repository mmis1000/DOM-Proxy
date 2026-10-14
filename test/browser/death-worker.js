importScripts('../../await-async.js', '../../rpc.js', '../../dom-proxy.js')

const root = {
    busy(ms) {
        const end = Date.now() + ms
        while (Date.now() < end) { }
        return 'done'
    },
    echo: x => x,
}

let proxy

self.onmessage = event => {
    const data = event.data

    if (data.init) {
        proxy = DomProxy.create(data.ia32, () => root, { deadAfter: 500 })
        // report ready once the heartbeat beats (slot 8 + id, see rpc.js)
        const waitForHeartbeat = () => Atomics.load(data.ia32, 8 + proxy.current) !== 0
            ? self.postMessage({ ready: proxy.current })
            : setTimeout(waitForHeartbeat, 5)
        waitForHeartbeat()
        return
    }

    const start = performance.now()
    try {
        self.postMessage({ value: proxy.getRemote(data.call.target).busy(data.call.ms) })
    } catch (err) {
        self.postMessage({ name: err.name, message: err.message, elapsed: performance.now() - start })
    }
}
