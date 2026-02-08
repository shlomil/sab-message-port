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

---

## SABMessagePort

Bidirectional channel over a single `SharedArrayBuffer`. Both sides can read and write simultaneously — full duplex. API mirrors the native `MessagePort`.

### `new SABMessagePort(side?, sizeKB?)`

Creates a new bidirectional port.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `side` | `'a'` | `'a'` (initiator) or `'b'` (responder). Typically only the initiator is created directly; the responder uses `SABMessagePort.from()`. |
| `sizeKB` | `256` | Total buffer size in KB (split in half between the two directions), or an existing `SharedArrayBuffer`. |

```javascript
const port = new SABMessagePort();        // 256 KB, side 'a'
const port = new SABMessagePort('a', 512); // 512 KB
```

### `SABMessagePort.from(initMsg)`

Creates the responder side from a received init message.

```javascript
// Worker side
self.onmessage = (e) => {
  if (e.data.type === 'SABMessagePort') {
    const port = SABMessagePort.from(e.data);
    // ready to send and receive
  }
};
```

### `port.postInit(target?, extraProps?)`

Sends the shared buffer to the other side, or returns the arguments for manual sending.

```javascript
// Auto-send to worker
port.postInit(worker, { channel: 'rpc' });

// Manual — returns [data, transferList]
const args = port.postInit(null, { channel: 'rpc' });
worker.postMessage(...args);
```

### `port.postMessage(msg)` → `Promise`

Sends a JSON-serializable message. Returns a promise that resolves when the message is written.

```javascript
port.postMessage({ action: 'save', data: [1, 2, 3] });

// Or await confirmation
await port.postMessage({ action: 'save', data: [1, 2, 3] });
```

### `port.onmessage`

Event-driven reader. Mirrors `MessagePort.onmessage`. Set to `null` to stop.

```javascript
port.onmessage = (e) => {
  console.log(e.data); // the received message
};

// Stop listening
port.onmessage = null;
```

### `await port.asyncRead(timeout?, maxMessages?)` → message | null | Array

Async read, safe on the main thread. Waits for a message or until timeout (ms).

```javascript
const msg = await port.asyncRead();        // wait forever
const msg = await port.asyncRead(1000);    // wait up to 1s, returns null on timeout
const msgs = await port.asyncRead(1000, 5); // up to 5 messages, returns array
```

### `port.read(timeout?, blocking?, maxMessages?)` → message | null | Array

**Blocking** synchronous read using `Atomics.wait`. Worker threads only — blocks the thread until a message arrives or timeout expires.

```javascript
const msg = port.read();                    // block until message
const msg = port.read(500);                 // block up to 500ms
const msg = port.read(0, false);            // non-blocking, returns null if empty
```

### `port.tryRead(maxMessages?)` → message | null | Array

Non-blocking read. Returns immediately with available data or `null`.

```javascript
const msg = port.tryRead();
```

### `port.close()`

Disposes both directions. Unblocks any waiting readers/writers.

### `port.buffer` → `SharedArrayBuffer`

The underlying shared buffer.

---

## SABPipe

Unidirectional channel — one end writes, the other reads. Used internally by `SABMessagePort`, but useful on its own when you only need one-way communication.

### `new SABPipe(role, sabOrSize?, byteOffset?, sectionSize?)`

| Parameter | Default | Description |
|-----------|---------|-------------|
| `role` | (required) | `'w'` (writer) or `'r'` (reader) |
| `sabOrSize` | `131072` | Byte size for a new buffer, or existing `SharedArrayBuffer` |
| `byteOffset` | `0` | Starting offset in the SAB |
| `sectionSize` | `null` | Section size in bytes (default: remaining SAB from offset) |

```javascript
// Writer creates the buffer
const writer = new SABPipe('w');

// Reader attaches to the same buffer
const reader = new SABPipe('r', writer.buffer);
```

### Writer API

#### `writer.postMessage(msg)` → `Promise`

```javascript
writer.postMessage({ hello: 'world' });
```

### Reader API

#### `reader.read(timeout?, blocking?, maxMessages?)`

Blocking synchronous read (worker threads only).

#### `await reader.asyncRead(timeout?, maxMessages?)`

Async read, main-thread safe.

#### `reader.tryRead(maxMessages?)`

Non-blocking, returns immediately.

#### `reader.onmessage`

Event-driven handler, same pattern as `SABMessagePort`.

### Shared

#### `pipe.close()` / `pipe.destroy()`

Disposes the channel and unblocks any waiters.

#### `pipe.isDisposed()` → `boolean`

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

Large messages (hundreds of KB) are chunked automatically with no API changes needed.

## Requirements

- Node.js >= 16 or any browser with `SharedArrayBuffer` support
- `SharedArrayBuffer` requires [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements) headers in browsers

## License

BSD
