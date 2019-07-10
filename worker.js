importScripts('./await-async.js')
importScripts('./rpc.js')

let ia32
let current
let send

self.addEventListener('message', event => {
    var data = event.data

    if (data.command === 'init') {
        ia32 = data.ia32

        const temp = listen((from, message) => {
            console.log('#' + current + ' received request from client #' + from)
            return 'result-' + current + '-' + message
        }, ia32)

        current = temp.current
        send = temp.send

        self.postMessage({
            command: 'ready',
            current
        })
    }

    if (data.command === 'send') {
        const target = data.target
        const message = data.message

        console.log('result', send(target, message))
    }
})