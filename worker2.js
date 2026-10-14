// Worker B: does the heavy lifting for worker A
importScripts('./await-async.js', './rpc.js', './dom-proxy.js')

self.onmessage = event => {
    const { ia32, host } = event.data
    const proxy = DomProxy.create(ia32, () => self, { deadAfter: 1000 })
    const window = proxy.getRemote(host)

    /**
     * count the primes below `limit` with a sieve
     * @param {number} limit
     */
    self.countPrimes = limit => {
        const composite = new Uint8Array(limit)
        let count = 0

        for (let i = 2; i < limit; i++) {
            if (composite[i]) continue
            count++
            for (let j = i * i; j < limit; j += i) composite[j] = 1
        }

        window.demoLog(`worker B: counted primes below ${limit}`)
        return count
    }

    self.postMessage({ ready: proxy.current })
}
