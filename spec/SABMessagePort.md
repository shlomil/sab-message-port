# SABPipe, SABMessagePort & MWChannel Specification

SharedArrayBuffer communication library with three layers:
- **SABPipe** — Unidirectional channel with buffered queues and promise-based write completion
- **SABMessagePort** — Bidirectional wrapper over two SABPipe instances (mirrors native `MessagePort` API)
- **MWChannel** — Hybrid main↔worker channel combining native MessagePort with SABPipe for switchable blocking/nonblocking modes

## Overview

SABPipe provides a unidirectional, race-free communication channel over SharedArrayBuffer. It is designed for main thread ↔ worker communication in the Lobo toolkit (rpc_sab, evt_sab, dbg_sab).

### Design Principles

- **Role-based**: Each endpoint is either a writer (`'w'`) or reader (`'r'`)
- **Non-blocking writes**: Writer never blocks; uses async waitAsync only
- **Buffered queues**: Messages queue on both sides for batch processing
- **Promise chaining**: Write batches automatically chain for continuous throughput
- **Multipart support**: Large payloads are chunked transparently

### Terminology

| Term | Definition |
|------|------------|
| **fresh-write** | New message (not mid-multipart) — previous write was single or last part of multipart |
| **fresh-read** | Not mid-multipart read — previous read was single or last part of multipart |

---

## Memory Layout

Default total size: 128 KB (131,072 bytes). Configurable via `sabOrSize` and `sectionSize` constructor parameters.

| Byte Offset | Int32 Index | Field | Description |
|-------------|-------------|-------|-------------|
| 0 | 0 | `status` | `STATUS_ACTIVE=0`, `STATUS_DISPOSED=0xFFFFFFFF` |
| 4 | 1 | `rw_signal` | `0=RW_CAN_WRITE`, `1=RW_CAN_READ`, `STATUS_DISPOSED=0xFFFFFFFF` |
| 8 | 2 | `w_data_len` | Length of data in bytes |
| 12 | 3 | `num_parts` | Total parts (1 for single-part, >1 for multipart) |
| 16 | 4 | `part_index` | Current part index (0-based) |
| 20 | 5 | `reserved1` | Reserved for future use |
| 24 | 6 | `reserved2` | Reserved for future use |
| 28 | 7 | `reserved3` | Reserved for future use |
| 32..end | — | `data` | JSON payload region (size − 32 bytes) |

### Constants

```javascript
static STATUS = 0;
static RW_SIGNAL = 1;
static W_DATA_LEN = 2;
static NUM_PARTS = 3;
static PART_INDEX = 4;
static CONTROL_TOP = 8;
static DATA_OFFSET = 32;  // 8 * 4 bytes

static STATUS_ACTIVE = 0;
static STATUS_DISPOSED = 0xFFFFFFFF;

static RW_CAN_WRITE = 0;
static RW_CAN_READ = 1;
```

---

## RW Protocol

### Writer: Low-level `_asyncWrite()`

**Preconditions:**
- Check `isWriter` role
- Check SAB is not disposed, throw if so
- `_payload_in_progress = null` initialized in constructor

**Steps:**

1. **Guard**: If `_writing` is true, return immediately (send already in progress). Set `_writing = true`.

2. **Wait for buffer**: `waitAsync` for `rw_signal == RW_CAN_WRITE`

3. **Check disposed**: If `rw_signal == STATUS_DISPOSED`, throw error

4. **Check queue**: If `write_queue` is empty, return (nothing to write)

5. **Fresh write setup**:
   - Move `write_queue` to `_payload_in_progress`
   - Break payload into chunks
   - Create new empty `write_queue`
   - Chain next batch: `_payload_in_progress.finishWritePromise.then(() => { if (write_queue.queue.length > 0) _asyncWrite() })`

6. **Multipart continuation**: Else select next part of `_payload_in_progress`

7. **Write data**: Copy JSON stringified payload (or chunk) to data region

8. **Write metadata**:
   - `num_parts` = 1 (single) or >1 (multipart)
   - `part_index` = 0..num_parts-1
   - `w_data_len` = byte length of chunk

9. **Signal reader**: `rw_signal = RW_CAN_READ`

10. **Notify**: `Atomics.notify(rw_signal)`

11. **Multipart loop**: If multipart and more parts remain:
    - `waitAsync` for `rw_signal == RW_CAN_WRITE`
    - Go to step 2 for next part

12. **Cleanup** (in `finally` block, always clears `_writing = false`):
    - `tmp = _payload_in_progress`
    - `_payload_in_progress = null`
    - Resolve `tmp.finishWritePromise` (after clearing to prevent stale chaining)

---

### Reader: Low-level `_read()` (synchronous, worker-thread only)

**Preconditions:**
- Check `isReader` role
- Check SAB is not disposed, throw if so

**Steps:**

1. **Wait for data**:
   - Blocking: `Atomics.wait` for `rw_signal == RW_CAN_READ`
   - Non-blocking: Check value, continue if not ready

2. **Check disposed**: If `rw_signal == STATUS_DISPOSED`, throw error

3. **Read length**: `w_data_len` = byte length of data

4. **Read data**: Parse JSON from data region

5. **Read metadata**: `num_parts`, `part_index` for multipart handling

6. **Signal writer**: `rw_signal = RW_CAN_WRITE`

7. **Notify**: `Atomics.notify(rw_signal)`

8. **Multipart loop**: If `part_index < num_parts - 1`:
   - Go to step 1 for next part
   - No timeout allowed mid-multipart

9. **Reconstruct**: If multipart, combine all chunks

10. **Queue**: Parse payload, reverse, prepend to `read_queue`

### Timeout Support

- Timeout allowed only on **fresh-read** (step 1, first part)
- During multipart: wait indefinitely to ensure complete message
- Prevents partial/corrupted message delivery

---

### Reader: Low-level `_asyncRead()` (async, main-thread safe)

Mirror of `_read()` using `Atomics.waitAsync` instead of `Atomics.wait`, following the same
pattern as `_asyncWrite()` / `_waitForCanWrite()`.

**Why needed:**
- `Atomics.wait` is forbidden on the main thread (throws `TypeError`)
- An async reader allows the main thread to receive SAB messages without blocking
- Symmetry: writer already uses `_asyncWrite()` with `waitAsync`; reader needs the same

**Preconditions:**
- Check `isReader` role
- Check SAB is not disposed, throw if so
- Guard: if `_reading` is true, return immediately (prevents concurrent reads)

**Helper: `_waitForCanRead(timeout)`**

Mirrors `_waitForCanWrite()`. Spins on `Atomics.waitAsync` until `rw_signal == RW_CAN_READ`:

```javascript
async _waitForCanRead(timeout = Infinity) {
  const deadline = timeout === Infinity ? Infinity : Date.now() + timeout;
  while (true) {
    const signal = Atomics.load(this.i32, this.c.RW_SIGNAL);

    if (signal === this.c.RW_CAN_READ) return true;       // data available
    if (signal === this.c.STATUS_DISPOSED) this._checkDisposed();

    // Calculate remaining time for this wait iteration
    const remaining = deadline === Infinity ? Infinity : Math.max(0, deadline - Date.now());
    if (remaining === 0) return false;                      // timed out

    // Note: Atomics.waitAsync's timeout doesn't keep the Node.js event loop alive,
    // so we use Promise.race with setTimeout for finite timeouts.
    const result = Atomics.waitAsync(this.i32, this.c.RW_SIGNAL, signal);
    if (result.async) {
      if (remaining === Infinity) {
        await result.value;
      } else {
        const outcome = await Promise.race([
          result.value,
          new Promise(r => setTimeout(() => r('timed-out'), remaining))
        ]);
        if (outcome === 'timed-out') return false;
      }
    }
    // loop: re-check signal (handles spurious wakeups)
  }
}
```

**Steps:**

1. **Guard**: If `_reading` is true, return immediately (concurrent read in progress)
2. Set `_reading = true`
3. **Wait for data**: `await _waitForCanRead(timeout)` — timeout only on fresh-read (first part)
   - If returns `false` (timeout / no data), set `_reading = false`, return false
4. **Check disposed**: If `rw_signal == STATUS_DISPOSED`, throw error
5. **Read metadata**: `w_data_len`, `num_parts`, `part_index`
6. **Read data chunk**: Copy bytes from data region (`u8.slice`)
7. **Signal writer**: `Atomics.store(rw_signal, RW_CAN_WRITE)` + `Atomics.notify(rw_signal)`
8. **Multipart loop**: If `part_index < num_parts - 1`:
   - `await _waitForCanRead()` (no timeout — must complete multipart)
   - Repeat steps 4–7 for next part
9. **Reconstruct**: If multipart, combine all chunks into single byte array
10. **Queue**: Parse JSON payload, reverse, prepend to `read_queue`
11. Set `_reading = false`
12. Return `true`

**Concurrency guard (`_reading` flag):**

Same pattern as `_asyncWrite()` uses `_writing`:
- Prevents two concurrent `_asyncRead()` calls from interleaving chunk reads
- If `_asyncRead()` is already in progress, new call returns immediately
  (caller should retry or rely on the in-progress read to populate `read_queue`)

**Error handling (try/finally):**

```javascript
async _asyncRead(timeout = Infinity) {
  if (!this.isReader) throw new Error('Only reader can read');
  this._checkDisposed();
  if (this._reading) return false;
  this._reading = true;
  try {
    // steps 3–10 ...
  } finally {
    this._reading = false;
  }
}
```

**Key differences from `_read()`:**

| Aspect | `_read()` | `_asyncRead()` |
|--------|-----------|-----------------|
| Wait primitive | `Atomics.wait` (blocks thread) | `Atomics.waitAsync` (yields to event loop) |
| Thread safety | Worker threads only | Main thread + worker threads |
| Concurrency guard | None needed (blocking) | `_reading` flag (like `_writing` for writes) |
| Return type | `boolean` (sync) | `Promise<boolean>` (async) |
| Multipart mid-wait | Blocks indefinitely | Awaits indefinitely (non-blocking to event loop) |

---

## Promise Chaining

Each `write_queue` has an associated promise structure:

```javascript
{
  queue: [],                    // pending messages
  finishWritePromise,           // resolves when batch is fully written
  finishWriteResolveFunc,       // resolve callback
  finishWriteRejectFunc         // reject callback
}
```

### Chain Flow

1. `postMessage(msg)` pushes to `write_queue`, calls `_asyncWrite().catch(() => {})` (fire-and-forget), returns `finishWritePromise`

2. `_asyncWrite()` moves queue to `_payload_in_progress`, creates NEW `write_queue`

3. Chain is set up: `_payload_in_progress.finishWritePromise.then(() => { if (write_queue.queue.length > 0) _asyncWrite().catch(() => {}) })`

4. When current batch completes, `.then()` fires and triggers next batch

5. Multiple rapid `postMessage()` calls accumulate in the new queue, sent together in next batch

### Promise Resolution Order

```javascript
// Step 12 of _asyncWrite():
tmp = _payload_in_progress;
_payload_in_progress = null;      // clear first
tmp.finishWriteResolveFunc();     // then resolve
```

Clearing before resolving ensures chained `_asyncWrite()` sees `_payload_in_progress == null` and proceeds correctly.

**Note:** Both fire-and-forget `_asyncWrite()` calls (in `postMessage()` and the `.then()` chain) append `.catch(() => {})` to prevent unhandled rejections when the channel is disposed mid-write.

---

## Multipart Messages

Large payloads exceeding `maxChunk` (buffer size - 32 bytes) are automatically split.

### Writer Side

```javascript
_json_to_chunks(payload) {
  const bytes = encoder.encode(JSON.stringify(payload));
  const numParts = Math.ceil(bytes.length / maxChunk);
  // split into chunks...
}
```

- First chunk: sets up promise chain, writes metadata
- Subsequent chunks: waits for `RW_CAN_WRITE` between each
- Reader must ack each chunk before next is sent

### Reader Side

- Collects chunks into array
- After last chunk (`part_index == num_parts - 1`), combines and parses
- No timeout during multipart to prevent corruption

---

## Disposal

### `destroy()` Method

```javascript
destroy() {
  if (this.i32 === null) return;  // already destroyed

  // Set all control words to DISPOSED
  for (let i = 0; i < CONTROL_TOP; i++) {
    Atomics.store(this.i32, i, STATUS_DISPOSED);
  }

  // Wake all waiters
  for (let i = 0; i < CONTROL_TOP; i++) {
    Atomics.notify(this.i32, i, Infinity);
  }

  // Nullify references
  this.i32 = null;
  this.u8 = null;
  this._sab = null;
}
```

### Disposal Handling

- After waking from `wait`/`waitAsync`, check `rw_signal == STATUS_DISPOSED`
- If disposed, throw `Error('SABPipe disposed')`
- Ensures blocked threads are unblocked and can clean up gracefully

---

## High-Level API

### `postMessage(jsonMessage)` → `Promise`

```javascript
// Write a single message (non-blocking queue + send)
postMessage(jsonMessage) {
  // 1. Push message to write_queue
  // 2. Call _asyncWrite().catch(() => {}) — fire and forget
  // 3. Return write_queue.finishWritePromise
}
```

- Main thread can call multiple times without awaiting
- Promise resolves when message (batch) is fully written

### `read(timeout, blocking = true, max_num_messages = 1)` (worker-thread only)

```javascript
// Synchronous read — blocks with Atomics.wait
read(timeout, blocking = true, max_num_messages = 1) {
  // If read_queue has messages: return immediately (up to max)
  // If non-blocking and RW_CAN_READ: call _read(), return from queue
  // If blocking: call _read(timeout), return from queue
}
```

**Return values:**
- `max_num_messages == 1`: Returns single message or `null`
- `max_num_messages > 1`: Returns array of messages (may be empty)

**Queue order:**
- `read_queue` is ordered newest-first
- Pop from end returns oldest message (FIFO delivery)

### `tryRead(max_num_messages = 1)`

```javascript
// Non-blocking read - returns immediately with available messages
tryRead(max_num_messages = 1) {
  return this.read(0, false, max_num_messages);
}
```

- Convenience wrapper for non-blocking reads
- Returns `null` (if `max_num_messages == 1`) or empty array (if `> 1`) when no messages available

### `tryPeek()` → `*|null`

```javascript
// Non-blocking peek - returns the next message without removing it from the queue
tryPeek() {
  // 1. Check reader role and onmessage mutual exclusion
  // 2. Check disposed
  // 3. If read_queue is empty, attempt a non-blocking _read(false, 0) to populate it
  // 4. Return read_queue[length - 1] (oldest = next to be processed) without popping, or null
}
```

- Returns the next message that `read()` or `tryRead()` would return, **without removing it** from the queue
- If the queue is empty, performs a non-blocking low-level `_read(false, 0)` to check for new data in the SAB
- Returns `null` if no messages are available
- Always returns a single message (no `max_num_messages` parameter)
- Subject to `onmessage` mutual exclusion (throws if `onmessage` is active)

### `asyncRead(timeout, max_num_messages = 1)` → `Promise` (main-thread safe)

```javascript
// Async read — uses waitAsync, never blocks the thread
async asyncRead(timeout = Infinity, max_num_messages = 1) {
  // If read_queue has messages: return immediately (up to max)
  // Else: await _asyncRead(timeout) to populate read_queue
  // Return from queue (may be null/empty if timeout)
}
```

- Same return semantics as `read()`: single message/`null` (max=1) or array (max>1)
- Safe to call from main thread (no `Atomics.wait`)
- Timeout applies only to the initial wait (fresh-read); multipart waits are unbounded

### `isDisposed()` → `boolean`

```javascript
isDisposed() {
  return this.i32 === null || this.i32[STATUS] === STATUS_DISPOSED;
}
```

- Returns `true` if the pipe has been destroyed locally or disposed by the other side
- Does **not** throw — safe to call at any time as a status check

### `close()` / `destroy()`

```javascript
close() { this.destroy(); }
```

- `close()` is an alias for `destroy()`, provided for API consistency with `SABMessagePort`
- Sets all control words to `STATUS_DISPOSED`, wakes all waiters, nullifies typed array views

### `onmessage` (property — reader only, main-thread safe)

Event-driven message handler. Mirrors the Web API `MessagePort.onmessage` pattern.

```javascript
reader.onmessage = (e) => {
  console.log('got:', e.data);
};

// Later: stop receiving
reader.onmessage = null;
```

**Property setter: `set onmessage(handler)`**

```javascript
set onmessage(handler) {
  if (!this.isReader) throw new Error('Only reader can set onmessage');
  this._onmessage = handler ?? null;

  // Start loop if handler set and loop not already running
  if (handler !== null && !this._messageLoopActive) {
    this._messageLoop();  // fire-and-forget (no await)
  }
}

get onmessage() {
  return this._onmessage;
}
```

**Internal: `_messageLoop()` (async, runs continuously)**

```javascript
async _messageLoop() {
  if (this._messageLoopActive) return;
  this._messageLoopActive = true;

  try {
    while (this._onmessage !== null) {
      // 1. Drain all queued messages first
      while (this._read_queue.length > 0 && this._onmessage !== null) {
        const msg = this._read_queue.pop();
        try {
          this._onmessage({ data: msg });
        } catch (e) {
          // Handler error does not break the loop
        }
      }

      if (this._onmessage === null) break;

      // 2. Wait for new data (no timeout — waits until data or disposal)
      await this._asyncRead();
      // _asyncRead populates _read_queue; loop drains it on next iteration
    }
  } catch (err) {
    // Channel disposed — loop stops silently
  } finally {
    this._messageLoopActive = false;
  }
}
```

**Behavior:**

| Aspect | Detail |
|--------|--------|
| Handler signature | `handler(event)` — receives `{ data: message }`, matching the native `MessageEvent` pattern |
| Multiple messages | Batch writes produce multiple queued messages; handler is called once per message, oldest first (FIFO) |
| Handler errors | Caught and ignored — loop continues delivering subsequent messages |
| Setting to `null` | Loop checks `_onmessage` before each handler invocation and before each `_asyncRead()`. If `null`, loop exits |
| Pending read on `null` | If `_asyncRead()` is awaiting data when `onmessage` is set to `null`, the loop exits after the current `_asyncRead` resolves (next message arrival or disposal). No handler is called for that message |
| Re-assignment | Setting a new handler while loop is active: handler swaps immediately (next message uses new handler). No loop restart needed |
| Channel disposal | Loop catches the disposal error and exits cleanly. `_messageLoopActive` is cleared via `finally` |

**Mutual exclusion with manual reads:**

When `onmessage` is active, calling `read()`, `tryRead()`, `tryPeek()`, or `asyncRead()` throws an error — they would compete for the same `_read_queue`.

```javascript
// In read(), tryRead(), tryPeek(), asyncRead():
if (this._onmessage !== null) {
  throw new Error('Cannot call read/tryPeek/asyncRead while onmessage is active');
}
```

---

## Constructor

```javascript
constructor(role, sabOrSize = 131072, byteOffset = 0, sectionSize = null) {
  this._sab = (typeof sabOrSize === 'number')
    ? new SharedArrayBuffer(sabOrSize)
    : sabOrSize;

  const size = sectionSize ?? (this._sab.byteLength - byteOffset);

  this.i32 = new Int32Array(this._sab, byteOffset, size >> 2);
  this.u8 = new Uint8Array(this._sab, byteOffset, size);
  this.maxChunk = size - DATA_OFFSET;

  if (role === 'w') {
    this.isWriter = true;
    this.isReader = false;
    this._write_queue = this._create_write_queue();
    this._payload_in_progress = null;
    this._writing = false;
  } else if (role === 'r') {
    this.isWriter = false;
    this.isReader = true;
    this._read_queue = [];
    this._reading = false;
    this._onmessage = null;
    this._messageLoopActive = false;
  } else {
    throw new Error("Invalid role: must be 'r' or 'w'");
  }
}
```

**Parameters:**
- `role` (required): `'w'` for writer, `'r'` for reader
- `sabOrSize` (optional): Existing SharedArrayBuffer or byte size (default: 128 KB)
- `byteOffset` (optional): Starting byte position in the SAB (default: 0). Must be 4-byte aligned.
- `sectionSize` (optional): Size of this section in bytes (default: remaining SAB from offset)

All existing code uses the typed array views (`i32`, `u8`), never the raw SAB, so offset support requires no changes beyond the constructor.

---

## Implementation Notes

- Private methods/values prefixed with `_` (not public API)
- Avoid exposing word indices and bit flags in public API
- Use higher-level abstractions instead
- All writer operations are async (`_asyncWrite` uses `Atomics.waitAsync` only)
- Reader has two paths:
  - `_read()` — synchronous, uses `Atomics.wait` (worker threads only)
  - `_asyncRead()` — async, uses `Atomics.waitAsync` (main thread safe)
- Both reader paths share the same `_read_queue` and `_popMessages()` logic

---

## SABMessagePort

Bidirectional communication wrapper over two SABPipe instances sharing a single SharedArrayBuffer.

### Overview

A single SAB is split into two equal sections. Each side gets a writer on one section and a reader on the other, providing full-duplex messaging over shared memory.

```
SharedArrayBuffer (256 KB total)
┌──────────────────────────┬──────────────────────────┐
│  Section A (128 KB)      │  Section B (128 KB)      │
│  Side 'a' writes here    │  Side 'b' writes here    │
│  Side 'b' reads here     │  Side 'a' reads here     │
└──────────────────────────┴──────────────────────────┘
         byteOffset 0              sectionSize
```

| Side | Writer section | Reader section |
|------|---------------|----------------|
| `'a'` (initiator) | A (offset 0) | B (offset sectionSize) |
| `'b'` (responder) | B (offset sectionSize) | A (offset 0) |

### Constructor

```javascript
constructor(side = 'a', sabOrSizeKB = 256)
```

**Parameters:**
- `side` (optional): `'a'` (initiator/first) or `'b'` (responder/second). Default: `'a'`.
  Typically the initiator uses the default and the responder is created via `SABMessagePort.from()`, so this parameter rarely needs to be specified explicitly.
- `sabOrSizeKB` (optional): Total size in KB (number) or existing SharedArrayBuffer.
  Default: `256` (256 KB total, each section 128 KB — matches SABPipe's default)

**Size handling:**
- If number: treated as KB. Must be a power of 2 (64, 128, 256, 512, ...). Creates a new SAB of `sabOrSizeKB * 1024` bytes.
- If SharedArrayBuffer: used directly. Size must be a power of 2 in KB.
- Section size: always `totalBytes / 2`. Each section is a self-contained SABPipe region.

**Internal construction:**

```javascript
constructor(side = 'a', sabOrSizeKB = 256) {
  if (side !== 'a' && side !== 'b') throw new Error("side must be 'a' or 'b'");

  this._sab = (typeof sabOrSizeKB === 'number')
    ? new SharedArrayBuffer(sabOrSizeKB * 1024)
    : sabOrSizeKB;

  const sectionSize = this._sab.byteLength / 2;

  if (side === 'a') {
    this._writer = new SABPipe('w', this._sab, 0, sectionSize);
    this._reader = new SABPipe('r', this._sab, sectionSize, sectionSize);
  } else {
    this._reader = new SABPipe('r', this._sab, 0, sectionSize);
    this._writer = new SABPipe('w', this._sab, sectionSize, sectionSize);
  }
}
```

### Serialization: `postInit(target?, extraProps?)`

Sends the SAB and layout info to the other side via native `postMessage`, or returns
the arguments array for manual sending. Includes the SAB in the transfer list.

```javascript
postInit(target = null, extraProps = {}) {
  const msg = [
    { type: 'SABMessagePort', buffer: this._sab, ...extraProps },
    [this._sab]
  ];
  if (target === null) return msg;
  target.postMessage(...msg);
}
```

**Parameters:**
- `target` (optional): Any object with `.postMessage(data, transfer)` (Worker, MessagePort, window, etc.).
  If `null`, returns `[data, transfer]` — the arguments array that would have been passed to `postMessage`,
  allowing the caller to send it manually: `target.postMessage(...port.postInit(null, extras))`.
- `extraProps` (optional): Additional properties merged into the init message

**Examples — initiator (main thread):**

```javascript
// Simple: auto-send
const port = new SABMessagePort();
port.postInit(worker, { channelName: 'rpc', workerId: 42 });

// Manual: get args, send yourself (e.g. with transfer list or custom target)
const port = new SABMessagePort();
const args = port.postInit(null, { channelName: 'rpc' });
worker.postMessage(...args);

port.onmessage = (e) => console.log('from worker:', e.data);
port.postMessage({ hello: 'world' });
```

### Factory: `SABMessagePort.from(initMsg)`

Static factory that creates the responder side from a received init message.

```javascript
static from(initMsg) {
  if (initMsg?.type !== 'SABMessagePort') {
    throw new Error('Not a SABMessagePort init message');
  }
  return new SABMessagePort('b', initMsg.buffer);
}
```

**Example — responder (worker):**

```javascript
self.onmessage = (e) => {
  if (e.data.type === 'SABMessagePort') {
    const port = SABMessagePort.from(e.data);
    // e.data.channelName, e.data.workerId — extra props accessible from original message

    port.onmessage = (e) => console.log('from main:', e.data);
    port.postMessage({ reply: 'hello back' });
  }
};
```

### High-Level API

All methods delegate to the internal reader/writer SABPipe instances.

**Writer methods (delegate to `this._writer`):**

```javascript
postMessage(jsonMessage) {
  return this._writer.postMessage(jsonMessage);
}
```

**Reader methods (delegate to `this._reader`):**

```javascript
set onmessage(handler) { this._reader.onmessage = handler; }
get onmessage()        { return this._reader.onmessage; }

asyncRead(timeout, max_num_messages) {
  return this._reader.asyncRead(timeout, max_num_messages);
}

read(timeout, blocking, max_num_messages) {
  return this._reader.read(timeout, blocking, max_num_messages);
}

tryRead(max_num_messages) {
  return this._reader.tryRead(max_num_messages);
}

tryPeek() {
  return this._reader.tryPeek();
}
```

**Lifecycle:**

```javascript
close() {
  this._writer.destroy();
  this._reader.destroy();
}

get buffer() {
  return this._sab;
}
```

### Full Usage Example

```javascript
// === Main thread ===
import { SABMessagePort } from './SABMessagePort.js';

const port = new SABMessagePort('a');          // 256 KB default
port.postInit(worker, { channel: 'rpc' });         // send SAB + transfer list to worker

port.onmessage = (e) => {
  console.log('worker says:', e.data);             // { reply: 'pong' }
};
port.postMessage({ cmd: 'ping' });

// === Worker ===
self.onmessage = (e) => {
  if (e.data.type === 'SABMessagePort') {
    const port = SABMessagePort.from(e.data);  // auto-creates side 'b'

    port.onmessage = (e) => {
      if (e.data.cmd === 'ping') {
        port.postMessage({ reply: 'pong' });
      }
    };
  }
};
```

---

## MWChannel

Hybrid communication channel that combines a native `MessagePort` with a `SABPipe`, giving the worker side a choice between non-blocking (MessagePort) and blocking (SABPipe) receive modes at runtime.

### Overview

MWChannel addresses a common pattern where the main thread needs to send messages to a worker that may operate in either a blocking event-loop (using `Atomics.wait`) or a standard async event-loop. The worker always sends back via native `MessagePort` (non-blocking), while the main thread's send path depends on the current mode.

```
Main thread                          Worker thread
┌─────────────────────┐              ┌─────────────────────┐
│                     │──SABPipe────▶│  (blocking mode)    │
│  MWChannel('m')     │              │  MWChannel('w')     │
│                     │──MsgPort────▶│  (nonblocking mode) │
│                     │◀──MsgPort───│  (always MsgPort)   │
└─────────────────────┘              └─────────────────────┘
```

| Direction | Transport | Notes |
|-----------|-----------|-------|
| Main → Worker (blocking mode) | SABPipe | Worker can use `read()`, `tryRead()`, `tryPeek()`, `asyncRead()` |
| Main → Worker (nonblocking mode) | Native MessagePort | Worker receives via `onmessage` |
| Worker → Main (always) | Native MessagePort | Main receives via `onmessage` |

### Design Principles

- **Asymmetric by design**: Main thread never blocks; worker can choose to block
- **Single SABPipe direction**: Only main→worker uses SharedArrayBuffer (one SABPipe writer on main, one SABPipe reader on worker)
- **Runtime mode switching**: Worker can switch between blocking and nonblocking receive modes via `setMode()`
- **Drain on mode switch**: When switching from blocking to nonblocking, any messages remaining in the SABPipe read queue are drained and delivered to the `onmessage` handler

### Constructor

```javascript
constructor(side, sabSizeKB = 128)
```

**Parameters:**
- `side` (required): `'m'` (main thread) or `'w'` (worker thread)
- `sabSizeKB` (optional): SABPipe buffer size in KB (default: 128). Only used on the main side (creates the SharedArrayBuffer).

**Internal construction (main side):**

```javascript
constructor('m', sabSizeKB = 128) {
  this._sab = new SharedArrayBuffer(sabSizeKB * 1024);
  this._channel = new MessageChannel();
  this._nativePort = this._channel.port1;
  this._sabWriter = new SABPipe('w', this._sab);
  this._mode = 'blocking';       // default mode
  this._onmessage = null;
  this._pendingDrain = [];
}
```

The worker side is not constructed directly — it is created via `MWChannel.from()`.

### Factory: `MWChannel.from(initMsg)`

Static factory that creates the worker side from a received init message.

```javascript
static from(initMsg) {
  if (initMsg?.type !== 'MWChannel') {
    throw new Error('Not a MWChannel init message');
  }
  const mw = new MWChannel('w');
  mw._sab = initMsg.buffer;
  mw._nativePort = initMsg.port;
  mw._sabReader = new SABPipe('r', mw._sab);
  mw._nativePort.start();
  return mw;
}
```

- Creates a worker-side MWChannel with a SABPipe reader and the transferred MessagePort
- Calls `port.start()` to begin receiving native messages (needed for transferred MessagePort instances)

### Serialization: `postInit(target?, extraProps?)`

Sends the SAB, a MessagePort, and layout info to the worker via native `postMessage`.

```javascript
postInit(target = null, extraProps = {}) {
  const port2 = this._channel.port2;
  const msg = { type: 'MWChannel', buffer: this._sab, port: port2, ...extraProps };
  const transfer = [port2];
  if (target === null) return [msg, transfer];
  target.postMessage(msg, transfer);
}
```

**Parameters:**
- `target` (optional): Object with `.postMessage(data, transfer)` (Worker, etc.). If `null`, returns `[msg, transfer]` for manual sending.
- `extraProps` (optional): Additional properties merged into the init message

**Note:** Main-side only. The transfer list includes `port2` (the worker's end of the MessageChannel).

### High-Level API

#### `postMessage(msg)`

```javascript
postMessage(msg) {
  if (side === 'm') {
    // blocking mode: send via SABPipe (returns Promise)
    // nonblocking mode: send via native MessagePort (returns undefined)
  } else {
    // worker: always sends via native MessagePort (returns undefined)
  }
}
```

- **Main side**: Uses SABPipe in blocking mode (returns a `Promise` that resolves when written), or native MessagePort in nonblocking mode (returns `undefined`)
- **Worker side**: Always uses native MessagePort regardless of mode

#### `onmessage` (property)

```javascript
set onmessage(handler) { ... }
get onmessage() { return this._onmessage; }
```

- **Main side**: Delegates directly to the native MessagePort's `onmessage`. Always available.
- **Worker side**: Only available in **nonblocking** mode. Throws if set in blocking mode.
  - When a handler is set, any pending drain messages (from a blocking→nonblocking mode switch) are delivered immediately before attaching to the native port.

#### `read(timeout, blocking, max_num_messages)` — worker, blocking mode only

```javascript
read(timeout, blocking, max_num_messages) {
  // Delegates to this._sabReader.read(...)
}
```

- Worker side only. Throws if called from main side or in nonblocking mode.
- Same semantics as `SABPipe.read()`

#### `tryRead(max_num_messages)` — worker, blocking mode only

```javascript
tryRead(max_num_messages) {
  // Delegates to this._sabReader.tryRead(...)
}
```

- Worker side only. Throws if called from main side or in nonblocking mode.
- Same semantics as `SABPipe.tryRead()`

#### `tryPeek()` — worker, blocking mode only

```javascript
tryPeek() {
  // Delegates to this._sabReader.tryPeek()
}
```

- Worker side only. Throws if called from main side or in nonblocking mode.
- Same semantics as `SABPipe.tryPeek()`

#### `asyncRead(timeout, max_num_messages)` — worker, blocking mode only

```javascript
asyncRead(timeout, max_num_messages) {
  // Delegates to this._sabReader.asyncRead(...)
}
```

- Worker side only. Throws if called from main side or in nonblocking mode.
- Same semantics as `SABPipe.asyncRead()`

### Mode Switching: `setMode(mode)`

```javascript
setMode(mode)  // mode: 'blocking' | 'nonblocking'
```

Switches the channel's operating mode. No-op if already in the requested mode.

**Main side:**
- Simply updates `this._mode`, which controls whether `postMessage()` uses SABPipe or native MessagePort.

**Worker side — switching to nonblocking:**
1. Drains all remaining messages from the SABPipe read queue via `tryRead()` into `_pendingDrain`
2. Sets mode to `'nonblocking'`
3. When `onmessage` is subsequently set, pending drain messages are delivered first (FIFO), then the native port handler is attached

**Worker side — switching to blocking:**
1. Detaches `onmessage` handler from native port (sets to `null`)
2. Sets mode to `'blocking'`

**Important:** The drain mechanism ensures no messages are lost during the transition from SABPipe-based reads to MessagePort-based `onmessage` delivery.

### Lifecycle

```javascript
close() {
  // Main: destroys SABPipe writer, closes native port
  // Worker: destroys SABPipe reader, closes native port
}

get buffer() {
  return this._sab;
}
```

- `close()` destroys the SABPipe endpoint and closes the native MessagePort
- `buffer` returns the underlying SharedArrayBuffer

### Full Usage Example

```javascript
// === Main thread ===
import { MWChannel } from './SABMessagePort.js';

const ch = new MWChannel('m');
ch.postInit(worker, { channel: 'events' });

// Receive from worker (always via native MessagePort)
ch.onmessage = (e) => {
  console.log('worker says:', e.data);
};

// Send to worker (via SABPipe in blocking mode)
ch.postMessage({ cmd: 'start' });

// === Worker ===
import { MWChannel } from './SABMessagePort.js';

self.onmessage = (e) => {
  if (e.data.type === 'MWChannel') {
    const ch = MWChannel.from(e.data);

    // Blocking mode (default) — synchronous reads
    const msg = ch.read(5000);      // blocks up to 5s
    ch.postMessage({ reply: 'got it' });

    // Peek without consuming
    const next = ch.tryPeek();      // null if nothing pending

    // Switch to async event-driven mode
    ch.setMode('nonblocking');
    ch.onmessage = (e) => {
      console.log('from main:', e.data);
    };
  }
};
```
