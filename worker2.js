importScripts('dom-proxy.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var remoteWindow = DOMProxy.createProxy(payload)

    console.log('can I go deeper? ')
    console.log(remoteWindow.document.body.innerHTML)

    var el = remoteWindow.document.createElement('div')
    el.innerHTML = 'You have been hacked from web worker2 lol'
    remoteWindow.document.body.appendChild(el)
})