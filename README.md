# DOM-Proxy (POC)
Transparent rpc between web worker and browser main context

## Requirements:
1. Atomics.waitAsync (stage2)
2. WeakRef (stage3)
3. FinalizationGroup (stage3)

## Usage

Host
```html
<!-- polyfill -->
<script src="await-async.js"></script>
<script src="dom-proxy.js"></script>
<script>
    var payload = DOMProxy.createHost()
    const myWorker = new Worker("worker.js");
    myWorker.postMessage(payload)
</script>
```

Worker
```js
importScripts('dom-proxy.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var remoteWindow = DOMProxy.createProxy(payload)

    // access the window object as if it is actully in webworker
    console.log(remoteWindow.location.href)
    console.log(remoteWindow.document.title)
    // strict equal works as is thanks to WeakRef
    console.log(remoteWindow.document === remoteWindow.document)
    // object keys got proxied
    console.log(Object.keys(remoteWindow))
    console.log(Object.getOwnPropertyNames(remoteWindow.location))
})
```