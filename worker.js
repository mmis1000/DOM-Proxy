importScripts('dom-proxy.js')
importScripts('await-async.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var remoteWindow = DOMProxy.createProxy(payload)
    {
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
        el.innerHTML = 'You have been hacked from web worker lol'
        remoteWindow.document.body.appendChild(el)

        console.log(remoteWindow.document.body.innerHTML)
        remoteWindow.a = new (remoteWindow.Object)()
        remoteWindow.eval('console.log(a)')
        var func = new remoteWindow.Function('el', `
            el.addEventListener('click', () => alert('LOLLLL'))
        `)

        func(el)
    }
    // let's go deeeeper
    var payload2 = DOMProxy.createHost(remoteWindow)
    const myWorker = new Worker("worker2.js");
    myWorker.postMessage(payload2)
})