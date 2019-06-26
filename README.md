# WebWorker DOM Proxy (POC)
Transparent rpc between web worker and browser main context

## Requirements (as of 2019/06/25):
1. Atomics.waitAsync (stage2)
2. WeakRef (stage3)
3. FinalizationGroup (stage2)

## API
- DOMProxy.createHost() => \[\[Payload Object]]  
  - Call this on the main window, get the payload, pass it to webworker via postMessage
- DOMProxy.createProxy(\[\[Payload Object]]) => \[\[Proxied window object]]  
  - Recieve the payload from main window via message listener, and create proxied window with it
- No other api required, no async await things, no value wrapper, nothing else

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

    // modify dom as is
    var el = remoteWindow.document.createElement('div')
    el.innerHTML = 'You have been hacked from web worker lol'
    remoteWindow.document.body.appendChild(el)

    // while applied directly (no async await required!!!)
    console.log(remoteWindow.document.body.innerHTML)

    // CURRENT LIMITATION: you can only set/pass object from remote on/to object/function from remote
    // as the proxy is not bilateral
    remoteWindow.a = new (remoteWindow.Object)()

    // but eval works as is
    remoteWindow.eval('console.log(a)')

    // new Function also works as is
    var func = new remoteWindow.Function('el', `
        el.addEventListener('click', () => alert('LOLLLL'))
    `)
    func(el)
})
```