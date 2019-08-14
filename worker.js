importScripts('./await-async.js')
importScripts('./rpc.js')
importScripts('./dom-proxy.js')

let ia32
let host
let document
self.addEventListener('message', event => {
    var data = event.data

    if (data.command === 'init') {
        ia32 = data.ia32

        const proxy = DomProxy.create(ia32, () => self)

        current = proxy.current
        
        window = proxy.getRemote(data.host)

        self.postMessage({
            command: 'ready',
            current
        })

        self.test = '1'

        window.run = function () {
            
        }
    }
})