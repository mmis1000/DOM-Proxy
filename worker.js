importScripts('dom-proxy.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var remoteWindow = DOMProxy.createProxy(payload)

    console.log(remoteWindow.hostData.test.test2)
    console.log(remoteWindow.location.href)
    console.log(Object.keys(remoteWindow))
    console.log(Object.getOwnPropertyNames(remoteWindow.location))
    for (let key of Object.getOwnPropertyNames(remoteWindow.location)) {
        console.log(key, remoteWindow.location[key])
    }
})