# ![Dom-proxy](./public/img/dom-proxy-64.png) WebWorker DOM Proxy (POC)  
Transparent rpc between web worker and mainland(the main page context)  
Looks like [via.js](https://github.com/AshleyScirra/via.js), But more transparent at the cost of halt the web worker and continue on operation finished with `Atomic.wait`.  

## Contents
1. [Requirements](#Requirements-As-of-2019-06-25)
2. [API](#API)
3. [Example](#Example)
4. [Explanation and caveats](#Explanation-and-caveats)
   1. [Explanation](#Explanation)
      1. [Operate on mainland sync](#Operate-on-mainland-sync)
      2. [Strict equal of proxied same object](#Strict-equal-of-proxied-same-object)
      3. [The garbage collection](#The-garbage-collection)
   2. [Caveats](#Caveats)


## Requirements As of 2019-06-25

1. [Atomics.waitAsync (stage2)](https://github.com/tc39/proposal-atomics-wait-async)
2. [WeakRef (stage3)](https://github.com/tc39/proposal-weakrefs)
3. [FinalizationGroup (stage2)](https://github.com/tc39/proposal-weakrefs)

You can try this with chromium(and its friends) 76+ with `--js-flags='--harmony-weak-refs'` flag from cli

## API
- DOMProxy.create(`ia32`, `getRoot`) => `[[Payload Object]]`
  - Call this on both side that want to sue the proxy with same Int32Array baked by SharedArrayBuffer
  - arguments
    - ia32: Int32Array baked by SharedArrayBuffer
    - getRoot : function that return object that represent this thread
  - **must use only once per thread or it will hang**

- [[Payload Object]] 
  - properties
    - current: Id of current payload
    - getRemote(`remoteId`) => `[[proxied remote object]]`
      - arguments
        - remoteId: other thread's `[[Payload Object]].current`

- No other api required, no async await things, no value wrapper, nothing else

## Example
Host
```html
<!-- polyfill -->
<script src="await-async.js"></script>
<script src="rpc.js"></script>
<script src="dom-proxy.js"></script>
<script>
    var sab = new SharedArrayBuffer(1024 * 1024 * 8)
    var ia32 = new Int32Array(sab)
    var proxy = DomProxy.create(ia32, () => window)
    myWorker.postMessage({
        hostId: proxy.current,
        ia32: ia32
    })
</script>
```

Worker
```js
importScripts('await-async.js')
importScripts('rpc.js')
importScripts('dom-proxy.js')

self.addEventListener('message', function (event) {
    var payload = event.data
    var proxy = DomProxy.create(payload.ia32, () => self)
    var remoteWindow = proxy.getRemote(payload.hostId)

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

    // reverse proxied object as is
    remoteWindow.a = {}

    // reverse proxied function also works as is
    el.addEventListener('click', () => remoteWindow.alert('LOLLLL'))
})
```

## Explanation and caveats
### Explanation
#### Operate on mainland sync
This library merely proxy traps of `Proxy` to the mainland,  
so everything should just works as if you are operate on these object in the mainland.

The mainland then receive the request async with `Atomic.asyncAwait`.  
And do things it need to do, response to worker with `Atomic.notify`.

#### Strict equal of proxied same object
1. This library marked the object it send to worker with an id and save it to a collection with that id.  

```js
// mainland
var id = createId()
var map = new Map()
map.set(objectToSend, id)
sendTheIdToWorker(id)

// worker
```

2. The worker then receive the id, build a fake object with it and save the fake object to a collection

```js
// mainland

// worker
var id = getIdFromMainLand()
var map = new Map()
var fakeObject = createProxy(id)
map.set(id, fakeObject)
```

3. When the next time, the worker is requesting the same object,  
   the mainland will find the item in map and send the same id to worker.  
   The worker then find the same object in map with that id

```js
// mainland
var id = map.get(objectToSend)
sendTheIdToWorker(id)

// worker
var id = getIdFromMainLand()
map.get(id)
```

#### The garbage collection
Continue from section above.  

How could you prevent the map in mainland and worker from leaking?  

The `WeakRef` proposal introduced two new APIs that allow you to observe the time garbage collection happened.  
So we make use of them.

1. The worker was modified to hold the fakeObject with a `WeakRef` instead of directly to allow the proxy being collected.

```js
// mainland

// worker
-- map.set(id, fakeObject)
++ map.set(id, new WeakRef(fakeObject))
```

2. The worker use the `FinalizationGroup` to track when will the garbage collection could happen (no one is holding the proxy anymore).  
   And send the event to mainland.

```js
// mainland

// worker
const cleaner = new FinalizationGroup(id => {
    // remove the cache from entry
    map.delete(id)
    tellTheMainlandToDropTheRef(id)
})
cleaner.register(fakeObject, id)
```

3. The mainland then drop the cache it has with the id received.  
   At this point, the knowledge of that object is totally gone from the proxy system.  
   No memory leak happened, cheers.

```js
// mainland
const id = getIdToDropFromWorker()
findIdInMapAndDropIt(map, id)

// worker
```

### Caveats
1. Due to the lack of native `Atomic.asyncAwait`, polyfill is used, the operation is actually far more expensive then it should (each call cost about 0.5ms).

   This means calls like `Object.keys(fakeObject)` will be very slow because it requires to call `getOwnPropertyDescriptor` on every single property (call it on `window` will result in about 200 requests).
2. Due to the `FinalizationGroup` and `WeakRef` isn't ship on all stable browser version.

   It isn't possible to use this library without edit the browser setting from cli directly currently. (that's why this is a POC, WeakRef can't be polyfilled at all)
