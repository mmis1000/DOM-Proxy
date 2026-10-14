# ![Dom-proxy](./public/img/dom-proxy-64.png) WebWorker DOM Proxy (POC)  
Transparent rpc between web worker and mainland(the main page context)  
Looks like [via.js](https://github.com/AshleyScirra/via.js), but more transparent, at the cost of blocking the calling thread with `Atomics.wait` until the operation finishes.  

## Contents
1. [Requirements](#Requirements)
2. [API](#API)
3. [Example](#Example)
4. [Explanation and caveats](#Explanation-and-caveats)
   1. [Explanation](#Explanation)
      1. [Operate on mainland sync](#Operate-on-mainland-sync)
      2. [Strict equal of proxied same object](#Strict-equal-of-proxied-same-object)
      3. [The garbage collection](#The-garbage-collection)
   2. [Caveats](#Caveats)
5. [Tests](#Tests)
6. [Todos](#TODOS)


## Requirements

1. [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer), which needs the page to be [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated).
   Serve the page (including `index.html` for the demo) with these headers:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
2. [WeakRef](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef) and [FinalizationRegistry](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry)
3. [Atomics.waitAsync](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync); `await-async.js` installs a polyfill only where the browser has none

## API
- DomProxy.create(`ia32`, `getRoot`) => `[[Payload Object]]`
  - Call this on every thread that wants to use the proxy, with the same Int32Array backed by a SharedArrayBuffer
  - arguments
    - ia32: Int32Array backed by a SharedArrayBuffer. Messages are passed through it, so it must be large enough for the largest message (sending a larger one throws)
    - getRoot : function that returns the object that represents this thread
  - **call it only once per thread**

- [[Payload Object]] 
  - properties
    - current: Id of current payload
    - getRemote(`remoteId`) => `[[proxied remote object]]`
      - arguments
        - remoteId: other thread's `[[Payload Object]].current`

- No other api required, no async await things, no value wrapper, nothing else
- An error thrown on the other thread is rethrown in the calling thread

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

    // the same remote object always maps to the same proxy
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
This library forwards the traps of `Proxy` to the mainland,  
so everything should just work as if you operated on these objects in the mainland.

The calling thread writes the request into the shared buffer, wakes the other side with `Atomics.notify`, and blocks with `Atomics.wait` until the response arrives.  
An idle thread receives requests with `Atomics.waitAsync`, does what it needs to do, and responds with `Atomics.notify`.  
Calls can nest in both directions: while waiting for a response, a thread still serves requests made to it, so callbacks into the waiting thread work.

The page itself is not allowed to block with `Atomics.wait`, so when the page calls into a worker it busy-waits for the response instead.

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

`WeakRef` and `FinalizationRegistry` let you observe when garbage collection happened.  
So we make use of them.

1. The worker was modified to hold the fakeObject with a `WeakRef` instead of directly to allow the proxy being collected.

```js
// mainland

// worker
-- map.set(id, fakeObject)
++ map.set(id, new WeakRef(fakeObject))
```

2. The worker uses a `FinalizationRegistry` to learn when the proxy was collected (no one is holding it anymore),  
   and tells the mainland (collected ids are sent in batches).

```js
// mainland

// worker
const cleaner = new FinalizationRegistry(id => {
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
1. Every property access, call or assignment on a proxy is a blocking round trip to another thread, and only one call chain runs across all threads at a time.
   Avoid chatty access in hot loops. `Object.keys` and similar fetch every property descriptor of the object in one request.
2. In browsers without native `Atomics.waitAsync` the polyfill is used, which waits in a helper worker and is far more expensive.
3. Garbage collection relies on `WeakRef` and `FinalizationRegistry`, which can't be polyfilled. Two objects that only reference each other across threads are never collected.
4. Values are serialized as JSON, so only strings, numbers, booleans, `null`, `undefined`, objects and functions can be passed (objects and functions are passed as proxies).

## Tests
`npm test` runs the rpc and proxy layers with real Node.js worker threads (Node 22+); the main thread plays the page, with `Atomics.wait` disabled as in a browser window.

## TODOS
1. Mapping symbol between workers (currently throws)
2. Fix thread count limit (currently 255)
3. Fix object id limit (currently 8388608, aka `2**23`)