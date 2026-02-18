/**
 * SABPipe — High-level SharedArrayBuffer communication channel.
 *
 * Unified layout for all Lobo SABs (rpc_sab, evt_sab, dbg_sab):
 *
 *   Byte offset   Int32 index   Field
 *   ───────────────────────────────────────────────────────────────
 *   0             0             status             (STATUS_ACTIVE=0, STATUS_DISPOSED=0xFFFFFFFF)
 *   4             1             rw_signal          (0=RW_CAN_WRITE (IDLE state, empty buffer), 1=RW_CAN_READ, STATUS_DISPOSED=0xFFFFFFFF)
 *   8             2             w_data_len         (0=no new data, else length of data)
 *   12            3             num_parts          (for multipart messages, total number of parts; 1 for single-part)
 *   16            4             part_index
 *   20            5             reserved1
 *   24            6             reserved2
 *   28            7             reserved3
 *   32..131071    —             data (JSON payload)
 *
 *  RW protocol:
 *
 *  Terms:
 *    - use the terms "read"/"write" for external API.
 *    - fresh-write = new message (not in the middle of multipart session) - previous write was single or last part of multipart session
 *    - fresh-read = not in the middle of multipart read session - previous read was single or last part of multipart session
 *
 *  Writer low level _asyncWrite():
 *  - check role isWriter, check sab is not disposed, throw if so
 *  - The payload to write is the entire write_queue:
 *  - writer has access to write_queue { queue, finishWritePromise , finishWriteResolveFunc, finishWriteRejectFunc }
 *  - No timeouts, all code is async
 *  - _payload_in_progress = null is initialized in the class constructor for the use of this function.
 *  - Writer writes data (non-blocking, all actions with async):
 *              1. if _payload_in_progress != null then return immediately (without awaiting)
 *              2. waitAsync for rw_signal=0 (RW_CAN_WRITE) if needed
 *              3. if rw_signal=STATUS_DISPOSED, throw error
 *              4. if write_queue is empty, return immediately (nothing to write)
 *              5. if fresh-write then
 *                 - move write_queue to _payload_in_progress, break it to parts and create new empty write_queue
 *                 - chain the writing of payloads
 *                   _payload_in_progress.finishWritePromise.then(() => {if _write_queue.queue.length > 0) _asyncWrite()})
 *                   so that next payload is written immediately after current one finishes
 *              6. else: select next part of _payload_in_progress to be written
 *              7. write data  (JSON stringified payload or parts of it)
 *              8. num_parts=1 (1 for single or >1 for multipart)
 *              9. part_index  (0..num_parts-1 for multipart, always 0 for single part)
 *              10. w_data_len  (length of data, written to data field)
 *              11. rw_signal=1 (W_CAN_READ)
 *              12. notify rw_signal
 *  -           13. if multipart: - writer can now wait (waitAsync only) for rw_signal=0 (RW_CAN_WRITE) before writing next part.
 *                               - go to step 2 for next part until all parts written
 *              14. tmp = _payload_in_progress
 *              15. _payload_in_progress = null
 *              16. resolve tmp.finishWritePromise resolve only after payload is cleared so new _write invocation
 *                  don't chain the current payload anymore
 *
 *  Reader: (low level _read or _tryRead):
 *  - Reader reads data (try Read or blocking Read):
 *              1. wait for rw_signal=1 (RW_CAN_READ) or just check value and continue for non-blocking
 *              2. if rw_signal=STATUS_DISPOSED, throw error
 *              3. read w_data_len to get length of data
 *              4. read data (JSON string) and parse
 *              5. read num_parts and part_index for multipart handling - message reconstruction if needed
 *              6. set rw_signal=0 (RW_CAN_WRITE) to indicate buffer is consumed and ready for next message
 *              7. notify rw_signal
 *              8. if multipart and part_index<num_parts-1, goto [step 1] and repeat for next part until all parts read
 *              9. if multipart, after last part is read reconstruct full payload
 *              10. parse the payload , reverse it, append the current read_queue to it and set it as the new read_queue.
 * - Timeout Support: in blocking-read, reader can specify timeout for waiting on rw_signal in [step 1] iff not in the
 *                    middle of multipart session (e.g. previous read was a single part or last part in a multipart
 *                    session). During multipart session, reader waits indefinitely for each part to ensure full message
 *                    is received.
 *
 *
 *
 * Reader/Writer Disposal: The dispose() method will set rw_signal to STATUS_DISPOSED and notify all waiters, ensuring that they are
 *             unblocked and can check the disposed state.
 *             After being woken up from waitAsync or wait, reader or writer should check if rw_signal
 *             is STATUS_DISPOSED and throw error if so. This ensures that any thread waiting for a message or
 *             waiting for buffer availability will be properly notified of disposal and can handle it gracefully.
 *
 * Higher level buffered/Queues read/write methods:
 *
 *
 * async postMessage(jsonMessage) :
 *    // write a single message
 *  - queue (push) the jsonMessage into write_queue
 *  - call low level _asyncWrite() to write the entire queue without await (so main thread can call postMessage multiple times without awaiting)
 *  - return write_queue.finishWritePromise that resolves when the message is fully sent
 *
 *
 * read(timeout, blocking = true, max_num_messages=1) -> jsonMessage:
 *    // reads (pop) a single message from read queue, or multiple messages if available and requested, up to max_num_messages
 *    // if blocking is false, timeout is ignored and method returns immediately with available messages up to max_num_messages or null if no messages available
 *    // if max_num_messages!=1 returns an array of messages, or empty array if no messages available,
 *    //   otherwise returns a single message or null if no messages available
 *    // the read_queue is ordered newest first, poping from the end of the array returns the oldest message.
 *    // if array is returned, it should take a slice off the end of the read_queue up to max_num_messages and return it, removing those messages from the read_queue
 *  - if there are messages in read_queue, return the next max_num_messages immediately (non-blocking)
 *  - else in not blocking and rw_signal=RW_CAN_READ call _read() to read the message and return the first max_num_messages messages in the read_queue
 *  - else if blocking call _read(timeout) to read the messages and return the first max_num_messages message in the read_queue
 *
 * Implementation notes:
 *  - private methods and values are prefixed with _ to indicate they are not part of the public API.
 *  - if possible, avoid exposing word indices and bit flags in the public API, use higher level abstractions instead.
 * 
 */


const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

// Debug logging - set to true to enable
const MYLOG_ON = false;
const mylog = MYLOG_ON ? (...args) => console.log('[SABPipe]', ...args) : () => {};




// ════════════════════════════════════════════════════════════════
// SABPipe — Core channel implementation
// ════════════════════════════════════════════════════════════════

export class SABPipe {


  static STATUS = 0;
  static RW_SIGNAL = 1;
  static W_DATA_LEN = 2;
  static NUM_PARTS = 3;
  static PART_INDEX = 4;
  static RESERVED_1 = 5;
  static RESERVED_2 = 6;
  static RESERVED_3 = 7;
  static CONTROL_TOP = 8; // number of Int32 control fields (status, flags, metadata)
  static DATA_OFFSET = 8 * 4; // byte offset where data starts (after control fields)

  static STATUS_ACTIVE = 0;
  static STATUS_DISPOSED = -1;  // 0xFFFFFFFF as signed int32

  static RW_CAN_WRITE = 0;
  static RW_CAN_READ = 1;


  constructor(role, sabOrSize = 131072, byteOffset = 0, sectionSize = null, queueLimit = null) {  // 128 KB default
    this._sab = typeof sabOrSize === 'number'
        ? new SharedArrayBuffer(sabOrSize)
        : sabOrSize;
    const size = sectionSize ?? (this._sab.byteLength - byteOffset);
    this.i32 = new Int32Array(this._sab, byteOffset, size >> 2);
    this.u8 = new Uint8Array(this._sab, byteOffset, size);
    this.maxChunk = size - SABPipe.DATA_OFFSET;
    if (role === 'w') {
      this.isWriter = true;
      this.isReader = false;
      this._write_queue = this._create_write_queue();
      this._read_queue = null;
      this._payload_in_progress = null;
      this._writing = false;
    } else if (role === 'r') {
      this.isWriter = false;
      this.isReader = true;
      this._read_queue = [];
      this._write_queue = null;
      this._reading = false;
      this._onmessage = null;
      this._messageLoopActive = false;
    } else throw new Error("Invalid role parameter: must be 'r' or 'w'");
    this._queueLimit = queueLimit;
    this._onQueueOverflow = null;
    this._max_chunk = size - SABPipe.DATA_OFFSET;
  }

  c = this.constructor; // for easier access to static fields

  isDisposed() {
    return this.i32 === null || this.i32[this.c.STATUS] === this.c.STATUS_DISPOSED;
  }

  _checkDisposed() {
    if (this.isDisposed()) {
      this.i32 = null;
      this.u8 = null;
      this._sab = null;
      throw new Error('SABPipe disposed');
    }
  }

  destroy() {
    if (this.i32 === null) return; // already destroyed

    //wake every possible waiting thread (reader or writer) to unblock them on dispose
    for (let i = 0; i < this.c.CONTROL_TOP; i++) {
      Atomics.store(this.i32, i, this.c.STATUS_DISPOSED);
    }

    for (let i = 0; i < this.c.CONTROL_TOP; i++) {
      Atomics.notify(this.i32, i, Infinity);
    }
    this.i32 = null;
    this.u8 = null;
    this._sab = null;
  }

  close() {
    this.destroy();
  }

  get queueLimit() {
    return this._queueLimit;
  }

  get onQueueOverflow() {
    return this._onQueueOverflow;
  }

  set onQueueOverflow(handler) {
    this._onQueueOverflow = handler ?? null;
  }

  set queueLimit(value) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error('queueLimit must be null or a non-negative integer');
    }
    this._queueLimit = value;
    if (value !== null) {
      if (this.isWriter && this._write_queue.queue.length > value) {
        if (this._onQueueOverflow) this._onQueueOverflow(this._write_queue.queue);
        if (this._write_queue.queue.length > value) {
          this._write_queue.queue.splice(0, this._write_queue.queue.length - value);
        }
      }
      if (this.isReader && this._read_queue && this._read_queue.length > value) {
        if (this._onQueueOverflow) this._onQueueOverflow(this._read_queue);
        if (this._read_queue.length > value) {
          this._read_queue.length = value;
        }
      }
    }
  }

  _enforceQueueLimit() {
    if (this._queueLimit !== null && this._read_queue.length > this._queueLimit) {
      if (this._onQueueOverflow) this._onQueueOverflow(this._read_queue);
      if (this._read_queue.length > this._queueLimit) {
        this._read_queue.length = this._queueLimit;
      }
    }
  }

  _create_write_queue() {
    let resolveFunc, rejectFunc;
    const finishWritePromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    return { queue: [], finishWritePromise, finishWriteResolveFunc: resolveFunc, finishWriteRejectFunc: rejectFunc };
  }

  _json_to_chunks(payload) {
    const bytes = _encoder.encode(JSON.stringify(payload));
    let chunks = [];
    const numParts = Math.ceil(bytes.length / this._max_chunk) || 1;
    for (let i = 0; i < numParts; i++) {
      const chunk = bytes.subarray(i * this._max_chunk, (i + 1) * this._max_chunk);
      chunks.push(chunk);
    }
    return chunks;
  }


  /**
   * Low-level write implementation. Sends entire write_queue as a single payload.
   * Non-blocking (uses waitAsync only).
   */
  async _asyncWrite() {
    if (!this.isWriter) throw new Error('Only writer can write');
    this._checkDisposed();

    // Step 1: If already writing, return immediately (chaining handles continuation)
    if (this._writing) {
      mylog('_write: already in progress, returning');
      return;
    }
    this._writing = true;

    try {
      // Step 2: Wait for buffer to be available
      mylog('_write: waiting for can write');
      await this._waitForCanWrite();
      mylog('_write: can write now');

      // Step 3: Check disposed after waking
      if (Atomics.load(this.i32, this.c.RW_SIGNAL) === this.c.STATUS_DISPOSED) {
        this._checkDisposed();
      }

      // Step 4: If queue is empty, nothing to write
      if (this._write_queue.queue.length === 0) {
        return;
      }

      // Step 5: Fresh write - move queue to _payload_in_progress
      this._payload_in_progress = this._write_queue;
      this._payload_in_progress.chunks = this._json_to_chunks(this._payload_in_progress.queue);
      this._payload_in_progress.currentPart = 0;

      // Create new write_queue for incoming messages during send
      this._write_queue = this._create_write_queue();

      // Chain: when this payload finishes, send next batch if any
      this._payload_in_progress.finishWritePromise.then(() => {
        if (this._write_queue.queue.length > 0) {
          this._asyncWrite().catch(() => {}); // catch to prevent unhandled rejection on disposal
        }
      });

      // Send all parts
      const numParts = this._payload_in_progress.chunks.length;

      for (let partIndex = 0; partIndex < numParts; partIndex++) {
        // For parts after the first, wait for reader to consume previous part
        if (partIndex > 0) {
          await this._waitForCanWrite();

          // Check disposed after waking
          if (Atomics.load(this.i32, this.c.RW_SIGNAL) === this.c.STATUS_DISPOSED) {
            this._checkDisposed();
          }
        }

        // Step 7: Write data chunk
        const chunk = this._payload_in_progress.chunks[partIndex];
        this.u8.set(chunk, this.c.DATA_OFFSET);

        // Steps 8-10: Write metadata (regular writes - faster than Atomics)
        this.i32[this.c.NUM_PARTS] = numParts;
        this.i32[this.c.PART_INDEX] = partIndex;
        this.i32[this.c.W_DATA_LEN] = chunk.length;

        // Steps 11-12: Signal reader and notify
        // Atomics.store provides release semantics - ensures all above writes are visible
        mylog(`_write: signaling RW_CAN_READ, part ${partIndex}/${numParts}`);
        Atomics.store(this.i32, this.c.RW_SIGNAL, this.c.RW_CAN_READ);
        Atomics.notify(this.i32, this.c.RW_SIGNAL, 1);
      }

      // Steps 14-16: Clear payload and resolve promise
      mylog('_write: all parts sent, resolving promise');
      const tmp = this._payload_in_progress;
      this._payload_in_progress = null;
      tmp.finishWriteResolveFunc();
    } finally {
      this._writing = false;
    }
  }

  /**
   * Wait for rw_signal to become RW_CAN_WRITE (0).
   * Uses Atomics.waitAsync for non-blocking async wait.
   */
  async _waitForCanWrite() {
    while (true) {
      const signal = Atomics.load(this.i32, this.c.RW_SIGNAL);

      if (signal === this.c.RW_CAN_WRITE) {
        return; // Buffer is available
      }

      if (signal === this.c.STATUS_DISPOSED) {
        this._checkDisposed();
      }

      // Wait for signal to change
      const result = Atomics.waitAsync(this.i32, this.c.RW_SIGNAL, signal);
      if (result.async) {
        await result.value;
      }
    }
  }

  /**
   * Low-level read implementation. Reads from SAB and populates read_queue.
   * @param {boolean} blocking - If true, uses Atomics.wait (worker thread only)
   * @param {number} timeout - Timeout in ms (only for fresh-read, not mid-multipart)
   * @returns {boolean} - true if data was read, false if timeout/no data (non-blocking)
   */
  _read(blocking = true, timeout = Infinity) {
    if (!this.isReader) throw new Error('Only reader can read');
    this._checkDisposed();

    mylog(`_read: starting, blocking=${blocking}, timeout=${timeout}`);

    const chunks = [];
    let numParts = 1;
    let isFirstPart = true;

    // Read all parts (single loop iteration for single-part messages)
    while (true) {
      // Step 1: Wait for data to be available
      const signal = Atomics.load(this.i32, this.c.RW_SIGNAL);
      mylog(`_read: signal=${signal}, RW_CAN_READ=${this.c.RW_CAN_READ}`);

      if (signal === this.c.STATUS_DISPOSED) {
        this._checkDisposed();
      }

      if (signal !== this.c.RW_CAN_READ) {
        if (!blocking) {
          mylog('_read: non-blocking, no data');
          return false;
        }

        // Blocking: wait for signal
        // Only use timeout on first part (fresh-read)
        const waitTimeout = isFirstPart ? timeout : Infinity;
        mylog(`_read: entering Atomics.wait, signal=${signal}, timeout=${waitTimeout}`);
        const result = Atomics.wait(this.i32, this.c.RW_SIGNAL, signal, waitTimeout);
        mylog(`_read: Atomics.wait returned ${result}`);

        if (result === 'timed-out') {
          mylog('_read: timed out');
          return false;
        }

        // Re-check after waking
        const newSignal = Atomics.load(this.i32, this.c.RW_SIGNAL);
        mylog(`_read: after wake, newSignal=${newSignal}`);
        if (newSignal === this.c.STATUS_DISPOSED) {
          this._checkDisposed();
        }

        if (newSignal !== this.c.RW_CAN_READ) {
          mylog('_read: spurious wakeup, retrying');
          continue; // Spurious wakeup, retry
        }
      }

      // Steps 3-5: Read metadata (regular reads - safe after Atomics.wait acquire)
      const dataLen = this.i32[this.c.W_DATA_LEN];
      numParts = this.i32[this.c.NUM_PARTS];
      const partIndex = this.i32[this.c.PART_INDEX];

      // Step 4: Read data chunk (copy to avoid issues when buffer is reused)
      const chunk = this.u8.slice(this.c.DATA_OFFSET, this.c.DATA_OFFSET + dataLen);
      chunks.push(chunk);

      // Steps 6-7: Signal writer and notify
      // Atomics.store provides release semantics
      mylog(`_read: got part ${partIndex}/${numParts}, len=${dataLen}, signaling RW_CAN_WRITE`);
      Atomics.store(this.i32, this.c.RW_SIGNAL, this.c.RW_CAN_WRITE);
      Atomics.notify(this.i32, this.c.RW_SIGNAL, 1);

      isFirstPart = false;

      // Step 8: Check if more parts to read
      if (partIndex >= numParts - 1) {
        mylog('_read: last part received');
        break; // Last part received
      }

      // Continue loop for next part (no timeout - must complete multipart)
    }

    // Step 9: Reconstruct payload if multipart
    let payloadBytes;
    if (chunks.length === 1) {
      payloadBytes = chunks[0];
    } else {
      // Combine all chunks
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      payloadBytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        payloadBytes.set(chunk, offset);
        offset += chunk.length;
      }
    }

    // Step 10: Parse payload, reverse, prepend to read_queue
    const messages = JSON.parse(_decoder.decode(payloadBytes));

    // messages is the queue array sent by writer
    // Reverse so oldest is at the end (for FIFO pop)
    messages.reverse();

    // Prepend to read_queue (new messages at front, oldest at end)
    this._read_queue = messages.concat(this._read_queue);
    this._enforceQueueLimit();

    return true;
  }

  /**
   * Wait for rw_signal to become RW_CAN_READ (1).
   * Uses Atomics.waitAsync for non-blocking async wait.
   * @param {number} timeout - Timeout in ms (Infinity = wait forever)
   * @returns {Promise<boolean>} - true if data available, false if timed out
   */
  async _waitForCanRead(timeout = Infinity) {
    const deadline = timeout === Infinity ? Infinity : Date.now() + timeout;
    while (true) {
      const signal = Atomics.load(this.i32, this.c.RW_SIGNAL);

      if (signal === this.c.RW_CAN_READ) {
        return true; // Data is available
      }

      if (signal === this.c.STATUS_DISPOSED) {
        this._checkDisposed();
      }

      // Calculate remaining time for this wait iteration
      const remaining = deadline === Infinity ? Infinity : Math.max(0, deadline - Date.now());
      if (remaining === 0) return false; // timed out

      // Wait for signal to change
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
      // loop: re-check signal (handles spurious wakeups and value changes)
    }
  }

  /**
   * Low-level async read implementation. Reads from SAB and populates read_queue.
   * Uses waitAsync — safe for main thread. Mirrors _read() logic.
   * @param {number} timeout - Timeout in ms (only for fresh-read, not mid-multipart)
   * @returns {Promise<boolean>} - true if data was read, false if timeout/no data
   */
  async _asyncRead(timeout = Infinity) {
    if (!this.isReader) throw new Error('Only reader can read');
    this._checkDisposed();

    // Guard: prevent concurrent async reads from interleaving
    if (this._reading) {
      mylog('_asyncRead: already in progress, returning');
      return false;
    }
    this._reading = true;

    try {
      mylog(`_asyncRead: starting, timeout=${timeout}`);

      const chunks = [];
      let isFirstPart = true;

      // Read all parts (single loop iteration for single-part messages)
      while (true) {
        // Step 1: Wait for data to be available
        // Only use timeout on first part (fresh-read)
        const waitTimeout = isFirstPart ? timeout : Infinity;
        mylog(`_asyncRead: waiting for can read, timeout=${waitTimeout}`);
        const ready = await this._waitForCanRead(waitTimeout);

        if (!ready) {
          mylog('_asyncRead: timed out or no data');
          return false;
        }

        // Step 2: Check disposed after waking
        if (Atomics.load(this.i32, this.c.RW_SIGNAL) === this.c.STATUS_DISPOSED) {
          this._checkDisposed();
        }

        // Steps 3-5: Read metadata
        const dataLen = this.i32[this.c.W_DATA_LEN];
        const numParts = this.i32[this.c.NUM_PARTS];
        const partIndex = this.i32[this.c.PART_INDEX];

        // Step 6: Read data chunk (copy to avoid issues when buffer is reused)
        const chunk = this.u8.slice(this.c.DATA_OFFSET, this.c.DATA_OFFSET + dataLen);
        chunks.push(chunk);

        // Steps 7-8: Signal writer and notify
        mylog(`_asyncRead: got part ${partIndex}/${numParts}, len=${dataLen}, signaling RW_CAN_WRITE`);
        Atomics.store(this.i32, this.c.RW_SIGNAL, this.c.RW_CAN_WRITE);
        Atomics.notify(this.i32, this.c.RW_SIGNAL, 1);

        isFirstPart = false;

        // Step 9: Check if more parts to read
        if (partIndex >= numParts - 1) {
          mylog('_asyncRead: last part received');
          break; // Last part received
        }

        // Continue loop for next part (no timeout - must complete multipart)
      }

      // Step 10: Reconstruct payload if multipart
      let payloadBytes;
      if (chunks.length === 1) {
        payloadBytes = chunks[0];
      } else {
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        payloadBytes = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          payloadBytes.set(chunk, offset);
          offset += chunk.length;
        }
      }

      // Step 11: Parse payload, reverse, prepend to read_queue
      const messages = JSON.parse(_decoder.decode(payloadBytes));
      messages.reverse();
      this._read_queue = messages.concat(this._read_queue);
      this._enforceQueueLimit();

      return true;
    } finally {
      this._reading = false;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // High-level API
  // ════════════════════════════════════════════════════════════════

  /**
   * Write a message to the channel.
   * Non-blocking - queues message and returns promise that resolves when sent.
   * @param {*} jsonMessage - JSON-serializable message
   * @returns {Promise} - Resolves when the message batch is fully written
   */
  postMessage(jsonMessage) {
    if (!this.isWriter) throw new Error('Only writer can write');
    this._checkDisposed();

    // Push message to queue
    this._write_queue.queue.push(jsonMessage);

    // Enforce queue limit — discard oldest (front) messages
    if (this._queueLimit !== null && this._write_queue.queue.length > this._queueLimit) {
      if (this._onQueueOverflow) this._onQueueOverflow(this._write_queue.queue);
      if (this._write_queue.queue.length > this._queueLimit) {
        this._write_queue.queue.splice(0, this._write_queue.queue.length - this._queueLimit);
      }
    }

    // Save promise BEFORE _asyncWrite() might replace _write_queue
    const promise = this._write_queue.finishWritePromise;

    // Trigger send (no await - fire and forget; catch to prevent unhandled rejection on disposal)
    this._asyncWrite().catch(() => {});

    // Return promise that resolves when this batch is sent
    return promise;
  }

  /**
   * Read message(s) from the channel.
   * @param {number} timeout - Timeout in ms (ignored if non-blocking)
   * @param {boolean} blocking - If true, blocks until data available (worker thread only)
   * @param {number} max_num_messages - Maximum messages to return
   * @returns {*|null|Array} - Single message/null (max=1) or array of messages (max>1)
   */
  read(timeout = Infinity, blocking = true, max_num_messages = 1) {
    if (!this.isReader) throw new Error('Only reader can read');
    if (this._onmessage !== null) throw new Error('Cannot call read while onmessage is active');
    this._checkDisposed();

    // If queue has messages, return immediately
    if (this._read_queue.length > 0) {
      return this._popMessages(max_num_messages);
    }

    // Try to read from SAB
    this._read(blocking, timeout);

    // Return from queue (may be empty if timeout or no data)
    return this._popMessages(max_num_messages);
  }

  /**
   * Non-blocking read - returns immediately with available messages.
   * @param {number} max_num_messages - Maximum messages to return
   * @returns {*|null|Array} - Single message/null (max=1) or array of messages (max>1)
   */
  tryRead(max_num_messages = 1) {
    return this.read(0, false, max_num_messages);
  }

  /**
   * Non-blocking peek - returns the next message without removing it from the queue.
   * If the queue is empty, attempts a non-blocking read from the SAB first.
   * @returns {*|null} - The next message, or null if no data available
   */
  tryPeek() {
    if (!this.isReader) throw new Error('Only reader can peek');
    if (this._onmessage !== null) throw new Error('Cannot call tryPeek while onmessage is active');
    this._checkDisposed();
    if (this._read_queue.length === 0) {
      this._read(false, 0);
    }
    return this._read_queue.length > 0 ? this._read_queue[this._read_queue.length - 1] : null;
  }

  /**
   * Async read message(s) from the channel. Main-thread safe.
   * @param {number} timeout - Timeout in ms
   * @param {number} max_num_messages - Maximum messages to return
   * @returns {Promise<*|null|Array>} - Single message/null (max=1) or array of messages (max>1)
   */
  async asyncRead(timeout = Infinity, max_num_messages = 1) {
    if (!this.isReader) throw new Error('Only reader can read');
    if (this._onmessage !== null) throw new Error('Cannot call asyncRead while onmessage is active');
    this._checkDisposed();

    // If queue has messages, return immediately
    if (this._read_queue.length > 0) {
      return this._popMessages(max_num_messages);
    }

    // Async read from SAB
    await this._asyncRead(timeout);

    // Return from queue (may be empty if timeout or no data)
    return this._popMessages(max_num_messages);
  }

  /**
   * Event-driven message handler. Mirrors the Web API MessagePort.onmessage pattern.
   * Setting a handler starts a continuous async read loop; setting null stops it.
   * @param {Function|null} handler - handler(message) called for each received message
   */
  set onmessage(handler) {
    if (!this.isReader) throw new Error('Only reader can set onmessage');
    this._onmessage = handler ?? null;

    // Start loop if handler set and loop not already running
    if (handler !== null && !this._messageLoopActive) {
      this._messageLoop(); // fire-and-forget (no await)
    }
  }

  get onmessage() {
    return this._onmessage;
  }

  /**
   * Internal message loop. Continuously reads messages and dispatches to onmessage handler.
   * Runs until onmessage is set to null or channel is disposed.
   */
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

  /**
   * Pop messages from read_queue.
   * @param {number} max - Maximum messages to pop
   * @returns {*|null|Array} - Single message/null (max=1) or array (max>1)
   */
  _popMessages(max) {
    if (max === 1) {
      // Return single message or null
      return this._read_queue.length > 0 ? this._read_queue.pop() : null;
    } else {
      // Return array of messages (FIFO - oldest first)
      const count = Math.min(max, this._read_queue.length);
      if (count === 0) return [];
      // Pop from end (oldest messages)
      return this._read_queue.splice(-count);
    }
  }
}


// ════════════════════════════════════════════════════════════════
// SABMessagePort — Bidirectional wrapper over two SABPipe instances
// ════════════════════════════════════════════════════════════════

export class SABMessagePort {

  constructor(side = 'a', sabOrSizeKB = 256, queueLimit = null) {
    if (side !== 'a' && side !== 'b') throw new Error("side must be 'a' or 'b'");

    this._sab = (typeof sabOrSizeKB === 'number')
      ? new SharedArrayBuffer(sabOrSizeKB * 1024)
      : sabOrSizeKB;

    const sectionSize = this._sab.byteLength / 2;

    if (side === 'a') {
      this._writer = new SABPipe('w', this._sab, 0, sectionSize, queueLimit);
      this._reader = new SABPipe('r', this._sab, sectionSize, sectionSize, queueLimit);
    } else {
      this._reader = new SABPipe('r', this._sab, 0, sectionSize, queueLimit);
      this._writer = new SABPipe('w', this._sab, sectionSize, sectionSize, queueLimit);
    }
  }

  static from(initMsg, queueLimit = null) {
    if (initMsg?.type !== 'SABMessagePort') {
      throw new Error('Not a SABMessagePort init message');
    }
    return new SABMessagePort('b', initMsg.buffer, queueLimit);
  }

  postInit(target = null, extraProps = {}) {
    const msg = [
      { type: 'SABMessagePort', buffer: this._sab, ...extraProps },
      [this._sab]
    ];
    if (target === null) return msg;
    target.postMessage(...msg);
  }

  postMessage(jsonMessage) {
    return this._writer.postMessage(jsonMessage);
  }

  set onmessage(handler) { this._reader.onmessage = handler; }
  get onmessage() { return this._reader.onmessage; }

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

  get queueLimit() {
    return this._writer.queueLimit;
  }

  set queueLimit(value) {
    this._writer.queueLimit = value;
    this._reader.queueLimit = value;
  }

  get onQueueOverflow() {
    return this._writer.onQueueOverflow;
  }

  set onQueueOverflow(handler) {
    this._writer.onQueueOverflow = handler;
    this._reader.onQueueOverflow = handler;
  }

  close() {
    this._writer.destroy();
    this._reader.destroy();
  }

  get buffer() {
    return this._sab;
  }
}


// ════════════════════════════════════════════════════════════════
// MWChannel — MessagePort + SABPipe Wrapper
//
// Combines a native MessagePort with a SABPipe pair, allowing the
// worker side to switch between non-blocking (MessagePort) and
// blocking (SABPipe) receive modes at runtime.
// Main thread always receives via MessagePort (never blocks).
// Worker always sends via MessagePort (worker→main is always non-blocking).
// The SABPipe is one-directional: main→worker only.
// ════════════════════════════════════════════════════════════════

export class MWChannel {

  /**
   * @param {'m'|'w'} side - 'm' (main thread) or 'w' (worker thread)
   * @param {number} sabSizeKB - SABPipe buffer size in KB (default 128). Main side only.
   */
  constructor(side, sabSizeKB = 128, queueLimit = null) {
    if (side !== 'm' && side !== 'w') throw new Error("side must be 'm' or 'w'");
    this._side = side;
    this._mode = 'blocking'; // default: worker starts in blocking mode
    this._onmessage = null;
    this._pendingDrain = [];
    this._queueLimit = queueLimit;
    this._onQueueOverflow = null;

    if (side === 'm') {
      this._sab = new SharedArrayBuffer(sabSizeKB * 1024);
      this._channel = new MessageChannel();
      this._nativePort = this._channel.port1;
      this._sabWriter = new SABPipe('w', this._sab, undefined, undefined, queueLimit);
    }
    // Worker side: _sab, _nativePort, _sabReader initialized by from()
  }

  /**
   * Creates the worker side from a received init message.
   * @param {object} initMsg - Must have type='MWChannel', buffer, port
   */
  static from(initMsg, queueLimit = null) {
    if (initMsg?.type !== 'MWChannel') {
      throw new Error('Not a MWChannel init message');
    }
    const mw = new MWChannel('w');
    mw._queueLimit = queueLimit;
    mw._sab = initMsg.buffer;
    mw._nativePort = initMsg.port;
    mw._sabReader = new SABPipe('r', mw._sab, undefined, undefined, queueLimit);
    mw._nativePort.start();
    return mw;
  }

  /**
   * Sends init message containing the SAB and a MessagePort to the other side.
   * If target is null, returns [msg, transferList] for manual sending.
   */
  postInit(target = null, extraProps = {}) {
    if (this._side !== 'm') throw new Error('postInit is only for main side');
    const port2 = this._channel.port2;
    const msg = { type: 'MWChannel', buffer: this._sab, port: port2, ...extraProps };
    const transfer = [port2];
    if (target === null) return [msg, transfer];
    target.postMessage(msg, transfer);
  }

  /**
   * Send a message.
   * Main: sends via SABPipe (blocking mode) or native MessagePort (nonblocking mode).
   * Worker: always sends via native MessagePort.
   */
  postMessage(msg) {
    if (this._side === 'm') {
      if (this._mode === 'blocking') {
        return this._sabWriter.postMessage(msg);
      } else {
        this._nativePort.postMessage(msg);
      }
    } else {
      this._nativePort.postMessage(msg);
    }
  }

  /**
   * Event handler for incoming messages.
   * Main: always delegates to native MessagePort.onmessage.
   * Worker: only available in nonblocking mode (throws in blocking mode).
   */
  set onmessage(handler) {
    if (this._side === 'm') {
      this._onmessage = handler;
      this._nativePort.onmessage = handler;
    } else {
      if (this._mode === 'blocking') {
        throw new Error('Cannot set onmessage in blocking mode — use read()/tryRead()');
      }
      this._onmessage = handler;
      // Deliver any pending drained messages from mode switch
      if (handler && this._pendingDrain.length > 0) {
        const pending = this._pendingDrain;
        this._pendingDrain = [];
        for (const msg of pending) {
          try { handler({ data: msg }); } catch (e) { /* handler errors don't break setup */ }
        }
      }
      this._nativePort.onmessage = handler;
    }
  }

  get onmessage() {
    return this._onmessage;
  }

  /**
   * Blocking synchronous read from SABPipe. Worker side, blocking mode only.
   */
  read(timeout, blocking, max_num_messages) {
    if (this._side !== 'w') throw new Error('read() is only for worker side');
    if (this._mode !== 'blocking') throw new Error('read() only available in blocking mode');
    return this._sabReader.read(timeout, blocking, max_num_messages);
  }

  /**
   * Non-blocking read from SABPipe. Worker side, blocking mode only.
   */
  tryRead(max_num_messages) {
    if (this._side !== 'w') throw new Error('tryRead() is only for worker side');
    if (this._mode !== 'blocking') throw new Error('tryRead() only available in blocking mode');
    return this._sabReader.tryRead(max_num_messages);
  }

  /**
   * Non-blocking peek from SABPipe. Worker side, blocking mode only.
   */
  tryPeek() {
    if (this._side !== 'w') throw new Error('tryPeek() is only for worker side');
    if (this._mode !== 'blocking') throw new Error('tryPeek() only available in blocking mode');
    return this._sabReader.tryPeek();
  }

  /**
   * Async read from SABPipe. Worker side, blocking mode only.
   */
  asyncRead(timeout, max_num_messages) {
    if (this._side !== 'w') throw new Error('asyncRead() is only for worker side');
    if (this._mode !== 'blocking') throw new Error('asyncRead() only available in blocking mode');
    return this._sabReader.asyncRead(timeout, max_num_messages);
  }

  /**
   * Switch mode.
   * Main: switches send transport ('blocking' = SABPipe, 'nonblocking' = native MessagePort).
   * Worker: switches receive transport ('blocking' = SABPipe reads, 'nonblocking' = MessagePort onmessage).
   */
  setMode(mode) {
    if (mode !== 'blocking' && mode !== 'nonblocking') {
      throw new Error("mode must be 'blocking' or 'nonblocking'");
    }
    if (this._mode === mode) return;

    if (this._side === 'm') {
      this._mode = mode;
    } else {
      // Worker side
      if (mode === 'blocking') {
        // Switching to blocking: detach native port handler
        this._nativePort.onmessage = null;
        this._onmessage = null;
        this._mode = 'blocking';
      } else {
        // Switching to nonblocking: drain SABPipe
        let msg;
        while ((msg = this._sabReader.tryRead()) !== null) {
          this._pendingDrain.push(msg);
        }
        if (this._queueLimit !== null && this._pendingDrain.length > this._queueLimit) {
          if (this._onQueueOverflow) this._onQueueOverflow(this._pendingDrain);
          if (this._pendingDrain.length > this._queueLimit) {
            this._pendingDrain.splice(0, this._pendingDrain.length - this._queueLimit);
          }
        }
        this._mode = 'nonblocking';
      }
    }
  }

  get queueLimit() {
    if (this._side === 'm') return this._sabWriter.queueLimit;
    return this._sabReader.queueLimit;
  }

  set queueLimit(value) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error('queueLimit must be null or a non-negative integer');
    }
    this._queueLimit = value;
    if (this._side === 'm') {
      this._sabWriter.queueLimit = value;
    } else {
      this._sabReader.queueLimit = value;
    }
    if (value !== null && this._pendingDrain.length > value) {
      if (this._onQueueOverflow) this._onQueueOverflow(this._pendingDrain);
      if (this._pendingDrain.length > value) {
        this._pendingDrain.splice(0, this._pendingDrain.length - value);
      }
    }
  }

  get onQueueOverflow() {
    return this._onQueueOverflow;
  }

  set onQueueOverflow(handler) {
    this._onQueueOverflow = handler ?? null;
    if (this._side === 'm') {
      this._sabWriter.onQueueOverflow = handler;
    } else if (this._sabReader) {
      this._sabReader.onQueueOverflow = handler;
    }
  }

  /**
   * Close the channel. Destroys SABPipe and closes native MessagePort.
   */
  close() {
    if (this._side === 'm') {
      this._sabWriter.destroy();
    } else {
      this._sabReader.destroy();
    }
    this._nativePort.close();
  }

  get buffer() {
    return this._sab;
  }
}
