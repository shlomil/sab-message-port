/**
 * SABPipe Test Worker (Browser)
 */

import { SABPipe, SABMessagePort } from '../src/SABMessagePort.js';

const handlers = {
  // Basic read and echo
  test_read_echo(sab) {
    const ch = new SABPipe('r', sab);
    const msg = ch.read();
    self.postMessage({ result: { received: msg, from: 'worker' } });
  },

  // tryRead when no data
  test_try_read_empty(sab) {
    const ch = new SABPipe('r', sab);
    const msg = ch.tryRead();
    self.postMessage({ result: { received: msg, wasNull: msg === null } });
  },

  // tryRead when data ready (spin until available)
  test_try_read_ready(sab) {
    const ch = new SABPipe('r', sab);
    let msg = null;
    const start = Date.now();
    while (msg === null && Date.now() - start < 2000) {
      msg = ch.tryRead();
    }
    self.postMessage({ result: { received: msg } });
  },

  // Read with timeout
  test_read_timeout(sab, options) {
    const ch = new SABPipe('r', sab);
    const timeout = options.timeout || 100;
    const start = Date.now();
    const msg = ch.read(timeout);
    const elapsed = Date.now() - start;
    self.postMessage({ result: { received: msg, elapsed } });
  },

  // Read multiple messages
  test_read_multiple(sab, options) {
    const ch = new SABPipe('r', sab);
    const count = options.count || 3;
    const messages = [];
    for (let i = 0; i < count; i++) {
      const msg = ch.read();
      messages.push(msg);
    }
    self.postMessage({ result: { messages } });
  },

  // Read large multipart message
  test_read_multipart(sab) {
    const ch = new SABPipe('r', sab);
    const msg = ch.read(30000);
    self.postMessage({
      result: {
        received: msg !== null,
        length: msg ? msg.length : 0,
        first: msg ? msg[0] : null,
        last: msg ? msg[msg.length - 1] : null
      }
    });
  },

  // Read throws when disposed
  test_read_disposed(sab) {
    const ch = new SABPipe('r', sab);
    try {
      ch.read();
      self.postMessage({ result: { threw: false } });
    } catch (err) {
      self.postMessage({ result: { threw: true, error: err.message } });
    }
  },

  // Performance test
  test_perf_read(sab, options) {
    const ch = new SABPipe('r', sab);
    const iterations = options.iterations || 1000;
    let count = 0;
    for (let i = 0; i < iterations; i++) {
      const msg = ch.read();
      if (msg && msg.id === i) count++;
    }
    self.postMessage({ result: { count } });
  },

  // Read batch
  test_read_batch(sab) {
    const ch = new SABPipe('r', sab);
    const msg = ch.read();
    self.postMessage({
      result: {
        received: msg !== null,
        isArray: Array.isArray(msg),
        length: msg ? msg.length : 0,
        messages: msg
      }
    });
  },

  // Stress: high volume
  test_stress_high_volume(sab, options) {
    const ch = new SABPipe('r', sab);
    const count = options.count || 10000;
    let received = 0;
    let orderOk = true;
    let dataOk = true;
    for (let i = 0; i < count; i++) {
      const msg = ch.read();
      if (!msg || msg.id !== i) orderOk = false;
      if (!msg || msg.v !== i * 2) dataOk = false;
      received++;
    }
    self.postMessage({ result: { received, orderOk, dataOk } });
  },

  // Stress: large payloads
  test_stress_large_payload(sab) {
    const ch = new SABPipe('r', sab);
    const msg = ch.read(60000);
    if (msg === null) {
      self.postMessage({ result: { received: false, length: 0, valid: false } });
      return;
    }
    let valid = true;
    if (!Array.isArray(msg)) {
      valid = false;
    } else {
      for (let i = 0; i < msg.length; i++) {
        if (msg[i] !== i % 256) { valid = false; break; }
      }
    }
    self.postMessage({ result: { received: true, length: msg.length, valid } });
  },

  // Stress: mixed sizes
  test_stress_mixed_sizes(sab, options) {
    const ch = new SABPipe('r', sab);
    const count = options.count || 100;
    let received = 0;
    let allValid = true;
    for (let i = 0; i < count; i++) {
      const msg = ch.read(30000);
      if (msg === null) { allValid = false; break; }
      if (msg.id !== i) allValid = false;
      if (msg.payload.length !== msg.expectedLen) allValid = false;
      received++;
    }
    self.postMessage({ result: { received, allValid } });
  },

  // Stress: sustained throughput
  test_stress_sustained(sab) {
    const ch = new SABPipe('r', sab);
    let count = 0;
    let totalBytes = 0;
    let lastId = -1;
    let orderOk = true;
    while (true) {
      const msg = ch.read(100);
      if (msg === null) break;
      if (msg.id !== lastId + 1) orderOk = false;
      lastId = msg.id;
      totalBytes += JSON.stringify(msg).length;
      count++;
    }
    self.postMessage({ result: { count, totalBytes, orderOk } });
  },

  // Stress: rapid create/destroy - read one message
  test_stress_lifecycle_read(sab) {
    const ch = new SABPipe('r', sab);
    const msg = ch.read(2000);
    self.postMessage({ result: { received: msg !== null, value: msg } });
  },

  // --- Writer handlers for asyncRead tests ---

  async test_async_write_single(sab, options) {
    const ch = new SABPipe('w', sab);
    await ch.postMessage(options.message || { hello: 'async' });
    self.postMessage({ result: { written: true } });
  },

  async test_async_write_multiple(sab, options) {
    const ch = new SABPipe('w', sab);
    const count = options.count || 3;
    for (let i = 0; i < count; i++) {
      await ch.postMessage({ id: i, data: `async-msg-${i}` });
    }
    self.postMessage({ result: { written: count } });
  },

  async test_async_write_multipart(sab, options) {
    const ch = new SABPipe('w', sab);
    const size = options.size || 50000;
    const payload = [];
    for (let i = 0; i < size; i++) payload.push(i);
    await ch.postMessage(payload);
    self.postMessage({ result: { written: true, size } });
  },

  async test_async_dispose(sab, options) {
    const ch = new SABPipe('w', sab);
    await new Promise(r => setTimeout(r, options.delay || 100));
    ch.destroy();
    self.postMessage({ result: { disposed: true } });
  },

  // --- Writer handlers for asyncRead perf/stress tests ---

  async test_async_write_perf(sab, options) {
    const ch = new SABPipe('w', sab);
    const iterations = options.iterations || 1000;
    for (let i = 0; i < iterations; i++) {
      await ch.postMessage(options.testData[i]);
    }
    self.postMessage({ result: { written: iterations } });
  },

  async test_async_write_high_volume(sab, options) {
    const ch = new SABPipe('w', sab);
    const count = options.count || 10000;
    for (let i = 0; i < count; i++) {
      await ch.postMessage({ id: i, v: i * 2 });
    }
    self.postMessage({ result: { written: count } });
  },

  async test_async_write_large_payload(sab, options) {
    const ch = new SABPipe('w', sab);
    const size = options.size || 500000;
    const payload = [];
    for (let i = 0; i < size; i++) payload.push(i % 256);
    await ch.postMessage(payload);
    self.postMessage({ result: { written: true, size } });
  },

  async test_async_write_mixed_sizes(sab, options) {
    const ch = new SABPipe('w', sab);
    const sizes = options.sizes || [];
    const count = sizes.length;
    for (let i = 0; i < count; i++) {
      const payload = 'x'.repeat(sizes[i]);
      await ch.postMessage({ id: i, payload, expectedLen: sizes[i] });
    }
    self.postMessage({ result: { written: count } });
  },

  async test_async_write_sustained(sab, options) {
    const ch = new SABPipe('w', sab);
    const duration = options.duration || 3000;
    let count = 0;
    const start = Date.now();
    while (Date.now() - start < duration) {
      await ch.postMessage({ id: count, data: 'x'.repeat(500) });
      count++;
    }
    self.postMessage({ result: { written: count } });
  },

  // --- SABMessagePort handlers ---

  async test_bidi_echo(sab, options) {
    const port = new SABMessagePort('b', sab);
    const msg = await port.asyncRead(5000);
    await port.postMessage({ echo: msg, from: 'worker' });
    self.postMessage({ result: { done: true } });
  },

  async test_bidi_write_read(sab, options) {
    const port = new SABMessagePort('b', sab);
    const count = options.count || 5;
    for (let i = 0; i < count; i++) {
      await port.postMessage({ id: i, from: 'worker' });
    }
    const echoes = [];
    for (let i = 0; i < count; i++) {
      const msg = await port.asyncRead(5000);
      echoes.push(msg);
    }
    self.postMessage({ result: { written: count, echoes: echoes.length, allOk: echoes.every((m, i) => m.echoId === i) } });
  },

  async test_bidi_onmessage(sab, options) {
    const port = new SABMessagePort('b', sab);
    const count = options.count || 3;
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
    self.postMessage({ result: { received: received.length, allOk: received.every((m, i) => m.id === i) } });
  }
};

self.onmessage = async (e) => {
  const { test, sab, options = {} } = e.data;

  // Special handler for native postMessage one-way write perf test
  if (test === 'test_perf_native_write') {
    const port = e.data.port;
    const testData = options.testData;
    const iterations = testData.length;
    for (let i = 0; i < iterations; i++) {
      port.postMessage(testData[i]);
    }
    self.postMessage({ result: { written: iterations } });
    return;
  }

  // Special handler for MessagePort perf test
  if (test === 'test_perf_messageport') {
    const port = e.data.port;
    const iterations = options.iterations || 1000;
    let count = 0;
    port.onmessage = (ev) => {
      count++;
      port.postMessage(ev.data); // echo back
      if (count >= iterations) {
        self.postMessage({ result: { count } });
      }
    };
    return;
  }

  if (handlers[test]) {
    try {
      await handlers[test](sab, options);
    } catch (err) {
      self.postMessage({ status: 'error', error: err.message, stack: err.stack });
    }
  } else {
    self.postMessage({ status: 'error', error: 'Unknown test: ' + test });
  }
};

self.postMessage({ status: 'ready' });
