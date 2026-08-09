import { SerialPort } from 'serialport';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal Web Serial adapter over `serialport` for hardware regressions. */
export class NodeWebSerialPort {
  constructor(path, info, closeCaptureMs = 0) {
    this.path = path;
    this.info = info;
    this.closeCaptureMs = closeCaptureMs;
    this.port = undefined;
    this.queue = [];
    this.resolvers = [];
    this.readerCancelled = false;
    this.portClosed = false;
    this.readerLocked = false;
    this.writerLocked = false;
    this.dtr = false;
    this.rts = false;
    this.serialText = [];
  }

  getInfo() {
    return {
      ...(parseUsbId(this.info.vendorId, 'vendorId') ?? {}),
      ...(parseUsbId(this.info.productId, 'productId') ?? {}),
    };
  }

  async open(options = {}) {
    if (this.port?.isOpen) throw new Error('serial port is already open');

    this.readerCancelled = false;
    this.portClosed = false;
    this.queue = [];
    this.resolvers = [];
    const port = new SerialPort({
      path: this.path,
      baudRate: options.baudRate ?? 115200,
      autoOpen: false,
    });
    port.on('data', (chunk) => {
      const bytes = new Uint8Array(chunk);
      this.serialText.push(new TextDecoder().decode(bytes));
      if (this.readerCancelled || this.portClosed) return;
      const resolve = this.resolvers.shift();
      if (resolve) resolve({ value: bytes, done: false });
      else this.queue.push(bytes);
    });
    this.port = port;
    await new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
  }

  get readable() {
    if (!this.port) return undefined;
    const self = this;
    return {
      get locked() { return self.readerLocked; },
      getReader() {
        if (self.readerLocked) throw new Error('readable stream is already locked');
        self.readerLocked = true;
        let released = false;
        return {
          async read() {
            if (self.readerCancelled || self.portClosed) return { done: true };
            const queued = self.queue.shift();
            if (queued) return { value: queued, done: false };
            return new Promise((resolve) => self.resolvers.push(resolve));
          },
          async cancel() {
            // Keep the native listener alive to capture output after reset.
            self.readerCancelled = true;
            self.resolvers.splice(0).forEach((resolve) => resolve({ done: true }));
          },
          releaseLock() {
            if (!released) {
              released = true;
              self.readerLocked = false;
            }
          },
        };
      },
    };
  }

  get writable() {
    if (!this.port) return undefined;
    const self = this;
    return {
      get locked() { return self.writerLocked; },
      getWriter() {
        if (self.writerLocked) throw new Error('writable stream is already locked');
        self.writerLocked = true;
        let released = false;
        return {
          async write(data) {
            const port = self.requireOpenPort();
            await new Promise((resolve, reject) => {
              port.write(Buffer.from(data), (error) => {
                if (error) return reject(error);
                port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
              });
            });
          },
          releaseLock() {
            if (!released) {
              released = true;
              self.writerLocked = false;
            }
          },
        };
      },
    };
  }

  async setSignals(signals) {
    if (signals.dataTerminalReady !== undefined) this.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.rts = signals.requestToSend;
    const port = this.requireOpenPort();
    await new Promise((resolve, reject) =>
      port.set({ dtr: this.dtr, rts: this.rts }, (error) => (error ? reject(error) : resolve())),
    );
  }

  async close() {
    if (this.closeCaptureMs > 0) await sleep(this.closeCaptureMs);
    this.readerCancelled = true;
    this.portClosed = true;
    this.resolvers.splice(0).forEach((resolve) => resolve({ done: true }));
    const port = this.port;
    this.port = undefined;
    if (!port?.isOpen) return;
    await new Promise((resolve) => port.close(() => resolve()));
  }

  capturedText() {
    return this.serialText.join('');
  }

  requireOpenPort() {
    if (!this.port?.isOpen) throw new Error('serial port is not open');
    return this.port;
  }
}

function parseUsbId(value, kind) {
  if (typeof value !== 'string' || !/^[0-9a-f]{4}$/i.test(value)) return undefined;
  return { [`usb${kind[0].toUpperCase()}${kind.slice(1)}`]: Number.parseInt(value, 16) };
}
