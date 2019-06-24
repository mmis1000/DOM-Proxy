# DOM-Proxy (POC)
Trasparent rpc between web worker and browser main context

## Requirements:
1. Atomics.waitAsync (stage2)
2. FinalizationGroup (stage3)

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
    console.log(Object.keys(remoteWindow))
})
```