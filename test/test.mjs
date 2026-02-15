/**
 * SABPipe Node.js Tests
 * Run with: node test_sab_message_port.mjs
 */

import { Worker, isMainThread, parentPort, workerData, MessageChannel } from 'worker_threads';
import { fileURLToPath } from 'url';
import { SABPipe, SABMessagePort, MWChannel } from '../src/SABMessagePort.js';

// Debug logging - set to true to enable
const MYLOG_ON = false;
const mylog = MYLOG_ON ? (...args) => console.error('[test]', ...args) : () => {};

const __filename = fileURLToPath(import.meta.url);

// ════════════════════════════════════════════════════════════════
// Test Framework
// ════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';

function group(name) {
  console.log(`\n${BLUE}[ ${name} ]${RESET}`);
}

function test(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
  } else {
    failed++;
    console.log(`  ${RED}FAIL${RESET} ${name}`);
  }
}

function assertEqual(name, actual, expected) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passed++;
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
  } else {
    failed++;
    console.log(`  ${RED}FAIL${RESET} ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function perf(name, value) {
  console.log(`  ${YELLOW}PERF${RESET} ${name}: ${value}`);
}

function summary() {
  const total = passed + failed;
  const color = failed === 0 ? GREEN : RED;
  console.log(`\n${color}Tests: ${passed}/${total} passed${RESET}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// ════════════════════════════════════════════════════════════════
// Worker Code (runs in worker thread)
// ════════════════════════════════════════════════════════════════

if (!isMainThread) {
  const handlers = {
    // Basic read and echo back via postMessage
    test_read_echo(sab, options) {
      const ch = new SABPipe('r', sab);
      parentPort.postMessage({ status: 'blocking' });
      const msg = ch.read();
      return { received: msg, from: 'worker' };
    },

    // tryRead when no data
    test_try_read_empty(sab, options) {
      const ch = new SABPipe('r', sab);
      const msg = ch.tryRead();
      return { received: msg, wasNull: msg === null };
    },

    // tryRead when data ready (spin until available)
    test_try_read_ready(sab, options) {
      const ch = new SABPipe('r', sab);
      parentPort.postMessage({ status: 'blocking' });
      let msg = null;
      const start = Date.now();
      while (msg === null && Date.now() - start < 2000) {
        msg = ch.tryRead();
      }
      return { received: msg };
    },

    // Read with timeout
    test_read_timeout(sab, options) {
      const ch = new SABPipe('r', sab);
      const timeout = options.timeout || 100;
      const start = Date.now();
      const msg = ch.read(timeout);
      const elapsed = Date.now() - start;
      return { received: msg, elapsed };
    },

    // Read multiple messages
    test_read_multiple(sab, options) {
      const ch = new SABPipe('r', sab);
      const count = options.count || 3;
      const messages = [];
      mylog(`test_read_multiple: sending blocking signal`);
      parentPort.postMessage({ status: 'blocking' });
      mylog(`test_read_multiple: starting reads, count=${count}`);
      for (let i = 0; i < count; i++) {
        mylog(`test_read_multiple: reading #${i}`);
        const msg = ch.read();
        mylog(`test_read_multiple: got #${i}:`, JSON.stringify(msg));
        messages.push(msg);
      }
      mylog(`test_read_multiple: done, returning ${messages.length} messages`);
      return { messages };
    },

    // Read large multipart message
    test_read_multipart(sab, options) {
      const ch = new SABPipe('r', sab);
      parentPort.postMessage({ status: 'blocking' });
      const msg = ch.read(30000); // 30s timeout for large payload
      return {
        received: msg !== null,
        length: msg ? msg.length : 0,
        first: msg ? msg[0] : null,
        last: msg ? msg[msg.length - 1] : null
      };
    },

    // Read throws when disposed
    test_read_disposed(sab, options) {
      const ch = new SABPipe('r', sab);
      parentPort.postMessage({ status: 'blocking' });
      try {
        ch.read(); // Will block, then throw when disposed
        return { threw: false };
      } catch (err) {
        return { threw: true, error: err.message };
      }
    },

    // Performance test: read many messages
    test_perf_read(sab, options) {
      const ch = new SABPipe('r', sab);
      const iterations = options.iterations || 1000;
      let count = 0;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < iterations; i++) {
        const msg = ch.read();
        if (msg && msg.id === i) count++;
      }
      return { count };
    },

    // Read batch messages
    test_read_batch(sab, options) {
      const ch = new SABPipe('r', sab);
      const msg = ch.read();
      return {
        received: msg !== null,
        isArray: Array.isArray(msg),
        length: msg ? msg.length : 0,
        messages: msg
      };
    },

    // Stress: high volume - read N messages, verify order and content
    test_stress_high_volume(sab, options) {
      const ch = new SABPipe('r', sab);
      const count = options.count || 10000;
      let received = 0;
      let orderOk = true;
      let dataOk = true;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < count; i++) {
        const msg = ch.read();
        if (!msg || msg.id !== i) orderOk = false;
        if (!msg || msg.v !== i * 2) dataOk = false;
        received++;
      }
      return { received, orderOk, dataOk };
    },

    // Stress: large payloads - read a single huge message
    test_stress_large_payload(sab, options) {
      const ch = new SABPipe('r', sab);
      parentPort.postMessage({ status: 'blocking' });
      const msg = ch.read(60000);
      if (msg === null) return { received: false, length: 0, valid: false };
      // Verify content
      let valid = true;
      if (!Array.isArray(msg)) {
        valid = false;
      } else {
        for (let i = 0; i < msg.length; i++) {
          if (msg[i] !== i % 256) { valid = false; break; }
        }
      }
      return { received: true, length: msg.length, valid };
    },

    // Stress: mixed sizes - read messages of varying sizes
    test_stress_mixed_sizes(sab, options) {
      const ch = new SABPipe('r', sab);
      const count = options.count || 100;
      let received = 0;
      let allValid = true;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < count; i++) {
        const msg = ch.read(30000);
        if (msg === null) { allValid = false; break; }
        if (msg.id !== i) allValid = false;
        if (msg.payload.length !== msg.expectedLen) allValid = false;
        received++;
      }
      return { received, allValid };
    },

    // Stress: sustained throughput - read for a duration
    test_stress_sustained(sab, options) {
      const ch = new SABPipe('r', sab);
      let count = 0;
      let totalBytes = 0;
      let lastId = -1;
      let orderOk = true;
      parentPort.postMessage({ status: 'blocking' });
      while (true) {
        const msg = ch.read(100);
        if (msg === null) break; // timeout = done
        if (msg.id !== lastId + 1) orderOk = false;
        lastId = msg.id;
        totalBytes += JSON.stringify(msg).length;
        count++;
      }
      return { count, totalBytes, orderOk };
    },

    // Stress: rapid create/destroy - just read one message per channel
    test_stress_lifecycle_read(sab, options) {
      const ch = new SABPipe('r', sab);
      parentPort.postMessage({ status: 'blocking' });
      const msg = ch.read(2000);
      return { received: msg !== null, value: msg };
    },

    // --- Writer handlers for asyncRead tests ---

    async test_async_write_single(sab, options) {
      const ch = new SABPipe('w', sab);
      parentPort.postMessage({ status: 'blocking' });
      await ch.postMessage(options.message || { hello: 'async' });
      return { written: true };
    },

    async test_async_write_multiple(sab, options) {
      const ch = new SABPipe('w', sab);
      const count = options.count || 3;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < count; i++) {
        await ch.postMessage({ id: i, data: `async-msg-${i}` });
      }
      return { written: count };
    },

    async test_async_write_multipart(sab, options) {
      const ch = new SABPipe('w', sab);
      const size = options.size || 50000;
      const payload = [];
      for (let i = 0; i < size; i++) payload.push(i);
      parentPort.postMessage({ status: 'blocking' });
      await ch.postMessage(payload);
      return { written: true, size };
    },

    async test_async_dispose(sab, options) {
      const ch = new SABPipe('w', sab);
      parentPort.postMessage({ status: 'blocking' });
      await new Promise(r => setTimeout(r, options.delay || 100));
      ch.destroy();
      return { disposed: true };
    },

    // --- Writer handlers for asyncRead perf/stress tests ---

    async test_async_write_perf(sab, options) {
      const ch = new SABPipe('w', sab);
      const iterations = options.iterations || 1000;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < iterations; i++) {
        await ch.postMessage(options.testData[i]);
      }
      return { written: iterations };
    },

    async test_async_write_high_volume(sab, options) {
      const ch = new SABPipe('w', sab);
      const count = options.count || 10000;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < count; i++) {
        await ch.postMessage({ id: i, v: i * 2 });
      }
      return { written: count };
    },

    async test_async_write_large_payload(sab, options) {
      const ch = new SABPipe('w', sab);
      const size = options.size || 500000;
      const payload = [];
      for (let i = 0; i < size; i++) payload.push(i % 256);
      parentPort.postMessage({ status: 'blocking' });
      await ch.postMessage(payload);
      return { written: true, size };
    },

    async test_async_write_mixed_sizes(sab, options) {
      const ch = new SABPipe('w', sab);
      const sizes = options.sizes || [];
      const count = sizes.length;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < count; i++) {
        const payload = 'x'.repeat(sizes[i]);
        await ch.postMessage({ id: i, payload, expectedLen: sizes[i] });
      }
      return { written: count };
    },

    async test_async_write_sustained(sab, options) {
      const ch = new SABPipe('w', sab);
      const duration = options.duration || 3000;
      parentPort.postMessage({ status: 'blocking' });
      let count = 0;
      const start = Date.now();
      while (Date.now() - start < duration) {
        await ch.postMessage({ id: count, data: 'x'.repeat(500) });
        count++;
      }
      return { written: count };
    },

    // --- SABMessagePort handlers ---

    async test_bidi_echo(sab, options) {
      const port = new SABMessagePort('b', sab);
      parentPort.postMessage({ status: 'blocking' });
      const msg = await port.asyncRead(5000);
      await port.postMessage({ echo: msg, from: 'worker' });
      return { done: true };
    },

    async test_bidi_write_read(sab, options) {
      const port = new SABMessagePort('b', sab);
      const count = options.count || 5;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < count; i++) {
        await port.postMessage({ id: i, from: 'worker' });
      }
      const echoes = [];
      for (let i = 0; i < count; i++) {
        const msg = await port.asyncRead(5000);
        echoes.push(msg);
      }
      return { written: count, echoes: echoes.length, allOk: echoes.every((m, i) => m.echoId === i) };
    },

    async test_bidi_onmessage(sab, options) {
      const port = new SABMessagePort('b', sab);
      const count = options.count || 3;
      parentPort.postMessage({ status: 'blocking' });
      const received = [];
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('bidi onmessage timeout')), 10000);
        port.onmessage = (e) => {
          received.push(e.data);
          port.postMessage({ echo: e.data.id });
          if (received.length >= count) {
            clearTimeout(timeout);
            port.onmessage = null;
            resolve();
          }
        };
      });
      return { received: received.length, allOk: received.every((m, i) => m.id === i) };
    },

    // --- Round-trip comparison handlers ---

    async test_roundtrip_sab_async(sab, options) {
      const port = new SABMessagePort('b', sab);
      const iterations = options.iterations || 1000;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < iterations; i++) {
        const msg = await port.asyncRead(5000);
        await port.postMessage(msg);
      }
      return { count: iterations };
    },

    async test_roundtrip_sab_blocking(sab, options) {
      const port = new SABMessagePort('b', sab);
      const iterations = options.iterations || 1000;
      parentPort.postMessage({ status: 'blocking' });
      for (let i = 0; i < iterations; i++) {
        const msg = port.read();
        await port.postMessage(msg);
      }
      return { count: iterations };
    },

    // --- tryPeek handlers ---

    test_peek_empty(sab) {
      const reader = new SABPipe('r', sab);
      const peeked = reader.tryPeek();
      return { peeked };
    },

    test_peek_available(sab) {
      const reader = new SABPipe('r', sab);
      // Block until batch arrives (consumes first message, leaves second in queue)
      const marker = reader.read(2000);
      // Peek at second message without consuming
      const peeked = reader.tryPeek();
      // Read should return the same message (now consumed)
      const read = reader.tryRead();
      // Next peek should be null
      const peekAfter = reader.tryPeek();
      return { marker, peeked, read, peekAfter };
    },

    test_peek_repeated(sab) {
      const reader = new SABPipe('r', sab);
      // Block until batch arrives (consumes first message)
      reader.read(2000);
      const peek1 = reader.tryPeek();
      const peek2 = reader.tryPeek();
      const read = reader.tryRead();
      const peek3 = reader.tryPeek();
      return { peek1, peek2, read, peek3 };
    },

    test_peek_bidi(sab) {
      const port = new SABMessagePort('b', sab);
      parentPort.postMessage({ status: 'blocking' });
      // Block until batch arrives (consumes first message)
      port.read(2000);
      const peeked = port.tryPeek();
      const read = port.tryRead();
      const peekAfter = port.tryPeek();
      return { peeked, read, peekAfter };
    }
  };

  // Signal ready, then wait for test command
  parentPort.postMessage({ status: 'ready' });

  parentPort.on('message', async (msg) => {
    const { test: testName, sab, options = {} } = msg;

    // Special handler for native postMessage one-way write perf test
    if (testName === 'test_perf_native_write') {
      const port = msg.port;
      const testData = options.testData;
      const iterations = testData.length;
      for (let i = 0; i < iterations; i++) {
        port.postMessage(testData[i]);
      }
      parentPort.postMessage({ result: { written: iterations } });
      setTimeout(() => process.exit(0), 100);
      return;
    }

    // Special handler for MessagePort perf test
    if (testName === 'test_perf_messageport') {
      const port = msg.port;
      const iterations = options.iterations || 1000;
      let count = 0;
      port.on('message', (data) => {
        count++;
        port.postMessage(data); // echo back
        if (count >= iterations) {
          parentPort.postMessage({ result: { count } });
          setTimeout(() => process.exit(0), 100);
        }
      });
      return;
    }

    // --- MWChannel handlers ---

    if (testName === 'test_mw_blocking_read') {
      try {
        const port = MWChannel.from(msg.mwInit);
        parentPort.postMessage({ status: 'blocking' });
        const m = port.read(5000);
        parentPort.postMessage({ result: { received: m, from: 'worker' } });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (testName === 'test_mw_blocking_multi') {
      try {
        const port = MWChannel.from(msg.mwInit);
        const count = options.count || 3;
        const messages = [];
        parentPort.postMessage({ status: 'blocking' });
        for (let i = 0; i < count; i++) {
          messages.push(port.read(5000));
        }
        parentPort.postMessage({ result: { messages } });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (testName === 'test_mw_worker_sends') {
      try {
        const port = MWChannel.from(msg.mwInit);
        const count = options.count || 3;
        for (let i = 0; i < count; i++) {
          port.postMessage({ id: i, data: `mw-msg-${i}` });
        }
        parentPort.postMessage({ result: { sent: count } });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (testName === 'test_mw_mode_switch') {
      try {
        const port = MWChannel.from(msg.mwInit);
        // Start in blocking mode (default), read one message
        parentPort.postMessage({ status: 'blocking' });
        const blockingMsg = port.read(5000);

        // Switch to nonblocking
        port.setMode('nonblocking');
        const nbReceived = [];
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('mw onmessage timeout')), 5000);
          port.onmessage = (e) => {
            nbReceived.push(e.data);
            if (nbReceived.length >= options.nbCount) {
              clearTimeout(timeout);
              port.onmessage = null;
              resolve();
            }
          };
          // Tell main we're ready for nonblocking messages
          port.postMessage({ status: 'nb_ready' });
        });

        // Switch back to blocking, read one more
        port.setMode('blocking');
        port.postMessage({ status: 'blocking_again' });
        const blockingMsg2 = port.read(5000);

        parentPort.postMessage({ result: {
          blockingMsg,
          nbReceived,
          blockingMsg2
        }});
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (testName === 'test_mw_drain') {
      try {
        const port = MWChannel.from(msg.mwInit);
        // Read one blocking message to sync with main
        parentPort.postMessage({ status: 'blocking' });
        const syncMsg = port.read(5000);

        // Now main will send 3 more SAB messages and then signal us
        // Wait for main to finish writing
        parentPort.postMessage({ status: 'blocking' });
        const goMsg = port.read(5000);

        // Switch to nonblocking — should drain the remaining SAB messages
        port.setMode('nonblocking');
        const drained = [];
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('drain timeout')), 5000);
          port.onmessage = (e) => {
            drained.push(e.data);
            if (drained.length >= options.drainCount) {
              clearTimeout(timeout);
              port.onmessage = null;
              resolve();
            }
          };
        });

        parentPort.postMessage({ result: { syncMsg, goMsg, drained } });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (testName === 'test_roundtrip_mw_blocking') {
      try {
        const port = MWChannel.from(msg.mwInit);
        const iterations = options.iterations || 1000;
        parentPort.postMessage({ status: 'blocking' });
        for (let i = 0; i < iterations; i++) {
          const m = port.read(5000);
          port.postMessage(m);
        }
        parentPort.postMessage({ result: { count: iterations } });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (testName === 'test_mw_peek') {
      try {
        const port = MWChannel.from(msg.mwInit);
        // Block until batch arrives (consumes marker, leaves data in queue)
        port.read(2000);
        const peeked = port.tryPeek();
        const read = port.tryRead();
        const peekAfter = port.tryPeek();
        parentPort.postMessage({ result: { peeked, read, peekAfter } });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (handlers[testName]) {
      try {
        const result = await handlers[testName](sab, options);
        parentPort.postMessage({ result });
      } catch (err) {
        parentPort.postMessage({ error: err.message, stack: err.stack });
      }
    } else {
      parentPort.postMessage({ error: 'Unknown test: ' + testName });
    }

    // Exit after delay to ensure messages sent
    setTimeout(() => process.exit(0), 100);
  });
}

// ════════════════════════════════════════════════════════════════
// Main Thread Tests
// ════════════════════════════════════════════════════════════════

function runWorkerTest(testName, sab, options = {}) {
  // Create worker (no test info in workerData)
  const worker = new Worker(__filename);

  // Promises for different stages
  let readyResolve, blockingResolve, resultResolve, resultReject;
  let testTimeout;

  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  const blockingPromise = new Promise((resolve) => { blockingResolve = resolve; });
  const resultPromise = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });

  worker.on('message', (msg) => {
    mylog(`runWorkerTest(${testName}): got message:`, JSON.stringify(msg));
    if (msg.status === 'ready') {
      readyResolve();
    } else if (msg.status === 'blocking') {
      blockingResolve();
    } else if (msg.result !== undefined) {
      clearTimeout(testTimeout);
      resultResolve(msg.result);
    } else if (msg.error) {
      clearTimeout(testTimeout);
      resultReject(new Error(msg.error));
    }
  });

  worker.on('error', (err) => {
    clearTimeout(testTimeout);
    resultReject(err);
  });

  // Return object with promises for each stage
  return {
    // Wait for worker to be ready, send command, wait for blocking signal
    async ready() {
      mylog(`runWorkerTest(${testName}): waiting for ready`);
      await readyPromise;
      mylog(`runWorkerTest(${testName}): got ready, sending command`);

      // Set timeout for test
      testTimeout = setTimeout(() => {
        worker.terminate();
        resultReject(new Error(`Timeout: ${testName}`));
      }, options.testTimeout || 5000);

      // Send test command
      worker.postMessage({ test: testName, sab, options });

      // Wait for blocking signal if requested
      if (options.waitForBlocking) {
        mylog(`runWorkerTest(${testName}): waiting for blocking`);
        await blockingPromise;
        mylog(`runWorkerTest(${testName}): got blocking signal`);
      }
    },

    // Wait for test result
    result: resultPromise
  };
}

async function runTests() {
  console.log('SABPipe Node.js Tests\n' + '='.repeat(40));

  // ─────────────────────────────────────────────────────────────
  group('Construction');
  // ─────────────────────────────────────────────────────────────

  const sab1 = new SharedArrayBuffer(131072);
  const writer1 = new SABPipe('w', sab1);
  const reader1 = new SABPipe('r', sab1);

  test('writer role set correctly', writer1.isWriter === true);
  test('writer isReader is false', writer1.isReader === false);
  test('reader role set correctly', reader1.isReader === true);
  test('reader isWriter is false', reader1.isWriter === false);

  // Default SAB size
  const writer2 = new SABPipe('w');
  test('default SAB size is 128KB', writer2._sab.byteLength === 131072);

  // Invalid role
  let roleError = null;
  try {
    new SABPipe('x');
  } catch (err) {
    roleError = err;
  }
  test('invalid role throws', roleError !== null);

  // ─────────────────────────────────────────────────────────────
  group('Role Enforcement');
  // ─────────────────────────────────────────────────────────────

  const sab2 = new SharedArrayBuffer(131072);
  const writer3 = new SABPipe('w', sab2);
  const reader3 = new SABPipe('r', sab2);

  let writerReadError = null;
  try {
    writer3.read();
  } catch (err) {
    writerReadError = err;
  }
  test('writer cannot call read()', writerReadError !== null);

  let writerTryReadError = null;
  try {
    writer3.tryRead();
  } catch (err) {
    writerTryReadError = err;
  }
  test('writer cannot call tryRead()', writerTryReadError !== null);

  let writerAsyncReadError = null;
  try {
    await writer3.asyncRead();
  } catch (err) {
    writerAsyncReadError = err;
  }
  test('writer cannot call asyncRead()', writerAsyncReadError !== null);

  let readerWriteError = null;
  try {
    reader3.postMessage({ test: 1 });
  } catch (err) {
    readerWriteError = err;
  }
  test('reader cannot call postMessage()', readerWriteError !== null);

  // ─────────────────────────────────────────────────────────────
  group('Basic Write/Read');
  // ─────────────────────────────────────────────────────────────

  const sab3 = new SharedArrayBuffer(131072);
  const writer4 = new SABPipe('w', sab3);

  const test1 = runWorkerTest('test_read_echo', sab3, { waitForBlocking: true });
  await test1.ready();
  await writer4.postMessage({ message: 'hello', num: 42 });
  const result1 = await test1.result;

  test('worker received message', result1.received !== null);
  assertEqual('message content correct', result1.received?.message, 'hello');
  assertEqual('message number correct', result1.received?.num, 42);
  test('response from worker', result1.from === 'worker');

  // ─────────────────────────────────────────────────────────────
  group('tryRead');
  // ─────────────────────────────────────────────────────────────

  // tryRead when no data
  const sab4a = new SharedArrayBuffer(131072);
  const test4a = runWorkerTest('test_try_read_empty', sab4a);
  await test4a.ready();
  const result4a = await test4a.result;
  test('tryRead returns null when no data', result4a.wasNull === true);

  // tryRead when data ready
  const sab4b = new SharedArrayBuffer(131072);
  const writer4b = new SABPipe('w', sab4b);
  const test4b = runWorkerTest('test_try_read_ready', sab4b, { waitForBlocking: true });
  await test4b.ready();
  await writer4b.postMessage({ test: 'data' });
  const result4b = await test4b.result;
  test('tryRead returns data when ready', result4b.received !== null);
  assertEqual('tryRead data correct', result4b.received?.test, 'data');

  // ─────────────────────────────────────────────────────────────
  group('Timeout');
  // ─────────────────────────────────────────────────────────────

  const sab5 = new SharedArrayBuffer(131072);
  const test5 = runWorkerTest('test_read_timeout', sab5, { timeout: 100, testTimeout: 2000 });
  await test5.ready();
  const result5 = await test5.result;
  test('read with timeout returns null', result5.received === null);
  test('timeout took reasonable time', result5.elapsed >= 80 && result5.elapsed < 300);

  // ─────────────────────────────────────────────────────────────
  group('Multiple Messages');
  // ─────────────────────────────────────────────────────────────

  const sab6 = new SharedArrayBuffer(131072);
  const writer6 = new SABPipe('w', sab6);

  mylog('Multiple Messages: calling runWorkerTest');
  const test6 = runWorkerTest('test_read_multiple', sab6, { count: 3, testTimeout: 5000, waitForBlocking: true });
  await test6.ready();
  mylog('Multiple Messages: worker is blocking, starting writes');

  // Send 3 separate messages
  for (let i = 0; i < 3; i++) {
    mylog(`Multiple Messages: writing #${i}`);
    await writer6.postMessage({ id: i, data: `message-${i}` });
    mylog(`Multiple Messages: wrote #${i}`);
  }
  mylog('Multiple Messages: all writes done, awaiting result');

  const result6 = await test6.result;
  mylog('Multiple Messages: got result:', JSON.stringify(result6));
  test('received all 3 messages', result6.messages?.length === 3);
  test('messages in correct order', result6.messages?.every((m, i) => m.id === i));

  // ─────────────────────────────────────────────────────────────
  group('Multipart (Large Payload)');
  // ─────────────────────────────────────────────────────────────

  const sab7 = new SharedArrayBuffer(131072);
  const writer7 = new SABPipe('w', sab7);

  // Create large payload that requires multipart
  const bigArray = [];
  for (let i = 0; i < 50000; i++) bigArray.push(i);

  const test7 = runWorkerTest('test_read_multipart', sab7, { testTimeout: 30000, waitForBlocking: true });
  await test7.ready();
  await writer7.postMessage(bigArray);
  const result7 = await test7.result;

  test('worker received multipart', result7.received === true);
  assertEqual('multipart length correct', result7.length, 50000);
  assertEqual('multipart first item', result7.first, 0);
  assertEqual('multipart last item', result7.last, 49999);

  // ─────────────────────────────────────────────────────────────
  group('Disposal');
  // ─────────────────────────────────────────────────────────────

  const sab8 = new SharedArrayBuffer(131072);
  const writer8 = new SABPipe('w', sab8);
  const reader8 = new SABPipe('r', sab8);

  test('isDisposed false before destroy', !writer8.isDisposed());
  writer8.destroy();
  test('isDisposed true after destroy', writer8.isDisposed());
  test('reader sees disposed', reader8.isDisposed());
  test('i32 is null after destroy', writer8.i32 === null);

  // Double destroy doesn't throw
  let doubleDestroyError = null;
  try {
    writer8.destroy();
  } catch (err) {
    doubleDestroyError = err;
  }
  test('double destroy does not throw', doubleDestroyError === null);

  // postMessage() after destroy should throw
  let writeAfterDestroyError = null;
  try {
    await writer8.postMessage({ test: 1 });
  } catch (err) {
    writeAfterDestroyError = err;
  }
  test('postMessage() throws after destroy', writeAfterDestroyError !== null);

  // ─────────────────────────────────────────────────────────────
  group('Dispose While Waiting');
  // ─────────────────────────────────────────────────────────────

  const sab9 = new SharedArrayBuffer(131072);
  const writer9 = new SABPipe('w', sab9);

  const test9 = runWorkerTest('test_read_disposed', sab9, { testTimeout: 3000, waitForBlocking: true });
  await test9.ready();
  writer9.destroy();
  const result9 = await test9.result;

  test('read throws when disposed', result9.threw === true);
  test('error message mentions disposed', result9.error?.includes('disposed'));

  // ─────────────────────────────────────────────────────────────
  group('Async Read');
  // ─────────────────────────────────────────────────────────────

  // Basic asyncRead — worker writes, main reads with asyncRead
  const sabAR1 = new SharedArrayBuffer(131072);
  const readerAR1 = new SABPipe('r', sabAR1);
  const testAR1 = runWorkerTest('test_async_write_single', sabAR1, {
    message: { greeting: 'hello-async', num: 99 }, waitForBlocking: true
  });
  await testAR1.ready();
  const msgAR1 = await readerAR1.asyncRead(5000);
  await testAR1.result;
  test('asyncRead received message', msgAR1 !== null);
  assertEqual('asyncRead message content', msgAR1?.greeting, 'hello-async');
  assertEqual('asyncRead message number', msgAR1?.num, 99);

  // asyncRead timeout — no writer, returns null
  const sabAR2 = new SharedArrayBuffer(131072);
  const readerAR2 = new SABPipe('r', sabAR2);
  const arStart = Date.now();
  const msgAR2 = await readerAR2.asyncRead(100);
  const arElapsed = Date.now() - arStart;
  test('asyncRead timeout returns null', msgAR2 === null);
  test('asyncRead timeout reasonable time', arElapsed >= 80 && arElapsed < 300);

  // asyncRead multiple — worker writes 3, main reads 3
  const sabAR3 = new SharedArrayBuffer(131072);
  const readerAR3 = new SABPipe('r', sabAR3);
  const testAR3 = runWorkerTest('test_async_write_multiple', sabAR3, {
    count: 3, waitForBlocking: true, testTimeout: 10000
  });
  await testAR3.ready();
  const arMsgs = [];
  for (let i = 0; i < 3; i++) {
    const msg = await readerAR3.asyncRead(5000);
    arMsgs.push(msg);
  }
  await testAR3.result;
  test('asyncRead received all 3', arMsgs.length === 3 && arMsgs.every(m => m !== null));
  test('asyncRead correct order', arMsgs.every((m, i) => m.id === i));

  // asyncRead multipart — worker writes large payload
  const sabAR4 = new SharedArrayBuffer(131072);
  const readerAR4 = new SABPipe('r', sabAR4);
  const testAR4 = runWorkerTest('test_async_write_multipart', sabAR4, {
    size: 50000, waitForBlocking: true, testTimeout: 30000
  });
  await testAR4.ready();
  const msgAR4 = await readerAR4.asyncRead(30000);
  await testAR4.result;
  test('asyncRead multipart received', msgAR4 !== null);
  assertEqual('asyncRead multipart length', msgAR4?.length, 50000);
  assertEqual('asyncRead multipart first', msgAR4?.[0], 0);
  assertEqual('asyncRead multipart last', msgAR4?.[49999], 49999);

  // asyncRead disposed — worker disposes channel while main is reading
  const sabAR5 = new SharedArrayBuffer(131072);
  const readerAR5 = new SABPipe('r', sabAR5);
  const testAR5 = runWorkerTest('test_async_dispose', sabAR5, {
    delay: 100, waitForBlocking: true, testTimeout: 5000
  });
  await testAR5.ready();
  let arThrew = false;
  let arError = '';
  try {
    await readerAR5.asyncRead(5000);
  } catch (err) {
    arThrew = true;
    arError = err.message;
  }
  await testAR5.result;
  test('asyncRead throws when disposed', arThrew === true);
  test('asyncRead error mentions disposed', arError.includes('disposed'));

  // ─────────────────────────────────────────────────────────────
  group('onmessage Handler');
  // ─────────────────────────────────────────────────────────────

  // writer cannot set onmessage
  const sabOM0 = new SharedArrayBuffer(131072);
  const writerOM0 = new SABPipe('w', sabOM0);
  let writerOnmsgError = null;
  try {
    writerOM0.onmessage = () => {};
  } catch (err) {
    writerOnmsgError = err;
  }
  test('writer cannot set onmessage', writerOnmsgError !== null);

  // basic onmessage delivery — worker writes, main receives via onmessage
  const sabOM1 = new SharedArrayBuffer(131072);
  const readerOM1 = new SABPipe('r', sabOM1);
  const testOM1 = runWorkerTest('test_async_write_single', sabOM1, {
    message: { hello: 'onmessage' }, waitForBlocking: true
  });
  await testOM1.ready();

  const omMsg1 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('onmessage timeout')), 5000);
    readerOM1.onmessage = (e) => {
      clearTimeout(timeout);
      readerOM1.onmessage = null;
      resolve(e.data);
    };
  });
  await testOM1.result;
  test('onmessage received message', omMsg1 !== null);
  assertEqual('onmessage message content', omMsg1?.hello, 'onmessage');

  // onmessage multiple messages — worker writes 5, handler collects all
  const sabOM2 = new SharedArrayBuffer(131072);
  const readerOM2 = new SABPipe('r', sabOM2);
  const testOM2 = runWorkerTest('test_async_write_multiple', sabOM2, {
    count: 5, waitForBlocking: true, testTimeout: 10000
  });
  await testOM2.ready();

  const omMsgs2 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('onmessage multi timeout')), 10000);
    const collected = [];
    readerOM2.onmessage = (e) => {
      collected.push(e.data);
      if (collected.length >= 5) {
        clearTimeout(timeout);
        readerOM2.onmessage = null;
        resolve(collected);
      }
    };
  });
  await testOM2.result;
  test('onmessage received all 5', omMsgs2.length === 5);
  test('onmessage correct order', omMsgs2.every((m, i) => m.id === i));

  // onmessage multipart — worker writes large payload
  const sabOM3 = new SharedArrayBuffer(131072);
  const readerOM3 = new SABPipe('r', sabOM3);
  const testOM3 = runWorkerTest('test_async_write_multipart', sabOM3, {
    size: 50000, waitForBlocking: true, testTimeout: 30000
  });
  await testOM3.ready();

  const omMsg3 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('onmessage multipart timeout')), 30000);
    readerOM3.onmessage = (e) => {
      clearTimeout(timeout);
      readerOM3.onmessage = null;
      resolve(e.data);
    };
  });
  await testOM3.result;
  test('onmessage multipart received', omMsg3 !== null);
  assertEqual('onmessage multipart length', omMsg3?.length, 50000);

  // mutual exclusion — read()/asyncRead() throw while onmessage is active
  const sabOM4 = new SharedArrayBuffer(131072);
  const readerOM4 = new SABPipe('r', sabOM4);
  readerOM4.onmessage = () => {};
  let readWhileOnmsgError = null;
  try {
    readerOM4.read(0, false);
  } catch (err) {
    readWhileOnmsgError = err;
  }
  let asyncReadWhileOnmsgError = null;
  try {
    await readerOM4.asyncRead(0);
  } catch (err) {
    asyncReadWhileOnmsgError = err;
  }
  readerOM4.onmessage = null;
  test('read() throws while onmessage active', readWhileOnmsgError !== null);
  test('asyncRead() throws while onmessage active', asyncReadWhileOnmsgError !== null);

  // setting null stops delivery
  const sabOM5 = new SharedArrayBuffer(131072);
  const readerOM5 = new SABPipe('r', sabOM5);
  const testOM5 = runWorkerTest('test_async_write_multiple', sabOM5, {
    count: 5, waitForBlocking: true, testTimeout: 3000
  });
  await testOM5.ready();

  const omResult5 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('onmessage null-stop timeout')), 10000);
    const collected = [];
    readerOM5.onmessage = (e) => {
      collected.push(e.data);
      if (collected.length >= 2) {
        // Stop after 2 messages
        readerOM5.onmessage = null;
        clearTimeout(timeout);
        resolve(collected);
      }
    };
  });
  // Should have exactly 2 (stopped after 2)
  test('onmessage null stops delivery', omResult5.length === 2);
  test('onmessage getter returns null after clear', readerOM5.onmessage === null);
  // Worker is stuck waiting for reader — swallow its timeout
  testOM5.result.catch(() => {});

  // handler errors don't break the loop
  const sabOM6 = new SharedArrayBuffer(131072);
  const readerOM6 = new SABPipe('r', sabOM6);
  const testOM6 = runWorkerTest('test_async_write_multiple', sabOM6, {
    count: 3, waitForBlocking: true, testTimeout: 10000
  });
  await testOM6.ready();

  const omResult6 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('onmessage error-recovery timeout')), 10000);
    const collected = [];
    let callCount = 0;
    readerOM6.onmessage = (e) => {
      callCount++;
      if (callCount === 1) {
        // First message: throw, loop should survive
        collected.push(e.data);
        throw new Error('handler error on purpose');
      }
      collected.push(e.data);
      if (collected.length >= 3) {
        clearTimeout(timeout);
        readerOM6.onmessage = null;
        resolve(collected);
      }
    };
  });
  await testOM6.result;
  test('handler error: all 3 received', omResult6.length === 3);
  test('handler error: order preserved', omResult6.every((m, i) => m.id === i));

  // disposal stops the loop
  const sabOM7 = new SharedArrayBuffer(131072);
  const readerOM7 = new SABPipe('r', sabOM7);
  const writerOM7 = new SABPipe('w', sabOM7);
  let omLoopStopped = false;
  readerOM7.onmessage = () => {};
  // Give the loop time to start and enter _asyncRead
  await new Promise(r => setTimeout(r, 50));
  writerOM7.destroy();
  // Give the loop time to catch the disposal and exit
  await new Promise(r => setTimeout(r, 50));
  omLoopStopped = !readerOM7._messageLoopActive;
  test('disposal stops onmessage loop', omLoopStopped === true);

  // re-assignment swaps handler immediately
  const sabOM8 = new SharedArrayBuffer(131072);
  const readerOM8 = new SABPipe('r', sabOM8);
  const testOM8 = runWorkerTest('test_async_write_multiple', sabOM8, {
    count: 4, waitForBlocking: true, testTimeout: 10000
  });
  await testOM8.ready();

  const omResult8 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('onmessage reassign timeout')), 10000);
    const handler1Msgs = [];
    const handler2Msgs = [];
    readerOM8.onmessage = (e) => {
      handler1Msgs.push(e.data);
      if (handler1Msgs.length >= 2) {
        // Swap to second handler
        readerOM8.onmessage = (e2) => {
          handler2Msgs.push(e2.data);
          if (handler2Msgs.length >= 2) {
            clearTimeout(timeout);
            readerOM8.onmessage = null;
            resolve({ handler1Msgs, handler2Msgs });
          }
        };
      }
    };
  });
  await testOM8.result;
  test('re-assignment: handler1 got messages', omResult8.handler1Msgs.length === 2);
  test('re-assignment: handler2 got messages', omResult8.handler2Msgs.length === 2);
  test('re-assignment: all in order',
    omResult8.handler1Msgs[0].id === 0 && omResult8.handler1Msgs[1].id === 1 &&
    omResult8.handler2Msgs[0].id === 2 && omResult8.handler2Msgs[1].id === 3);

  // ─────────────────────────────────────────────────────────────
  group('Performance');
  // ─────────────────────────────────────────────────────────────

  const ITERATIONS = 1000;
  const sab10 = new SharedArrayBuffer(131072);
  const writer10 = new SABPipe('w', sab10);

  // Generate test data
  const testData = [];
  for (let i = 0; i < ITERATIONS; i++) {
    testData.push({ id: i, payload: 'x'.repeat(500 + Math.floor(Math.random() * 500)) });
  }
  const totalBytes = testData.reduce((sum, d) => sum + JSON.stringify(d).length, 0);

  const test10 = runWorkerTest('test_perf_read', sab10, { iterations: ITERATIONS, testTimeout: 60000, waitForBlocking: true });
  await test10.ready();

  const perfStart = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await writer10.postMessage(testData[i]);
  }
  const perfEnd = performance.now();
  const perfTime = perfEnd - perfStart;

  const result10 = await test10.result;
  const throughputMBps = (totalBytes / 1024 / 1024) / (perfTime / 1000);

  const sabAvgLatency = (perfTime / ITERATIONS * 1000); // microseconds

  test('all messages received', result10.count === ITERATIONS);
  perf(`SABPipe: ${ITERATIONS} msgs, ${(totalBytes/1024).toFixed(0)}KB`, `${perfTime.toFixed(1)}ms, ${throughputMBps.toFixed(2)} MB/s, avg ${sabAvgLatency.toFixed(1)}µs/msg`);

  // --- MessagePort Performance Comparison ---
  const { port1, port2 } = new MessageChannel();
  const mpWorker = new Worker(__filename);

  // Wait for worker ready
  await new Promise((resolve) => {
    const handler = (msg) => {
      if (msg.status === 'ready') {
        mpWorker.removeListener('message', handler);
        resolve();
      }
    };
    mpWorker.on('message', handler);
  });

  // Set up result handler
  const mpResultPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      mpWorker.terminate();
      reject(new Error('Timeout: MessagePort perf'));
    }, 60000);
    mpWorker.on('message', (msg) => {
      if (msg.result !== undefined) {
        clearTimeout(timeout);
        resolve(msg.result);
      }
    });
  });

  // Send command with transferred port
  mpWorker.postMessage(
    { test: 'test_perf_messageport', options: { iterations: ITERATIONS }, port: port2 },
    [port2]
  );

  // Run MessagePort round-trip test: send, wait for echo, repeat
  const mpStart = performance.now();
  let mpCount = 0;

  await new Promise((resolve) => {
    port1.on('message', (data) => {
      mpCount++;
      if (mpCount < ITERATIONS) {
        port1.postMessage(testData[mpCount]);
      } else {
        resolve();
      }
    });
    // Send first message to kick off
    port1.postMessage(testData[0]);
  });

  const mpEnd = performance.now();
  const mpTime = mpEnd - mpStart;
  const mpThroughput = (totalBytes / 1024 / 1024) / (mpTime / 1000);

  await mpResultPromise;
  mpWorker.terminate();
  port1.close();

  const mpAvgLatency = (mpTime / ITERATIONS * 1000); // microseconds

  test('MessagePort all messages echoed', mpCount === ITERATIONS);
  perf(`MessagePort: ${ITERATIONS} msgs, ${(totalBytes/1024).toFixed(0)}KB`, `${mpTime.toFixed(1)}ms, ${mpThroughput.toFixed(2)} MB/s, avg ${mpAvgLatency.toFixed(1)}µs/msg`);

  // Comparison
  const ratio = perfTime / mpTime;
  const faster = ratio < 1 ? 'SABPipe' : 'MessagePort';
  const factor = ratio < 1 ? (1/ratio).toFixed(2) : ratio.toFixed(2);
  perf('Comparison', `${faster} is ${factor}x faster (${sabAvgLatency.toFixed(1)}µs vs ${mpAvgLatency.toFixed(1)}µs per msg)`);

  // ─────────────────────────────────────────────────────────────
  group('Stress: High Volume (10,000 messages)');
  // ─────────────────────────────────────────────────────────────

  const STRESS_COUNT = 10000;
  const sabStress1 = new SharedArrayBuffer(131072);
  const writerStress1 = new SABPipe('w', sabStress1);

  const stressTest1 = runWorkerTest('test_stress_high_volume', sabStress1, {
    count: STRESS_COUNT, testTimeout: 60000, waitForBlocking: true
  });
  await stressTest1.ready();

  const hvStart = performance.now();
  for (let i = 0; i < STRESS_COUNT; i++) {
    await writerStress1.postMessage({ id: i, v: i * 2 });
  }
  const hvTime = performance.now() - hvStart;

  const stressResult1 = await stressTest1.result;
  test('high volume: all received', stressResult1.received === STRESS_COUNT);
  test('high volume: order correct', stressResult1.orderOk === true);
  test('high volume: data intact', stressResult1.dataOk === true);
  perf(`high volume: ${STRESS_COUNT} msgs`, `${hvTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('Stress: Large Payloads');
  // ─────────────────────────────────────────────────────────────

  // 500KB payload - requires many multipart chunks on 128KB SAB
  const LARGE_SIZE = 500000;
  const sabStress2 = new SharedArrayBuffer(131072);
  const writerStress2 = new SABPipe('w', sabStress2);

  const stressTest2 = runWorkerTest('test_stress_large_payload', sabStress2, {
    testTimeout: 60000, waitForBlocking: true
  });
  await stressTest2.ready();

  const largePayload = [];
  for (let i = 0; i < LARGE_SIZE; i++) largePayload.push(i % 256);

  const lpStart = performance.now();
  await writerStress2.postMessage(largePayload);
  const lpTime = performance.now() - lpStart;

  const stressResult2 = await stressTest2.result;
  test('large payload: received', stressResult2.received === true);
  assertEqual('large payload: length correct', stressResult2.length, LARGE_SIZE);
  test('large payload: data valid', stressResult2.valid === true);
  perf(`large payload: ${(LARGE_SIZE/1024).toFixed(0)}KB`, `${lpTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('Stress: Rapid Create/Destroy');
  // ─────────────────────────────────────────────────────────────

  const LIFECYCLE_ROUNDS = 50;
  let lifecycleOk = 0;

  const lcStart = performance.now();
  for (let i = 0; i < LIFECYCLE_ROUNDS; i++) {
    const lcSab = new SharedArrayBuffer(131072);
    const lcWriter = new SABPipe('w', lcSab);

    const lcTest = runWorkerTest('test_stress_lifecycle_read', lcSab, {
      testTimeout: 5000, waitForBlocking: true
    });
    await lcTest.ready();
    await lcWriter.postMessage({ round: i });
    const lcResult = await lcTest.result;
    if (lcResult.received && lcResult.value?.round === i) lifecycleOk++;

    lcWriter.destroy();
  }
  const lcTime = performance.now() - lcStart;

  test('lifecycle: all rounds ok', lifecycleOk === LIFECYCLE_ROUNDS);
  perf(`lifecycle: ${LIFECYCLE_ROUNDS} create/write/destroy cycles`, `${lcTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('Stress: Mixed Sizes');
  // ─────────────────────────────────────────────────────────────

  const MIXED_COUNT = 100;
  const sabStress4 = new SharedArrayBuffer(131072);
  const writerStress4 = new SABPipe('w', sabStress4);

  const stressTest4 = runWorkerTest('test_stress_mixed_sizes', sabStress4, {
    count: MIXED_COUNT, testTimeout: 60000, waitForBlocking: true
  });
  await stressTest4.ready();

  // Alternate between tiny (10 bytes), medium (1KB), and huge (50KB) payloads
  const sizes = [];
  for (let i = 0; i < MIXED_COUNT; i++) {
    let size;
    if (i % 10 === 9) size = 50000;       // every 10th: huge
    else if (i % 3 === 0) size = 1000;     // every 3rd: medium
    else size = 10;                         // rest: tiny
    sizes.push(size);
  }

  const msStart = performance.now();
  for (let i = 0; i < MIXED_COUNT; i++) {
    const payload = 'x'.repeat(sizes[i]);
    await writerStress4.postMessage({ id: i, payload, expectedLen: sizes[i] });
  }
  const msTime = performance.now() - msStart;

  const stressResult4 = await stressTest4.result;
  test('mixed sizes: all received', stressResult4.received === MIXED_COUNT);
  test('mixed sizes: all valid', stressResult4.allValid === true);
  perf(`mixed sizes: ${MIXED_COUNT} msgs (tiny/medium/huge)`, `${msTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('Stress: Sustained Throughput');
  // ─────────────────────────────────────────────────────────────

  const SUSTAIN_DURATION_MS = 3000;
  const sabStress5 = new SharedArrayBuffer(131072);
  const writerStress5 = new SABPipe('w', sabStress5);

  const stressTest5 = runWorkerTest('test_stress_sustained', sabStress5, {
    testTimeout: SUSTAIN_DURATION_MS + 5000, waitForBlocking: true
  });
  await stressTest5.ready();

  let sustainCount = 0;
  const sustainStart = performance.now();
  while (performance.now() - sustainStart < SUSTAIN_DURATION_MS) {
    await writerStress5.postMessage({ id: sustainCount, data: 'x'.repeat(500) });
    sustainCount++;
  }

  // Wait for reader to drain (it'll timeout after 100ms of no data)
  const stressResult5 = await stressTest5.result;
  const sustainTime = performance.now() - sustainStart;

  test('sustained: order correct', stressResult5.orderOk === true);
  test('sustained: reader got all', stressResult5.count === sustainCount);
  perf(`sustained: ${stressResult5.count} msgs in ${(sustainTime/1000).toFixed(1)}s`, `${(stressResult5.count / (sustainTime/1000)).toFixed(0)} msgs/s, ${(stressResult5.totalBytes / 1024 / 1024 / (sustainTime/1000)).toFixed(2)} MB/s`);

  // ─────────────────────────────────────────────────────────────
  group('asyncRead Performance');
  // ─────────────────────────────────────────────────────────────

  const AR_ITERATIONS = 1000;
  const sabARPerf = new SharedArrayBuffer(131072);
  const readerARPerf = new SABPipe('r', sabARPerf);

  // Generate test data
  const arTestData = [];
  for (let i = 0; i < AR_ITERATIONS; i++) {
    arTestData.push({ id: i, payload: 'x'.repeat(500 + Math.floor(Math.random() * 500)) });
  }
  const arTotalBytes = arTestData.reduce((sum, d) => sum + JSON.stringify(d).length, 0);

  const testARPerf = runWorkerTest('test_async_write_perf', sabARPerf, {
    iterations: AR_ITERATIONS, testData: arTestData, testTimeout: 60000, waitForBlocking: true
  });
  await testARPerf.ready();

  const arPerfStart = performance.now();
  let arPerfCount = 0;
  for (let i = 0; i < AR_ITERATIONS; i++) {
    const msg = await readerARPerf.asyncRead(5000);
    if (msg && msg.id === i) arPerfCount++;
  }
  const arPerfTime = performance.now() - arPerfStart;

  await testARPerf.result;
  const arThroughput = (arTotalBytes / 1024 / 1024) / (arPerfTime / 1000);
  const arAvgLatency = (arPerfTime / AR_ITERATIONS * 1000);

  test('asyncRead perf: all received', arPerfCount === AR_ITERATIONS);
  perf(`asyncRead: ${AR_ITERATIONS} msgs, ${(arTotalBytes/1024).toFixed(0)}KB`, `${arPerfTime.toFixed(1)}ms, ${arThroughput.toFixed(2)} MB/s, avg ${arAvgLatency.toFixed(1)}µs/msg`);

  // --- Native postMessage Performance Comparison ---
  const { port1: arNPort1, port2: arNPort2 } = new MessageChannel();
  const arNWorker = new Worker(__filename);

  await new Promise(resolve => {
    const handler = msg => {
      if (msg.status === 'ready') {
        arNWorker.removeListener('message', handler);
        resolve();
      }
    };
    arNWorker.on('message', handler);
  });

  let arNCount = 0;
  const arNRecvPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      arNWorker.terminate();
      reject(new Error('Timeout: native postMessage perf'));
    }, 60000);
    arNPort1.on('message', () => {
      arNCount++;
      if (arNCount >= AR_ITERATIONS) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const arNStart = performance.now();
  arNWorker.postMessage(
    { test: 'test_perf_native_write', options: { testData: arTestData, iterations: AR_ITERATIONS }, port: arNPort2 },
    [arNPort2]
  );
  await arNRecvPromise;
  const arNTime = performance.now() - arNStart;

  arNWorker.terminate();
  arNPort1.close();

  const arNThroughput = (arTotalBytes / 1024 / 1024) / (arNTime / 1000);
  const arNAvgLatency = (arNTime / AR_ITERATIONS * 1000);

  test('native postMessage all received', arNCount === AR_ITERATIONS);
  perf(`Native postMessage: ${AR_ITERATIONS} msgs, ${(arTotalBytes/1024).toFixed(0)}KB`, `${arNTime.toFixed(1)}ms, ${arNThroughput.toFixed(2)} MB/s, avg ${arNAvgLatency.toFixed(1)}µs/msg`);

  const arRatio = arPerfTime / arNTime;
  const arFaster = arRatio < 1 ? 'asyncRead' : 'postMessage';
  const arFactor = arRatio < 1 ? (1/arRatio).toFixed(2) : arRatio.toFixed(2);
  perf('Comparison', `${arFaster} is ${arFactor}x faster (${arAvgLatency.toFixed(1)}µs vs ${arNAvgLatency.toFixed(1)}µs per msg)`);

  // ─────────────────────────────────────────────────────────────
  group('asyncRead Stress: High Volume (10,000 messages)');
  // ─────────────────────────────────────────────────────────────

  const AR_STRESS_COUNT = 10000;
  const sabARStress1 = new SharedArrayBuffer(131072);
  const readerARStress1 = new SABPipe('r', sabARStress1);

  const testARStress1 = runWorkerTest('test_async_write_high_volume', sabARStress1, {
    count: AR_STRESS_COUNT, testTimeout: 60000, waitForBlocking: true
  });
  await testARStress1.ready();

  const arHvStart = performance.now();
  let arHvReceived = 0;
  let arHvOrderOk = true;
  let arHvDataOk = true;
  for (let i = 0; i < AR_STRESS_COUNT; i++) {
    const msg = await readerARStress1.asyncRead(5000);
    if (!msg || msg.id !== i) arHvOrderOk = false;
    if (!msg || msg.v !== i * 2) arHvDataOk = false;
    arHvReceived++;
  }
  const arHvTime = performance.now() - arHvStart;

  await testARStress1.result;
  test('asyncRead high volume: all received', arHvReceived === AR_STRESS_COUNT);
  test('asyncRead high volume: order correct', arHvOrderOk === true);
  test('asyncRead high volume: data intact', arHvDataOk === true);
  perf(`asyncRead high volume: ${AR_STRESS_COUNT} msgs`, `${arHvTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('asyncRead Stress: Large Payloads');
  // ─────────────────────────────────────────────────────────────

  const AR_LARGE_SIZE = 500000;
  const sabARStress2 = new SharedArrayBuffer(131072);
  const readerARStress2 = new SABPipe('r', sabARStress2);

  const testARStress2 = runWorkerTest('test_async_write_large_payload', sabARStress2, {
    size: AR_LARGE_SIZE, testTimeout: 60000, waitForBlocking: true
  });
  await testARStress2.ready();

  const arLpStart = performance.now();
  const arLpMsg = await readerARStress2.asyncRead(60000);
  const arLpTime = performance.now() - arLpStart;

  await testARStress2.result;
  let arLpValid = true;
  if (!arLpMsg || !Array.isArray(arLpMsg)) {
    arLpValid = false;
  } else {
    for (let i = 0; i < arLpMsg.length; i++) {
      if (arLpMsg[i] !== i % 256) { arLpValid = false; break; }
    }
  }
  test('asyncRead large payload: received', arLpMsg !== null);
  assertEqual('asyncRead large payload: length', arLpMsg?.length, AR_LARGE_SIZE);
  test('asyncRead large payload: valid', arLpValid === true);
  perf(`asyncRead large payload: ${(AR_LARGE_SIZE/1024).toFixed(0)}KB`, `${arLpTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('asyncRead Stress: Mixed Sizes');
  // ─────────────────────────────────────────────────────────────

  const AR_MIXED_COUNT = 100;
  const arSizes = [];
  for (let i = 0; i < AR_MIXED_COUNT; i++) {
    if (i % 10 === 9) arSizes.push(50000);
    else if (i % 3 === 0) arSizes.push(1000);
    else arSizes.push(10);
  }

  const sabARStress4 = new SharedArrayBuffer(131072);
  const readerARStress4 = new SABPipe('r', sabARStress4);

  const testARStress4 = runWorkerTest('test_async_write_mixed_sizes', sabARStress4, {
    sizes: arSizes, testTimeout: 60000, waitForBlocking: true
  });
  await testARStress4.ready();

  const arMsStart = performance.now();
  let arMsReceived = 0;
  let arMsAllValid = true;
  for (let i = 0; i < AR_MIXED_COUNT; i++) {
    const msg = await readerARStress4.asyncRead(30000);
    if (msg === null) { arMsAllValid = false; break; }
    if (msg.id !== i) arMsAllValid = false;
    if (msg.payload.length !== msg.expectedLen) arMsAllValid = false;
    arMsReceived++;
  }
  const arMsTime = performance.now() - arMsStart;

  await testARStress4.result;
  test('asyncRead mixed sizes: all received', arMsReceived === AR_MIXED_COUNT);
  test('asyncRead mixed sizes: all valid', arMsAllValid === true);
  perf(`asyncRead mixed sizes: ${AR_MIXED_COUNT} msgs`, `${arMsTime.toFixed(1)}ms`);

  // ─────────────────────────────────────────────────────────────
  group('asyncRead Stress: Sustained Throughput');
  // ─────────────────────────────────────────────────────────────

  const AR_SUSTAIN_MS = 3000;
  const sabARStress5 = new SharedArrayBuffer(131072);
  const readerARStress5 = new SABPipe('r', sabARStress5);

  const testARStress5 = runWorkerTest('test_async_write_sustained', sabARStress5, {
    duration: AR_SUSTAIN_MS, testTimeout: AR_SUSTAIN_MS + 10000, waitForBlocking: true
  });
  await testARStress5.ready();

  // Read until worker result arrives, then drain remaining
  let arSustainWritten = null;
  const arSustainResultPromise = testARStress5.result.then(r => { arSustainWritten = r.written; });

  let arSustainCount = 0;
  let arSustainBytes = 0;
  let arSustainLastId = -1;
  let arSustainOrderOk = true;
  const arSustainStart = performance.now();
  while (true) {
    // Race asyncRead against a short setTimeout to keep the event loop alive
    const msg = await readerARStress5.asyncRead(200);
    if (msg === null) {
      // If worker has finished and we got no data, we're done
      if (arSustainWritten !== null) break;
      // Otherwise worker still writing, keep waiting
      continue;
    }
    if (msg.id !== arSustainLastId + 1) arSustainOrderOk = false;
    arSustainLastId = msg.id;
    arSustainBytes += JSON.stringify(msg).length;
    arSustainCount++;
  }
  const arSustainTime = performance.now() - arSustainStart;

  await arSustainResultPromise;
  test('asyncRead sustained: order correct', arSustainOrderOk === true);
  test('asyncRead sustained: reader got all', arSustainCount === arSustainWritten);
  perf(`asyncRead sustained: ${arSustainCount} msgs in ${(arSustainTime/1000).toFixed(1)}s`, `${(arSustainCount / (arSustainTime/1000)).toFixed(0)} msgs/s, ${(arSustainBytes / 1024 / 1024 / (arSustainTime/1000)).toFixed(2)} MB/s`);

  // ─────────────────────────────────────────────────────────────
  group('SABMessagePort: Construction');
  // ─────────────────────────────────────────────────────────────

  // Default side and size
  const bidi1 = new SABMessagePort();
  test('bidi: default creates 256KB SAB', bidi1.buffer.byteLength === 256 * 1024);

  // Custom size
  const bidi2 = new SABMessagePort('a', 128);
  test('bidi: custom size 128KB', bidi2.buffer.byteLength === 128 * 1024);

  // Existing SAB
  const bidiSab = new SharedArrayBuffer(64 * 1024);
  const bidi2b = new SABMessagePort('a', bidiSab);
  test('bidi: accepts existing SAB', bidi2b.buffer === bidiSab);

  // Invalid side
  let bidiSideError = null;
  try { new SABMessagePort('x'); } catch (e) { bidiSideError = e; }
  test('bidi: invalid side throws', bidiSideError !== null);

  // ─────────────────────────────────────────────────────────────
  group('SABMessagePort: postInit / from');
  // ─────────────────────────────────────────────────────────────

  // postInit returns args array when target is null
  const bidi3 = new SABMessagePort();
  const initArgs = bidi3.postInit(null, { channel: 'test' });
  test('bidi: postInit returns array', Array.isArray(initArgs));
  test('bidi: postInit msg has type', initArgs[0].type === 'SABMessagePort');
  test('bidi: postInit msg has buffer', initArgs[0].buffer === bidi3.buffer);
  test('bidi: postInit msg has extraProps', initArgs[0].channel === 'test');
  test('bidi: postInit transfer list', Array.isArray(initArgs[1]) && initArgs[1][0] === bidi3.buffer);

  // from() factory
  const bidi4a = new SABMessagePort();
  const bidi4Msg = bidi4a.postInit(null)[0];
  const bidi4b = SABMessagePort.from(bidi4Msg);
  test('bidi: from() creates instance', bidi4b instanceof SABMessagePort);
  test('bidi: from() shares buffer', bidi4b.buffer === bidi4a.buffer);

  // from() with invalid msg
  let fromError = null;
  try { SABMessagePort.from({ type: 'wrong' }); } catch (e) { fromError = e; }
  test('bidi: from() rejects invalid', fromError !== null);

  // ─────────────────────────────────────────────────────────────
  group('SABMessagePort: Bidirectional Messaging');
  // ─────────────────────────────────────────────────────────────

  // Main writes, worker reads and echoes back
  const sabBidi1 = new SharedArrayBuffer(256 * 1024);
  const bidiMain1 = new SABMessagePort('a', sabBidi1);
  const testBidi1 = runWorkerTest('test_bidi_echo', sabBidi1, { waitForBlocking: true, testTimeout: 10000 });
  await testBidi1.ready();
  await bidiMain1.postMessage({ greeting: 'hello-bidi', num: 42 });
  const bidiReply1 = await bidiMain1.asyncRead(5000);
  await testBidi1.result;
  test('bidi echo: received reply', bidiReply1 !== null);
  assertEqual('bidi echo: content', bidiReply1?.echo?.greeting, 'hello-bidi');
  assertEqual('bidi echo: worker tag', bidiReply1?.from, 'worker');

  // Worker writes N, main reads and echoes back, worker reads echoes
  const sabBidi2 = new SharedArrayBuffer(256 * 1024);
  const bidiMain2 = new SABMessagePort('a', sabBidi2);
  const testBidi2 = runWorkerTest('test_bidi_write_read', sabBidi2, { count: 5, waitForBlocking: true, testTimeout: 10000 });
  await testBidi2.ready();

  const bidiMsgs2 = [];
  for (let i = 0; i < 5; i++) {
    const msg = await bidiMain2.asyncRead(5000);
    bidiMsgs2.push(msg);
    bidiMain2.postMessage({ echoId: msg.id }); // no await — worker reads after finishing writes
  }
  const bidiResult2 = await testBidi2.result;
  test('bidi write-read: main received all', bidiMsgs2.length === 5);
  test('bidi write-read: main order correct', bidiMsgs2.every((m, i) => m.id === i));
  test('bidi write-read: worker echoes ok', bidiResult2.allOk === true);

  // ─────────────────────────────────────────────────────────────
  group('SABMessagePort: onmessage');
  // ─────────────────────────────────────────────────────────────

  const sabBidi3 = new SharedArrayBuffer(256 * 1024);
  const bidiMain3 = new SABMessagePort('a', sabBidi3);
  const testBidi3 = runWorkerTest('test_bidi_onmessage', sabBidi3, { count: 3, waitForBlocking: true, testTimeout: 10000 });
  await testBidi3.ready();

  const bidiEchoes3 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bidi onmessage timeout')), 10000);
    const collected = [];
    bidiMain3.onmessage = (e) => {
      collected.push(e.data);
      if (collected.length >= 3) {
        clearTimeout(timeout);
        bidiMain3.onmessage = null;
        resolve(collected);
      }
    };
    for (let i = 0; i < 3; i++) {
      bidiMain3.postMessage({ id: i, data: `bidi-${i}` });
    }
  });
  const bidiResult3 = await testBidi3.result;
  test('bidi onmessage: received all echoes', bidiEchoes3.length === 3);
  test('bidi onmessage: echoes correct', bidiEchoes3.every((m, i) => m.echo === i));
  test('bidi onmessage: worker received all', bidiResult3.allOk === true);

  // ─────────────────────────────────────────────────────────────
  group('SABMessagePort: close');
  // ─────────────────────────────────────────────────────────────

  const bidiClose = new SABMessagePort();
  bidiClose.close();
  let bidiWriteAfterClose = null;
  try { await bidiClose.postMessage({ test: 1 }); } catch (e) { bidiWriteAfterClose = e; }
  test('bidi close: postMessage throws', bidiWriteAfterClose !== null);

  let bidiReadAfterClose = null;
  try { await bidiClose.asyncRead(0); } catch (e) { bidiReadAfterClose = e; }
  test('bidi close: asyncRead throws', bidiReadAfterClose !== null);

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: Construction');
  // ─────────────────────────────────────────────────────────────

  const mw1 = new MWChannel('m');
  test('mw: default creates 128KB SAB', mw1.buffer.byteLength === 128 * 1024);

  const mw2 = new MWChannel('m', 256);
  test('mw: custom size 256KB', mw2.buffer.byteLength === 256 * 1024);

  let mwSideError = null;
  try { new MWChannel('x'); } catch (e) { mwSideError = e; }
  test('mw: invalid side throws', mwSideError !== null);

  // Main side cannot call read/tryRead/asyncRead
  let mwMainRead = null;
  try { mw1.read(); } catch (e) { mwMainRead = e; }
  test('mw: main cannot call read()', mwMainRead !== null);

  let mwMainTryRead = null;
  try { mw1.tryRead(); } catch (e) { mwMainTryRead = e; }
  test('mw: main cannot call tryRead()', mwMainTryRead !== null);

  let mwMainAsyncRead = null;
  try { await mw1.asyncRead(); } catch (e) { mwMainAsyncRead = e; }
  test('mw: main cannot call asyncRead()', mwMainAsyncRead !== null);

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: postInit / from');
  // ─────────────────────────────────────────────────────────────

  const mw3 = new MWChannel('m');
  const mwInitArgs = mw3.postInit(null, { channel: 'test' });
  test('mw: postInit returns array', Array.isArray(mwInitArgs));
  test('mw: postInit msg has type', mwInitArgs[0].type === 'MWChannel');
  test('mw: postInit msg has buffer', mwInitArgs[0].buffer === mw3.buffer);
  test('mw: postInit msg has port', mwInitArgs[0].port !== undefined);
  test('mw: postInit msg has extraProps', mwInitArgs[0].channel === 'test');
  test('mw: postInit transfer has port', mwInitArgs[1].length === 1);

  let mwFromError = null;
  try { MWChannel.from({ type: 'wrong' }); } catch (e) { mwFromError = e; }
  test('mw: from() rejects invalid', mwFromError !== null);

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: Blocking Read');
  // ─────────────────────────────────────────────────────────────

  {
    const mw = new MWChannel('m');
    const [initMsg, transfer] = mw.postInit(null);
    const worker = new Worker(__filename);

    const { readyPromise, blockingPromise, resultPromise } = await (async () => {
      let readyResolve, blockingResolve, resultResolve, resultReject;
      const readyPromise = new Promise(r => { readyResolve = r; });
      const blockingPromise = new Promise(r => { blockingResolve = r; });
      const resultPromise = new Promise((r, j) => { resultResolve = r; resultReject = j; });
      const timeout = setTimeout(() => { worker.terminate(); resultReject(new Error('Timeout')); }, 5000);
      worker.on('message', (msg) => {
        if (msg.status === 'ready') readyResolve();
        else if (msg.status === 'blocking') blockingResolve();
        else if (msg.result !== undefined) { clearTimeout(timeout); resultResolve(msg.result); }
        else if (msg.error) { clearTimeout(timeout); resultReject(new Error(msg.error)); }
      });
      return { readyPromise, blockingPromise, resultPromise };
    })();

    await readyPromise;
    worker.postMessage({ test: 'test_mw_blocking_read', mwInit: initMsg, options: {} }, transfer);
    await blockingPromise;
    await mw.postMessage({ greeting: 'hello-mw', num: 99 });
    const mwResult1 = await resultPromise;

    test('mw blocking: received message', mwResult1.received !== null);
    assertEqual('mw blocking: content', mwResult1.received?.greeting, 'hello-mw');
    assertEqual('mw blocking: number', mwResult1.received?.num, 99);
    test('mw blocking: from worker', mwResult1.from === 'worker');
  }

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: Multiple Blocking Reads');
  // ─────────────────────────────────────────────────────────────

  {
    const mw = new MWChannel('m');
    const [initMsg, transfer] = mw.postInit(null);
    const worker = new Worker(__filename);

    let readyResolve, blockingResolve, resultResolve, resultReject;
    const readyPromise = new Promise(r => { readyResolve = r; });
    const blockingPromise = new Promise(r => { blockingResolve = r; });
    const resultPromise = new Promise((r, j) => { resultResolve = r; resultReject = j; });
    const timeout = setTimeout(() => { worker.terminate(); resultReject(new Error('Timeout')); }, 5000);
    worker.on('message', (msg) => {
      if (msg.status === 'ready') readyResolve();
      else if (msg.status === 'blocking') blockingResolve();
      else if (msg.result !== undefined) { clearTimeout(timeout); resultResolve(msg.result); }
      else if (msg.error) { clearTimeout(timeout); resultReject(new Error(msg.error)); }
    });

    await readyPromise;
    worker.postMessage({ test: 'test_mw_blocking_multi', mwInit: initMsg, options: { count: 3 } }, transfer);
    await blockingPromise;
    for (let i = 0; i < 3; i++) {
      await mw.postMessage({ id: i, data: `msg-${i}` });
    }
    const mwResult2 = await resultPromise;

    test('mw multi: received all 3', mwResult2.messages.length === 3);
    test('mw multi: correct order', mwResult2.messages.every((m, i) => m.id === i));
  }

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: Worker Sends via MessagePort');
  // ─────────────────────────────────────────────────────────────

  {
    const mw = new MWChannel('m');
    const [initMsg, transfer] = mw.postInit(null);
    const worker = new Worker(__filename);

    let readyResolve, resultResolve, resultReject;
    const readyPromise = new Promise(r => { readyResolve = r; });
    const resultPromise = new Promise((r, j) => { resultResolve = r; resultReject = j; });
    const timeout = setTimeout(() => { worker.terminate(); resultReject(new Error('Timeout')); }, 5000);
    worker.on('message', (msg) => {
      if (msg.status === 'ready') readyResolve();
      else if (msg.result !== undefined) { clearTimeout(timeout); resultResolve(msg.result); }
      else if (msg.error) { clearTimeout(timeout); resultReject(new Error(msg.error)); }
    });

    await readyPromise;
    worker.postMessage({ test: 'test_mw_worker_sends', mwInit: initMsg, options: { count: 3 } }, transfer);

    // Receive worker's messages via MWChannel onmessage (native MessagePort)
    const received = [];
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('mw receive timeout')), 5000);
      mw.onmessage = (e) => {
        received.push(e.data);
        if (received.length >= 3) {
          clearTimeout(t);
          mw.onmessage = null;
          resolve();
        }
      };
    });
    await resultPromise;

    test('mw worker sends: received all 3', received.length === 3);
    test('mw worker sends: correct order', received.every((m, i) => m.id === i));
    assertEqual('mw worker sends: content', received[0].data, 'mw-msg-0');
  }

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: Mode Switching');
  // ─────────────────────────────────────────────────────────────

  {
    const mw = new MWChannel('m');
    const [initMsg, transfer] = mw.postInit(null);
    const worker = new Worker(__filename);

    let readyResolve, blockingResolve, resultResolve, resultReject;
    const readyPromise = new Promise(r => { readyResolve = r; });
    const blockingPromise = new Promise(r => { blockingResolve = r; });
    const resultPromise = new Promise((r, j) => { resultResolve = r; resultReject = j; });
    const timeout = setTimeout(() => { worker.terminate(); resultReject(new Error('Timeout')); }, 10000);
    worker.on('message', (msg) => {
      if (msg.status === 'ready') readyResolve();
      else if (msg.status === 'blocking') blockingResolve();
      else if (msg.result !== undefined) { clearTimeout(timeout); resultResolve(msg.result); }
      else if (msg.error) { clearTimeout(timeout); resultReject(new Error(msg.error)); }
    });

    await readyPromise;
    worker.postMessage({ test: 'test_mw_mode_switch', mwInit: initMsg, options: { nbCount: 2 } }, transfer);
    await blockingPromise;

    // Phase 1: Send one message in blocking mode (SABPipe)
    await mw.postMessage({ phase: 'blocking', id: 0 });

    // Wait for worker to switch to nonblocking and signal ready
    await new Promise((resolve) => {
      mw.onmessage = (e) => {
        if (e.data.status === 'nb_ready') {
          mw.onmessage = null;
          resolve();
        }
      };
    });

    // Phase 2: Switch main to nonblocking mode, send via native port
    mw.setMode('nonblocking');
    mw.postMessage({ phase: 'nonblocking', id: 1 });
    mw.postMessage({ phase: 'nonblocking', id: 2 });

    // Wait for worker to switch back to blocking and signal
    await new Promise((resolve) => {
      mw.onmessage = (e) => {
        if (e.data.status === 'blocking_again') {
          mw.onmessage = null;
          resolve();
        }
      };
    });

    // Phase 3: Switch main back to blocking mode, send via SABPipe
    mw.setMode('blocking');
    await mw.postMessage({ phase: 'blocking2', id: 3 });

    const mwResult4 = await resultPromise;

    assertEqual('mw mode switch: blocking msg', mwResult4.blockingMsg?.phase, 'blocking');
    test('mw mode switch: nb received 2', mwResult4.nbReceived.length === 2);
    test('mw mode switch: nb correct', mwResult4.nbReceived.every((m, i) => m.id === i + 1));
    assertEqual('mw mode switch: blocking2 msg', mwResult4.blockingMsg2?.phase, 'blocking2');
  }

  // ─────────────────────────────────────────────────────────────
  group('MWChannel: close');
  // ─────────────────────────────────────────────────────────────

  {
    const mw = new MWChannel('m');
    mw.close();
    let mwWriteAfterClose = null;
    try { await mw.postMessage({ test: 1 }); } catch (e) { mwWriteAfterClose = e; }
    test('mw close: postMessage throws', mwWriteAfterClose !== null);
  }

  // ─────────────────────────────────────────────────────────────
  group('tryPeek');
  // ─────────────────────────────────────────────────────────────

  // tryPeek on empty pipe
  {
    const t1 = runWorkerTest('test_peek_empty', new SharedArrayBuffer(131072), { testTimeout: 3000 });
    await t1.ready();
    const peekResult = await t1.result;
    test('tryPeek: returns null when empty', peekResult.peeked === null);
  }

  // tryPeek returns message without consuming (batch: marker + data)
  {
    const peekSab = new SharedArrayBuffer(131072);
    const writer = new SABPipe('w', peekSab);
    const t2 = runWorkerTest('test_peek_available', peekSab, { testTimeout: 5000 });
    await t2.ready();
    await new Promise(r => setTimeout(r, 50));
    // Send two messages as a batch (no await between)
    writer.postMessage({ marker: true });
    await writer.postMessage({ hello: 'peek' });
    const peekResult = await t2.result;
    assertEqual('tryPeek: peeked message', peekResult.peeked?.hello, 'peek');
    assertEqual('tryPeek: read same message', peekResult.read?.hello, 'peek');
    test('tryPeek: null after consumed', peekResult.peekAfter === null);
  }

  // tryPeek repeated returns same message (batch: marker + data)
  {
    const peekSab = new SharedArrayBuffer(131072);
    const writer = new SABPipe('w', peekSab);
    const t3 = runWorkerTest('test_peek_repeated', peekSab, { testTimeout: 5000 });
    await t3.ready();
    await new Promise(r => setTimeout(r, 50));
    writer.postMessage({ marker: true });
    await writer.postMessage({ id: 42 });
    const peekResult = await t3.result;
    assertEqual('tryPeek: first peek', peekResult.peek1?.id, 42);
    assertEqual('tryPeek: second peek same', peekResult.peek2?.id, 42);
    assertEqual('tryPeek: read consumes', peekResult.read?.id, 42);
    test('tryPeek: null after read', peekResult.peek3 === null);
  }

  // tryPeek on SABMessagePort (batch: marker + data)
  {
    const peekSab = new SharedArrayBuffer(256 * 1024);
    const peekPort = new SABMessagePort('a', peekSab);
    const t4 = runWorkerTest('test_peek_bidi', peekSab, {
      waitForBlocking: true, testTimeout: 5000
    });
    await t4.ready();
    peekPort.postMessage({ marker: true });
    await peekPort.postMessage({ bidi: 'peek-test' });
    const peekResult = await t4.result;
    assertEqual('tryPeek bidi: peeked', peekResult.peeked?.bidi, 'peek-test');
    assertEqual('tryPeek bidi: read same', peekResult.read?.bidi, 'peek-test');
    test('tryPeek bidi: null after', peekResult.peekAfter === null);
  }

  // tryPeek on MWChannel
  {
    const mw = new MWChannel('m');
    const [initMsg, transfer] = mw.postInit(null);
    const w = new Worker(__filename);

    let readyResolve, resultResolve, resultReject;
    const readyPromise = new Promise(r => { readyResolve = r; });
    const resultPromise = new Promise((r, j) => { resultResolve = r; resultReject = j; });
    const t = setTimeout(() => { w.terminate(); resultReject(new Error('Timeout')); }, 5000);
    w.on('message', msg => {
      if (msg.status === 'ready') readyResolve();
      else if (msg.result !== undefined) { clearTimeout(t); resultResolve(msg.result); }
      else if (msg.error) { clearTimeout(t); resultReject(new Error(msg.error)); }
    });

    await readyPromise;
    w.postMessage({ test: 'test_mw_peek', mwInit: initMsg, options: {} }, transfer);
    await new Promise(r => setTimeout(r, 50));
    mw.postMessage({ marker: true });
    await mw.postMessage({ mw: 'peek-mw' });
    const mwPeekResult = await resultPromise;
    w.terminate();

    assertEqual('tryPeek mw: peeked', mwPeekResult.peeked?.mw, 'peek-mw');
    assertEqual('tryPeek mw: read same', mwPeekResult.read?.mw, 'peek-mw');
    test('tryPeek mw: null after', mwPeekResult.peekAfter === null);
  }

  // ─────────────────────────────────────────────────────────────
  group('Round-Trip Comparison');
  // ─────────────────────────────────────────────────────────────

  const RT_ITERATIONS = 1000;
  const RT_MSG = { id: 0, data: 'x'.repeat(100) };
  const rtMsgBytes = JSON.stringify(RT_MSG).length;
  const rtTotalBytes = rtMsgBytes * 2 * RT_ITERATIONS; // both directions
  const rtResults = [];

  perf('Config', `${RT_ITERATIONS} round-trips, msg size: ${rtMsgBytes} bytes`);

  // 1. Native MessagePort round-trip
  {
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(__filename);
    await new Promise(resolve => {
      const h = msg => { if (msg.status === 'ready') { w.removeListener('message', h); resolve(); } };
      w.on('message', h);
    });

    const wResult = new Promise((resolve, reject) => {
      const t = setTimeout(() => { w.terminate(); reject(new Error('Timeout')); }, 60000);
      w.on('message', msg => { if (msg.result) { clearTimeout(t); resolve(msg.result); } });
    });

    w.postMessage(
      { test: 'test_perf_messageport', options: { iterations: RT_ITERATIONS }, port: port2 },
      [port2]
    );

    let rtNativeCount = 0;
    const rtNativeStart = performance.now();

    await new Promise(resolve => {
      port1.on('message', () => {
        rtNativeCount++;
        if (rtNativeCount < RT_ITERATIONS) {
          port1.postMessage(RT_MSG);
        } else {
          resolve();
        }
      });
      port1.postMessage(RT_MSG);
    });

    const rtNativeTime = performance.now() - rtNativeStart;
    await wResult;
    w.terminate();
    port1.close();

    const rtNativeLatency = rtNativeTime / RT_ITERATIONS * 1000;
    const rtNativeMBps = (rtTotalBytes / 1024 / 1024) / (rtNativeTime / 1000);
    const rtNativeMps = RT_ITERATIONS / (rtNativeTime / 1000);
    rtResults.push({ name: 'Native MessagePort', time: rtNativeTime, latency: rtNativeLatency, mbps: rtNativeMBps, mps: rtNativeMps });
    test('RT native: all round-trips', rtNativeCount === RT_ITERATIONS);
    perf(`1. Native MessagePort`, `${rtNativeTime.toFixed(1)}ms, ${rtNativeLatency.toFixed(1)}µs/rt, ${Math.round(rtNativeMps)} msg/s, ${rtNativeMBps.toFixed(2)} MB/s`);
  }

  // 2. SABMessagePort async round-trip
  {
    const rtSab = new SharedArrayBuffer(256 * 1024);
    const rtPort = new SABMessagePort('a', rtSab);

    const t2 = runWorkerTest('test_roundtrip_sab_async', rtSab, {
      iterations: RT_ITERATIONS, waitForBlocking: true, testTimeout: 60000
    });
    await t2.ready();

    let rtAsyncCount = 0;
    const rtAsyncStart = performance.now();
    for (let i = 0; i < RT_ITERATIONS; i++) {
      await rtPort.postMessage(RT_MSG);
      const reply = await rtPort.asyncRead(5000);
      if (reply) rtAsyncCount++;
    }
    const rtAsyncTime = performance.now() - rtAsyncStart;
    await t2.result;

    const rtAsyncLatency = rtAsyncTime / RT_ITERATIONS * 1000;
    const rtAsyncMBps = (rtTotalBytes / 1024 / 1024) / (rtAsyncTime / 1000);
    const rtAsyncMps = RT_ITERATIONS / (rtAsyncTime / 1000);
    rtResults.push({ name: 'SABMessagePort async', time: rtAsyncTime, latency: rtAsyncLatency, mbps: rtAsyncMBps, mps: rtAsyncMps });
    test('RT SAB async: all round-trips', rtAsyncCount === RT_ITERATIONS);
    perf(`2. SABMessagePort async`, `${rtAsyncTime.toFixed(1)}ms, ${rtAsyncLatency.toFixed(1)}µs/rt, ${Math.round(rtAsyncMps)} msg/s, ${rtAsyncMBps.toFixed(2)} MB/s`);
  }

  // 3. SABMessagePort blocking worker round-trip
  {
    const rtSab = new SharedArrayBuffer(256 * 1024);
    const rtPort = new SABMessagePort('a', rtSab);

    const t3 = runWorkerTest('test_roundtrip_sab_blocking', rtSab, {
      iterations: RT_ITERATIONS, waitForBlocking: true, testTimeout: 60000
    });
    await t3.ready();

    let rtBlockCount = 0;
    const rtBlockStart = performance.now();
    for (let i = 0; i < RT_ITERATIONS; i++) {
      await rtPort.postMessage(RT_MSG);
      const reply = await rtPort.asyncRead(5000);
      if (reply) rtBlockCount++;
    }
    const rtBlockTime = performance.now() - rtBlockStart;
    await t3.result;

    const rtBlockLatency = rtBlockTime / RT_ITERATIONS * 1000;
    const rtBlockMBps = (rtTotalBytes / 1024 / 1024) / (rtBlockTime / 1000);
    const rtBlockMps = RT_ITERATIONS / (rtBlockTime / 1000);
    rtResults.push({ name: 'SABMessagePort blocking', time: rtBlockTime, latency: rtBlockLatency, mbps: rtBlockMBps, mps: rtBlockMps });
    test('RT SAB blocking: all round-trips', rtBlockCount === RT_ITERATIONS);
    perf(`3. SABMessagePort blocking`, `${rtBlockTime.toFixed(1)}ms, ${rtBlockLatency.toFixed(1)}µs/rt, ${Math.round(rtBlockMps)} msg/s, ${rtBlockMBps.toFixed(2)} MB/s`);
  }

  // 4. MWChannel blocking worker round-trip
  {
    const mw = new MWChannel('m');
    const [initMsg, transfer] = mw.postInit(null);
    const w = new Worker(__filename);

    let readyResolve, blockingResolve, resultResolve, resultReject;
    const readyPromise = new Promise(r => { readyResolve = r; });
    const blockingPromise = new Promise(r => { blockingResolve = r; });
    const resultPromise = new Promise((r, j) => { resultResolve = r; resultReject = j; });
    const rtTimeout = setTimeout(() => { w.terminate(); resultReject(new Error('Timeout')); }, 60000);
    w.on('message', msg => {
      if (msg.status === 'ready') readyResolve();
      else if (msg.status === 'blocking') blockingResolve();
      else if (msg.result !== undefined) { clearTimeout(rtTimeout); resultResolve(msg.result); }
      else if (msg.error) { clearTimeout(rtTimeout); resultReject(new Error(msg.error)); }
    });

    await readyPromise;
    w.postMessage({ test: 'test_roundtrip_mw_blocking', mwInit: initMsg, options: { iterations: RT_ITERATIONS } }, transfer);
    await blockingPromise;

    let rtMwCount = 0;
    const rtMwStart = performance.now();

    await new Promise((resolve) => {
      mw.onmessage = (e) => {
        rtMwCount++;
        if (rtMwCount < RT_ITERATIONS) {
          mw.postMessage(RT_MSG);
        } else {
          mw.onmessage = null;
          resolve();
        }
      };
      mw.postMessage(RT_MSG);
    });

    const rtMwTime = performance.now() - rtMwStart;
    await resultPromise;
    w.terminate();

    const rtMwLatency = rtMwTime / RT_ITERATIONS * 1000;
    const rtMwMBps = (rtTotalBytes / 1024 / 1024) / (rtMwTime / 1000);
    const rtMwMps = RT_ITERATIONS / (rtMwTime / 1000);
    rtResults.push({ name: 'MWChannel blocking', time: rtMwTime, latency: rtMwLatency, mbps: rtMwMBps, mps: rtMwMps });
    test('RT MWChannel: all round-trips', rtMwCount === RT_ITERATIONS);
    perf(`4. MWChannel blocking`, `${rtMwTime.toFixed(1)}ms, ${rtMwLatency.toFixed(1)}µs/rt, ${Math.round(rtMwMps)} msg/s, ${rtMwMBps.toFixed(2)} MB/s`);
  }

  // Round-trip ranking
  rtResults.sort((a, b) => a.time - b.time);
  const rtFastest = rtResults[0];
  perf('Ranking', rtResults.map((r, i) =>
    `${i + 1}. ${r.name}: ${r.latency.toFixed(1)}µs/rt, ${Math.round(r.mps)} msg/s, ${r.mbps.toFixed(2)} MB/s (${(r.time / rtFastest.time).toFixed(2)}x)`
  ).join(', '));

  // ─────────────────────────────────────────────────────────────
  summary();
}

// Only run tests in main thread
if (isMainThread) {
  runTests().catch(err => {
    console.error(`${RED}Test runner error: ${err.message}${RESET}`);
    console.error(err.stack);
    process.exit(1);
  });
}
