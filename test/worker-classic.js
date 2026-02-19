/**
 * SABPipe Classic Worker Test (Browser — importScripts)
 */

importScripts('../dist/SABMessagePort.global.min.js');
const { SABPipe, SABMessagePort, MWChannel } = SABMessagePortLib;

self.onmessage = (e) => {
  const { test, sab, options } = e.data;
  try {
    const handler = handlers[test];
    if (!handler) throw new Error(`Unknown test: ${test}`);
    handler(sab, options);
  } catch (err) {
    self.postMessage({ status: 'error', error: err.message });
  }
};

const handlers = {
  test_classic_read_echo(sab) {
    const reader = new SABPipe('r', sab);
    const msg = reader.read(3000);
    self.postMessage({ result: { echo: msg, isWriter: reader.isWriter, isReader: reader.isReader } });
    reader.destroy();
  },

  async test_classic_bidi(sab) {
    const port = SABMessagePort.from({ type: 'SABMessagePort', buffer: sab });
    const msg = port.read(3000);
    await port.postMessage({ echo: msg, fromClassicWorker: true });
    // Don't close here — destroy() overwrites rw_signal with DISPOSED
    // before the main thread reads the data. Worker termination cleans up.
    self.postMessage({ result: 'done' });
  }
};

self.postMessage({ status: 'ready' });
