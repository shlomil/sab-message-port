# sab-message-port

High-performance IPC for Web Workers and Node.js worker threads over `SharedArrayBuffer`.

Passes JSON messages between threads through shared memory using `Atomics` for synchronization — no serialization through `postMessage`, no copying overhead. Supports both **blocking** reads (via `Atomics.wait` in worker threads) and **non-blocking** async reads (via `Atomics.waitAsync`, safe on the main thread). Large messages are chunked transparently.

## Motivation

The native `postMessage` API is event-loop driven — a worker can only receive messages by yielding control back to the event loop. This makes it unsuitable for long-running synchronous worker code that needs to communicate mid-execution without returning from its current call stack.

`sab-message-port` solves this by providing a **blocking read** (`Atomics.wait`) that lets a worker pause in place, wait for a message, and resume — with no dependence on the event loop. The worker stays in its own synchronous flow while the main thread sends messages asynchronously from the other side.

## Install

```bash
npm install sab-message-port
```

```javascript
import { SABMessagePort, SABPipe } from 'sab-message-port';
```

## Quick Start

**Main thread:**

```javascript
import { SABMessagePort } from 'sab-message-port';

const port = new SABMessagePort();
port.postInit(worker);

port.onmessage = (e) => console.log('from worker:', e.data);
port.postMessage({ cmd: 'ping' });
```

**Worker:**

```javascript
import { SABMessagePort } from 'sab-message-port';

self.onmessage = (e) => {
  if (e.data.type === 'SABMessagePort') {
    const port = SABMessagePort.from(e.data);

    port.onmessage = (e) => {
      if (e.data.cmd === 'ping') {
        port.postMessage({ reply: 'pong' });
      }
    };
  }
};
```

## Example: Blocking Reads with Interrupt

With native `postMessage`, a worker can only receive messages by returning to the event loop. If the worker is stuck in a long synchronous loop, incoming messages pile up undelivered. `sab-message-port` solves this — `port.read()` blocks in-place via `Atomics.wait`, and `port.tryRead()` checks for signals mid-computation, all without yielding to the event loop.

**main.js**

```javascript
import { SABMessagePort } from 'sab-message-port';

const worker = new Worker('./worker.js', { type: 'module' });
const port = new SABMessagePort();
port.postInit(worker);

port.onmessage = ({ data }) => console.log(data);

// Start a long task
port.postMessage({ cmd: 'run', task: 'A', iterations: 5_000_000 });

// After 200ms, abort and start a different task
setTimeout(() => {
  port.postMessage({ cmd: 'abort' });
  port.postMessage({ cmd: 'run', task: 'B', iterations: 2_000_000 });
}, 200);
```

**worker.js** — entirely synchronous, never yields to the event loop

```javascript
import { SABMessagePort } from 'sab-message-port';

self.onmessage = (e) => {
  if (e.data.type !== 'SABMessagePort') return;
  const port = SABMessagePort.from(e.data);

  while (true) {
    const task = port.read();            // block until a task arrives
    if (task.cmd !== 'run') continue;

    for (let i = 0; i < task.iterations; i++) {
      /* ... heavy work ... */

      if (i % 500_000 === 0) {
        port.postMessage({ task: task.task, progress: `${(i / task.iterations * 100) | 0}%` });

        if (port.tryRead()?.cmd === 'abort') {   // non-blocking check
          port.postMessage({ task: task.task, aborted: true });
          break;                                  // → back to port.read()
        }
      }
    }
  }
};
```

---

## SABMessagePort

Bidirectional channel over a single `SharedArrayBuffer`. Both sides can read and write simultaneously — full duplex. API mirrors the native `MessagePort`.

All messages must be **JSON-serializable** (they go through `JSON.stringify`/`JSON.parse` internally). Message ordering is **FIFO** — messages are always delivered in the order they were sent.

### `new SABMessagePort(side = 'a', sizeKB = 256)`

Creates a new bidirectional port.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `side` | `'a'` | `'a'` (initiator) or `'b'` (responder). Typically only the initiator is created directly; the responder uses `SABMessagePort.from()`. |
| `sizeKB` | `256` | Total buffer size in KB (split in half between the two directions), or an existing `SharedArrayBuffer`. Each direction gets `sizeKB / 2` KB of buffer space. |

```javascript
const port = new SABMessagePort();          // 256 KB total (128 KB per direction), side 'a'
const port = new SABMessagePort('a', 512);  // 512 KB total (256 KB per direction)

// Or pass an existing SharedArrayBuffer
const sab = new SharedArrayBuffer(256 * 1024);
const port = new SABMessagePort('a', sab);
```

Throws if `side` is not `'a'` or `'b'`.

### `SABMessagePort.from(initMsg)`

Creates the responder side (`'b'`) from a received init message. The init message must have `type: 'SABMessagePort'` and a `buffer` property containing the `SharedArrayBuffer`.

Throws if `initMsg.type !== 'SABMessagePort'`.

```javascript
// Worker side
self.onmessage = (e) => {
  if (e.data.type === 'SABMessagePort') {
    const port = SABMessagePort.from(e.data);
    // ready to send and receive
  }
};
```

### `port.postInit(target = null, extraProps = {})`

Sends the shared buffer to the other side via `postMessage`, or returns the arguments for manual sending.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `target` | `null` | A `Worker`, `MessagePort`, or any object with a `postMessage` method. If `null`, returns the arguments instead of sending. |
| `extraProps` | `{}` | Additional properties merged into the init message (e.g. `{ channel: 'rpc' }`). |

When `target` is provided, calls `target.postMessage(data, transferList)` directly. When `target` is `null`, returns `[data, transferList]` — a two-element array where `data` is the init message object and `transferList` is `[sharedArrayBuffer]`.

```javascript
// Auto-send to worker
port.postInit(worker, { channel: 'rpc' });

// Manual — returns [data, transferList]
const [data, transfer] = port.postInit(null, { channel: 'rpc' });
// data = { type: 'SABMessagePort', buffer: SharedArrayBuffer, channel: 'rpc' }
// transfer = [SharedArrayBuffer]
worker.postMessage(data, transfer);
```

### `port.postMessage(msg)` → `Promise`

Queues a JSON-serializable message for sending. Returns a promise that resolves when the message has been written to the shared buffer.

Multiple `postMessage()` calls made before the writer flushes are **batched** into a single payload and sent together. The returned promise resolves when the entire batch containing that message is fully written. This means you can fire off multiple `postMessage()` calls without awaiting — they will be coalesced efficiently.

```javascript
// Fire-and-forget (message is queued and sent asynchronously)
port.postMessage({ action: 'save', data: [1, 2, 3] });

// Or await to know when it's been written to the buffer
await port.postMessage({ action: 'save', data: [1, 2, 3] });

// Batching: these may all be sent as one payload
port.postMessage({ a: 1 });
port.postMessage({ b: 2 });
port.postMessage({ c: 3 });
```

Throws if the port has been closed.

### `port.onmessage`

Event-driven reader. Mirrors the `MessagePort.onmessage` pattern. Setting a handler starts a continuous async read loop; setting `null` stops it.

The handler receives an event object with a `data` property containing the message, matching the Web API convention: `handler({ data: message })`.

```javascript
port.onmessage = (e) => {
  console.log(e.data); // the received message
};

// Stop listening
port.onmessage = null;
```

**Mutual exclusion:** You cannot call `read()`, `asyncRead()`, or `tryRead()` while an `onmessage` handler is active — doing so throws an error. Set `onmessage = null` first.

**Error resilience:** If the handler throws, the error is silently caught and the message loop continues. This ensures one bad message doesn't break the entire channel.

**Re-assignment:** Assigning a new handler function replaces the current one immediately within the same loop — no gap in delivery and no duplicate loops.

### `await port.asyncRead(timeout = Infinity, maxMessages = 1)` → message | null | Array

Async read using `Atomics.waitAsync`. **Safe on the main thread.** Waits for a message or until timeout expires.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `Infinity` | Maximum time to wait in milliseconds. `Infinity` waits forever. |
| `maxMessages` | `1` | Maximum number of messages to return. |

**Return value depends on `maxMessages`:**

- **`maxMessages = 1`** (default): Returns a single message, or `null` if timeout expired with no data.
- **`maxMessages > 1`**: Returns an **array** of messages ordered **newest-first, oldest-last**, up to `maxMessages` items. Returns an **empty array** `[]` if timeout expired with no data. You can `pop()` from the returned array to process messages in send order (FIFO).

If messages are already queued internally from a previous batch, they are returned immediately without waiting.

```javascript
const msg = await port.asyncRead();          // wait forever, returns single message
const msg = await port.asyncRead(1000);      // wait up to 1s, returns message or null
const msgs = await port.asyncRead(1000, 5);  // up to 5 messages, array (newest first, pop for FIFO)
const msgs = await port.asyncRead(0, 10);    // non-blocking, returns whatever is available now
```

Throws if the port has been closed, or if `onmessage` is active.

### `port.read(timeout = Infinity, blocking = true, maxMessages = 1)` → message | null | Array

Synchronous read using `Atomics.wait`. **Worker threads only** — calling this on the main thread throws (`Atomics.wait` is not allowed on the main thread).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `Infinity` | Maximum time to wait in milliseconds. Ignored when `blocking` is `false`. |
| `blocking` | `true` | If `true`, blocks the thread until data arrives or timeout expires. If `false`, returns immediately. |
| `maxMessages` | `1` | Maximum number of messages to return. |

**Return value depends on `maxMessages`:**

- **`maxMessages = 1`** (default): Returns a single message, or `null` if no data is available (timeout or non-blocking).
- **`maxMessages > 1`**: Returns an **array** of messages ordered **newest-first, oldest-last**, up to `maxMessages` items. Returns an **empty array** `[]` if no data is available. You can `pop()` from the returned array to process messages in send order (FIFO).

If messages are already queued internally from a previous batch, they are returned immediately without blocking.

**Timeout and multipart messages:** The timeout only applies to the initial wait for a message. Once a large (multipart) message begins arriving, the read waits indefinitely for all remaining parts to ensure the message is fully received.

```javascript
const msg = port.read();                    // block forever until message
const msg = port.read(500);                 // block up to 500ms, null on timeout
const msg = port.read(0, false);            // non-blocking, returns null if empty
const msgs = port.read(1000, true, 5);      // block up to 1s, up to 5 msgs (newest first, pop for FIFO)
```

Throws if the port has been closed, or if `onmessage` is active.

### `port.tryRead(maxMessages = 1)` → message | null | Array

Non-blocking read. Equivalent to `port.read(0, false, maxMessages)`. Returns immediately with available data.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxMessages` | `1` | Maximum number of messages to return. |

**Return value depends on `maxMessages`:**

- **`maxMessages = 1`** (default): Returns a single message, or `null`.
- **`maxMessages > 1`**: Returns an **array** (newest-first, oldest-last), or an **empty array** `[]`. `pop()` to process in FIFO order.

```javascript
const msg = port.tryRead();       // single message or null
const msgs = port.tryRead(10);    // up to 10 messages (array, newest first) or []
```

### `port.close()`

Disposes both directions. Unblocks any waiting readers/writers by signaling disposal. After closing, all `postMessage()`, `read()`, `asyncRead()`, and `tryRead()` calls will throw. Calling `close()` multiple times is safe (subsequent calls are no-ops).

### `port.buffer` → `SharedArrayBuffer`

The underlying shared buffer.

---

## SABPipe

Unidirectional channel — one end writes, the other reads. Used internally by `SABMessagePort`, but useful on its own when you only need one-way communication.

All messages must be **JSON-serializable**. Message ordering is **FIFO**.

### `new SABPipe(role, sabOrSize = 131072, byteOffset = 0, sectionSize = null)`

| Parameter | Default | Description |
|-----------|---------|-------------|
| `role` | (required) | `'w'` (writer) or `'r'` (reader). Throws if invalid. |
| `sabOrSize` | `131072` | Byte size for a new buffer (128 KB), or an existing `SharedArrayBuffer`. |
| `byteOffset` | `0` | Starting byte offset in the SAB. |
| `sectionSize` | `null` | Section size in bytes. Defaults to the remaining SAB from `byteOffset`. |

The writer and reader must share the same `SharedArrayBuffer` (and same offset/section) to communicate. Role enforcement is strict: the writer can only call `postMessage()`, and the reader can only call `read()`/`asyncRead()`/`tryRead()`/`onmessage`. Calling the wrong method throws.

```javascript
// Writer creates the buffer
const writer = new SABPipe('w');

// Reader attaches to the same buffer
const reader = new SABPipe('r', writer.buffer);
```

### Writer API

#### `writer.postMessage(msg)` → `Promise`

Queues a JSON-serializable message for sending. Returns a promise that resolves when the batch is written. Multiple calls are batched — see [`SABMessagePort.postMessage`](#portpostmessagemsg--promise) for details.

```javascript
writer.postMessage({ hello: 'world' });
```

### Reader API

All read methods share the same return-value convention:

- **`maxMessages = 1`** (default): returns a single message or `null`.
- **`maxMessages > 1`**: returns an **array** of messages ordered **newest-first, oldest-last**, or an **empty array** `[]` if no data. `pop()` to process in FIFO order.

#### `reader.read(timeout = Infinity, blocking = true, maxMessages = 1)`

Synchronous read. **Worker threads only** (uses `Atomics.wait`).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `Infinity` | Max wait time in ms. Ignored when non-blocking. |
| `blocking` | `true` | If `false`, returns immediately without waiting. |
| `maxMessages` | `1` | Max messages to return. |

Timeout only applies to the initial wait. Multipart messages (large payloads that span multiple chunks) always wait for all parts once the first part arrives.

#### `await reader.asyncRead(timeout = Infinity, maxMessages = 1)`

Async read using `Atomics.waitAsync`. **Safe on the main thread.**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `Infinity` | Max wait time in ms. |
| `maxMessages` | `1` | Max messages to return. |

#### `reader.tryRead(maxMessages = 1)`

Non-blocking read. Equivalent to `reader.read(0, false, maxMessages)`. Returns immediately.

#### `reader.onmessage`

Event-driven handler. Setting a function starts a continuous async read loop; setting `null` stops it. Handler receives `{ data: message }`. See [`SABMessagePort.onmessage`](#portonmessage) for full behavior details (mutual exclusion, error resilience, re-assignment).

### Shared

#### `pipe.close()` / `pipe.destroy()`

Disposes the channel and unblocks any waiting readers/writers. After disposal, all read/write operations throw `'SABPipe disposed'`. Safe to call multiple times.

#### `pipe.isDisposed()` → `boolean`

Returns `true` if the pipe has been disposed (by either side).

---

## Message Batching

When the writer side calls `postMessage()` multiple times in quick succession (without awaiting), messages are **batched** into a single payload and sent together over the shared buffer. On the reader side, these batched messages are unpacked into an internal queue and delivered one at a time.

This means a single `read()` or `asyncRead()` call may populate the internal queue with multiple messages. Subsequent reads return immediately from the queue without waiting on the shared buffer. Use `maxMessages > 1` to retrieve multiple queued messages in one call.

```javascript
// Writer side: 3 messages batched into one payload
writer.postMessage({ id: 0 });
writer.postMessage({ id: 1 });
writer.postMessage({ id: 2 });

// Reader side: first read waits for data, gets all 3 into the queue
const msg0 = reader.read();   // { id: 0 } — waited for data
const msg1 = reader.read();   // { id: 1 } — returned immediately from queue
const msg2 = reader.read();   // { id: 2 } — returned immediately from queue

// Or get all at once (newest first — pop() for FIFO)
const msgs = reader.read(Infinity, true, 10); // [{ id: 2 }, { id: 1 }, { id: 0 }]
msgs.pop(); // { id: 0 } — oldest
msgs.pop(); // { id: 1 }
msgs.pop(); // { id: 2 } — newest
```

## Large Messages & Chunking

Messages larger than the buffer's data section are automatically split into chunks (multipart messages) and reassembled on the reader side. This is fully transparent — no API changes needed regardless of message size.

During a multipart read, timeout is suspended: once the first chunk arrives, the reader waits indefinitely for remaining chunks to ensure the full message is received.

The maximum single-chunk size is `bufferSize - 32 bytes` (32 bytes are reserved for control fields). For the default 128 KB pipe, that's ~131 KB per chunk.

---

## Performance

Benchmarked on a single machine, Node.js worker threads, 1000 messages (~757 KB total):

| Mode | Avg Latency | Throughput |
|------|-------------|------------|
| Blocking read (`Atomics.wait`) | ~19 us/msg | ~39 MB/s |
| Async read (`Atomics.waitAsync`) | ~27 us/msg | ~27 MB/s |

Sustained throughput (3 second run, ~500 byte messages):

| Mode | Messages/sec | Throughput |
|------|-------------|------------|
| Blocking read | ~59,000 msg/s | ~30 MB/s |
| Async read | ~50,000 msg/s | ~25 MB/s |

Blocking reads are faster because `Atomics.wait` wakes with lower latency than the async event loop. Use blocking reads in worker threads for maximum performance; use async reads on the main thread or when you need to interleave with other async work.

## Requirements

- Node.js >= 16 or any browser with `SharedArrayBuffer` support
- `SharedArrayBuffer` requires [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements) headers in browsers

## License

[BSD-3-Clause](LICENSE)
