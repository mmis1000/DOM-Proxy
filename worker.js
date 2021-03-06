importScripts('./await-async.js')
importScripts('./rpc.js')
importScripts('./dom-proxy.js')

let ia32
let host
let window
let document
self.addEventListener('message', event => {
    var data = event.data

    if (data.command === 'init') {
        ia32 = data.ia32

        const proxy = DomProxy.create(ia32, () => self)

        current = proxy.current
        
        window = proxy.getRemote(data.host)
        document = window.document

        self.test = '1'

        console.log(window.location.href)
        console.log(window.document.title)
        console.log(window.document === window.document)

        window.run = function () {
            window.alert('how the fuck?')
            var el = document.createElement("div")
            el.textContent = "click me"
            console.log('break')
            el.addEventListener('click', () => {
                window.alert('callback in worker')
            })
            document.body.appendChild(el)

            // In worker 0
            self.callbackFromWorker1()

            console.log(document.body.innerHTML)
            console.log('yep')
            console.log(Object.keys(window))
            console.log(Object.keys(document))
        }

        self.postMessage({
            command: 'ready',
            current
        })
    }
})