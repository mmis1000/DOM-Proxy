importScripts('./await-async.js')
importScripts('./rpc.js')

let ia32
let current
let send

self.addEventListener('message', event => {
    var data = event.data

    if (data.command === 'init') {
        ia32 = data.ia32

        const temp = listen((from, { targets, message }) => {
            console.log('#' + current + ' received request from client #' + from)
            if (targets.length > 0) {
                return send(targets[0], { targets: targets.slice(1), message: current + '-' + message })
            }
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
        console.log(data)
        const targets = data.targets
        const message = data.message

        console.log('result', send(targets[0], { targets: targets.slice(1), message }))
    }
})