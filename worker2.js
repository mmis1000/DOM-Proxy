importScripts('dom-proxy.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var remoteWindow = DOMProxy.createProxy(payload)

    console.log('can I go deeper? ')

    var el = remoteWindow.document.createElement('div')
    el.innerHTML = 'You have been hacked from web worker2 lol'
    remoteWindow.document.body.appendChild(el)

    console.log(remoteWindow.document.body.innerHTML)

    console.time('worker2')
    console.log('Host window keys: ', Object.keys(remoteWindow))
    console.timeEnd('worker2')
})