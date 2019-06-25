importScripts('dom-proxy.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var remoteWindow = DOMProxy.createProxy(payload)

    console.log('Host js object: ', remoteWindow.hostData.test.test2)
    console.log('Host location: ', remoteWindow.location.href)
    console.log('Host window title: ', remoteWindow.document.title)
    console.log('Strict equal: ', remoteWindow.document === remoteWindow.document)
    console.log('Host window keys: ', Object.keys(remoteWindow))
    console.log('Host location keys: ', Object.getOwnPropertyNames(remoteWindow.location))
    for (let key of Object.getOwnPropertyNames(remoteWindow.location)) {
        console.log('Host location property: ', key, typeof remoteWindow.location[key] === 'string' ? remoteWindow.location[key]: '(object ommited)')
    }
    self.remoteWindow = remoteWindow

    var el = remoteWindow.document.createElement('div')
    el.innerHTML = 'test'
    remoteWindow.document.body.appendChild(el)

    console.log(remoteWindow.document.body.innerHTML)
})