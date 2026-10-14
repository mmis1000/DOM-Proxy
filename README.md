# ![DOM Proxy](./public/img/dom-proxy-64.png) DOM Proxy

[![CI](https://github.com/mmis1000/DOM-Proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/mmis1000/DOM-Proxy/actions/workflows/ci.yml)

Use the page's `window` and `document` from a web worker, **synchronously**, as if the code ran on the page.

```js
// in a worker
const window = proxy.getRemote(pageId)
const document = window.document

const button = document.createElement('button')
button.textContent = 'Click me'
button.addEventListener('click', () => {
    // this listener runs in the worker
    button.textContent = `clicked at ${new Date().toLocaleTimeString()}`
})
document.body.append(button)

console.log(document.body.innerHTML) // already there, no await
```

No `async`/`await`, no value wrappers, no message passing to write. Every proxy operation (property reads and writes, calls, `new`, `in`, `delete`, `Object.keys`, iteration...) is forwarded to the thread that owns the object, and the calling thread blocks with `Atomics.wait` until the answer comes back.
It works in any direction: workers can use page objects, the page can call worker functions, and workers can call each other.

Compared to [via.js](https://github.com/AshleyScirra/via.js) or [Comlink](https://github.com/GoogleChromeLabs/comlink) this is more transparent, at the price of blocking the calling thread for every operation.
It is a proof of concept: see [limitations](#limitations).

## Contents
- [Try the demo](#try-the-demo)
- [Usage](#usage)
- [API](#api)
- [What works across threads](#what-works-across-threads)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Requirements](#requirements)
- [Development](#development)

## Try the demo
```sh
npm run demo
```
Then open http://localhost:8080/. In the demo a worker builds an interactive panel in the page (counter, todo list, a call into a second worker), and you can terminate the second worker to see a dead thread being detected.

The demo needs a local server because `SharedArrayBuffer` only exists on [cross-origin isolated](#requirements) pages; `npm run demo` (`serve.js`, no dependencies) sends the headers for that.

## Usage
Load the three scripts on the page and in every worker, create one proxy per thread on the same shared memory, and exchange the thread ids.

Page:
```html
<script src="await-async.js"></script>
<script src="rpc.js"></script>
<script src="dom-proxy.js"></script>
<script>
    const ia32 = new Int32Array(new SharedArrayBuffer(8 * 1024 * 1024))
    const proxy = DomProxy.create(ia32, () => window)

    const worker = new Worker('worker.js')
    worker.postMessage({ ia32, pageId: proxy.current })
</script>
```

Worker:
```js
importScripts('await-async.js', 'rpc.js', 'dom-proxy.js')

self.onmessage = event => {
    const { ia32, pageId } = event.data
    const proxy = DomProxy.create(ia32, () => self)
    const window = proxy.getRemote(pageId)

    console.log(window.location.href, window.document.title)
}
```

`getRoot` (the second argument) decides what other threads get from `getRemote`. Here the page exposes `window`, and the worker exposes `self`, so the page could also call functions the worker puts on `self`, or hand them to another worker.

## API
### `DomProxy.create(ia32, getRoot, options?)`
Call it once per thread, with the same `Int32Array` everywhere.

| Argument | |
|---|---|
| `ia32` | `Int32Array` on a `SharedArrayBuffer`. Every message passes through it, so it must hold the largest message (a larger one throws `RangeError`). About 3KB are used for bookkeeping. |
| `getRoot` | Returns the object other threads get from `getRemote(thisThreadId)`. |
| `options.timeout` | Ms a call made from this thread may take, including the wait for other calls to finish. Default `Infinity`, like any JavaScript call. |
| `options.deadAfter` | Ms without a heartbeat before another thread counts as dead. Default `2000`. |
| `options.heartbeatInterval` | Ms between heartbeats. Default `100`. |
| `options.startHeartbeat` | `false` to turn the heartbeat off, or `(ia32, index, interval) => void` to start something that keeps incrementing `ia32[index]` for as long as this thread lives. The default starts a nested worker. |

Returns `{ current, getRemote }`:
- `current`: the id of this thread, to give to other threads.
- `getRemote(threadId)`: the root object of another thread.

### Errors
An error thrown on the other thread is rethrown in the caller. On top of that, a call can fail with an error with one of these `name`s:

| `name` | When |
|---|---|
| `RpcTimeoutError` | The call took longer than `options.timeout`. |
| `RpcThreadDeadError` | The thread the call went to is dead. Its `thread` property holds the id. |
| `RpcAbortedError` | Thrown in a call that the caller further up already gave up on, so the rest of it can't send anything anymore. |

## What works across threads
| | |
|---|---|
| Reading and writing properties, calling functions and methods, `new` | Yes |
| Passing functions, like event listeners, in any direction | Yes, they run on the thread that created them |
| Nested calls and callbacks into a waiting thread | Yes, up to 255 calls deep |
| Identity: the same object always gives the same proxy | Yes, `document === window.document` |
| `in`, `delete`, `Object.defineProperty`, `Object.keys`, spreading | Yes. `Object.keys` and similar fetch all descriptors in one request |
| `for...of`, template literals, `instanceof`, `Symbol.toStringTag` | Yes, well-known and `Symbol.for` symbols are the same on every thread |
| Unique symbols (`Symbol()`) | Yes, as a stand-in with the same description; passing it back gives the original |
| `Array.isArray`, `JSON.stringify` of a remote array | Yes, the proxy of an array is an array |
| `NaN`, `-0`, `Infinity`, `BigInt` | Copied exactly |
| Garbage collection | Yes, except for cycles across threads |

## How it works
### Calls
Each proxy forwards its [`Proxy` traps](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy) to the thread that owns the real object.
The caller takes a global lock, writes the request into the shared buffer, wakes the other thread with `Atomics.notify` and blocks with `Atomics.wait` until the response arrives.
An idle thread picks requests up with `Atomics.waitAsync`.
While a thread waits for a response it still serves requests made to it, so callbacks into the waiting thread work, however deep the calls nest.

The page is not allowed to block with `Atomics.wait`, so while the page waits for a worker it busy-waits instead.

### Identity
Every object sent to another thread gets an id, kept in a map on its own thread. The receiving thread makes one proxy per id and keeps it in a map too, so the same object always arrives as the same proxy, and sending a proxy back gives the original object.

### Garbage collection
The receiving thread holds its proxies with `WeakRef`, and a `FinalizationRegistry` tells it when one was collected. It then tells the owner (in batches), which forgets the id once no thread holds a proxy for it anymore.

### Dead and stuck threads
All calls share one lock, so a thread that dies or hangs in the middle of a call would otherwise freeze every thread.

- Every thread starts a tiny nested worker that keeps incrementing a counter in the shared memory, even while its thread is busy or blocked. The browser stops it together with its thread, so a counter that stops moving for `deadAfter` means the thread is dead.
- A call to a dead thread fails with `RpcThreadDeadError`, and a call that exceeds `timeout` fails with `RpcTimeoutError`. Either way the caller takes the lock back, and all other threads carry on.
- The thread that was given up on may still be running. Everything it tries to write afterwards is rejected: every write is a compare-and-swap from the exact lock value at which the writer got its turn, and that value includes a counter which changes whenever a call is abandoned. So a late response never lands in someone else's call.
- If the thread holding the lock dies with nobody waiting on it, the next thread that wants the lock resets it.

## Limitations
1. **Every operation on a proxy is a blocking round trip**, and only one call chain runs across all threads at a time. Avoid chatty access in hot loops.
2. **Calls block like normal JavaScript calls.** When the page calls a worker function, for example an event listener, the page waits until it returns. Hand slow work over to a task of the worker's own (`setTimeout`), as the demo does.
3. **Two objects that only reference each other across threads are never collected**: each side keeps its own object alive for the other. A common case is a worker listener that captures the element it listens to.
4. Every property a proxy reports is configurable, except the `length` of an array (a non-configurable one would conflict with the proxy's placeholder target).
5. Unique symbols are only collected on engines that can hold symbols weakly (ES2023); elsewhere every unique symbol that crossed threads is kept forever.
6. A thread that dies before its heartbeat started (within milliseconds of starting, or while busy right after starting) counts as alive. Chromium takes a few seconds to stop a busy worker after `terminate()`, so its death is noticed only then. Objects a dead thread had received stay referenced on the threads that own them.
7. At most 255 threads and 8388608 (`2**23`) objects per thread.

## Requirements
- [`SharedArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer), which needs a [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) page, served with:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
- [`WeakRef`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef) and [`FinalizationRegistry`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry)
- [`Atomics.waitAsync`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync): `await-async.js` installs a polyfill where the browser has none, which waits in a helper worker and is much slower.

## Development
| File | |
|---|---|
| `rpc.js` | Blocking calls between threads over shared memory: the lock, nested calls, timeouts, dead threads |
| `dom-proxy.js` | The proxies on top of it: ids, identity, garbage collection, value encoding |
| `await-async.js` | `Atomics.waitAsync` polyfill |
| `index.html`, `worker.js`, `worker2.js` | The demo |
| `serve.js` | Static server with the cross-origin isolation headers (`npm run demo`) |

```sh
npm test               # rpc and proxy layers with real Node.js worker threads (Node 22+)
npm install
npx playwright install chromium
npm run test:browser   # the demo and a dying worker in Chromium, with native and polyfilled Atomics.waitAsync
```

`npm test` plays the page with Node's main thread, with `Atomics.wait` disabled as in a browser window, and runs every scenario in its own process so a deadlock fails the test instead of hanging it.
GitHub Actions runs both on every push and pull request.

## License
ISC, as declared in `package.json`.
