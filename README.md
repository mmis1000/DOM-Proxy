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
      4. [Dead and stuck threads](#Dead-and-stuck-threads)
   2. [Caveats](#Caveats)
5. [Tests](#Tests)
6. [Todos](#TODOS)


## Requirements

1. [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer), which needs the page to be [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated).
   Serve the page with these headers (`npm run demo` serves `index.html` with them at http://localhost:8080/):
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
2. [WeakRef](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef) and [FinalizationRegistry](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry)
3. [Atomics.waitAsync](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync); `await-async.js` installs a polyfill only where the browser has none

## API
- DomProxy.create(`ia32`, `getRoot`, `options?`) => `[[Payload Object]]`
  - Call this on every thread that wants to use the proxy, with the same Int32Array backed by a SharedArrayBuffer
  - arguments
    - ia32: Int32Array backed by a SharedArrayBuffer. Messages are passed through it, so it must be large enough for the largest message (sending a larger one throws). About 3KB of it is used for bookkeeping
    - getRoot : function that returns the object that represents this thread
    - options (optional, per thread)
      - timeout: ms a call made from this thread may take, including the wait for other calls to finish. Default `Infinity`, like any JavaScript call
      - deadAfter: ms without a heartbeat before another thread counts as dead. Default `2000`
      - heartbeatInterval: ms between heartbeats. Default `100`
      - startHeartbeat: `false` to turn the heartbeat off, or a function `(ia32, index, interval)` that keeps incrementing `ia32[index]` for as long as this thread lives. The default starts a nested worker
  - **call it only once per thread**

- [[Payload Object]] 
  - properties
    - current: Id of current payload
    - getRemote(`remoteId`) => `[[proxied remote object]]`
      - arguments
        - remoteId: other thread's `[[Payload Object]].current`

- No other api required, no async await things, no value wrapper, nothing else
- An error thrown on the other thread is rethrown in the calling thread
- A call can also fail with an error whose `name` is
  - `RpcTimeoutError`: the call took longer than `timeout`
  - `RpcThreadDeadError`: the thread it went to is dead (its `thread` property holds the id)
  - `RpcAbortedError`: the caller further up already gave up on the call this thread is running, so the rest of it can't send anything anymore

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

#### Dead and stuck threads
All calls share one lock, so a thread that dies or hangs in the middle of a call would otherwise freeze every thread.

- Every thread starts a tiny nested worker that keeps incrementing a counter in the shared memory, even while its thread is busy or blocked. The browser stops it together with its thread, so a counter that stops moving for `deadAfter` means the thread is dead.
- A call to a dead thread fails with `RpcThreadDeadError`, and a call that exceeds `timeout` fails with `RpcTimeoutError`. Either way the caller takes the lock back, and all other threads carry on.
- The thread that was given up on may still be running. Everything it tries to write afterwards (its response, its own calls) is rejected: every write is a compare-and-swap from the exact lock value at which the thread got its turn, and that value includes a counter which changes whenever a call is abandoned. So a late response can never land in someone else's call.
- If the thread holding the lock dies with nobody waiting on it, the next thread that wants the lock resets it.

### Caveats
1. Every property access, call or assignment on a proxy is a blocking round trip to another thread, and only one call chain runs across all threads at a time.
   Avoid chatty access in hot loops. `Object.keys` and similar fetch every property descriptor of the object in one request.
2. In browsers without native `Atomics.waitAsync` the polyfill is used, which waits in a helper worker and is far more expensive.
3. Garbage collection relies on `WeakRef` and `FinalizationRegistry`, which can't be polyfilled. Two objects that only reference each other across threads are never collected.
4. Primitives (including `NaN`, `-0`, `Infinity` and `BigInt`) are copied exactly, objects and functions are passed as proxies.
   Well-known symbols (`Symbol.iterator`, `Symbol.toPrimitive`...) and registered ones (`Symbol.for`) work as values and keys, so `for...of`, spreading, template literals and `instanceof` work on proxies.
   A unique symbol (`Symbol()`) can't be passed yet: passing one throws, and reading such a key from a proxy gives `undefined`.
5. A proxy is not an array to `Array.isArray`, and every property it reports is configurable (a non-configurable one would conflict with the proxy's placeholder target).
6. A thread that dies before its heartbeat started (within milliseconds of starting, or while it is busy right after starting) counts as alive. Chromium takes a few seconds to actually stop a busy worker after `terminate()`, so its death is noticed only then.
   Objects the dead thread had received stay referenced on the threads that own them.

## Tests
- `npm test` runs the rpc and proxy layers with real Node.js worker threads (Node 22+); the main thread plays the page, with `Atomics.wait` disabled as in a browser window.
- `npm run test:browser` runs the demo page in Chromium through Playwright, with native `Atomics.waitAsync` and with the `await-async.js` polyfill, and checks that a worker terminated in the middle of a call is noticed.
  Run `npm install` and `npx playwright install chromium` first.

## TODOS
1. Mapping unique symbols between workers (currently throws)
2. Fix thread count limit (currently 255)
3. Fix object id limit (currently 8388608, aka `2**23`)