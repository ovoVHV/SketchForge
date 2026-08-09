/**
 * STK500v1 —— 浏览器里直接烧录 Arduino Uno / Nano。
 *
 * 这就是"用户零安装"的兑现方式：不需要 avrdude、不需要 arduino-cli、
 * 不需要任何本地 agent，Web Serial 直接对着板子的 bootloader 说话。
 *
 * 浏览器支持（2026-07）：Chrome/Edge/Opera 89+、Firefox 151+；Safari 与 iOS 不支持。
 * 必须 HTTPS（localhost 例外）。
 *
 * 协议参考 avrdude 的 stk500 实现；页大小按 ATmega328P 的 128 字节。
 */

const STK = {
  OK: 0x10,
  INSYNC: 0x14,
  CRC_EOP: 0x20,
  GET_SYNC: 0x30,
  ENTER_PROGMODE: 0x50,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  PROG_PAGE: 0x64,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时的串口读缓冲 */
class SerialReader {
  constructor(port) {
    this.reader = port.readable.getReader();
    this.buf = new Uint8Array(0);
    this.closed = false;
    this.pump();
  }

  async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          const next = new Uint8Array(this.buf.length + value.length);
          next.set(this.buf, 0);
          next.set(value, this.buf.length);
          this.buf = next;
        }
      }
    } catch {
      /* 端口关闭，正常退出 */
    } finally {
      this.closed = true;
    }
  }

  /** 读满 n 字节，超时抛错 */
  async read(n, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (Date.now() > deadline) {
        throw new Error(`串口读取超时（期望 ${n} 字节，实际 ${this.buf.length} 字节）`);
      }
      await sleep(5);
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  flush() {
    this.buf = new Uint8Array(0);
  }

  async release() {
    try { await this.reader.cancel(); } catch { /* 忽略 */ }
    try { this.reader.releaseLock(); } catch { /* 忽略 */ }
  }
}

/**
 * 解析 Intel HEX 为连续的二进制映像。
 * AVR sketch 均小于 64KB，因此只需处理记录类型 00(数据) 和 01(结束)。
 */
export function parseIntelHex(text) {
  const bytes = [];
  let maxAddr = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== ':') continue;

    const count = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);

    if (type === 1) break;          // EOF
    if (type !== 0) continue;       // 扩展地址记录，AVR 用不到

    // 校验和：所有字节之和的低 8 位取补应为 0
    let sum = 0;
    for (let i = 1; i < line.length; i += 2) sum += parseInt(line.substr(i, 2), 16);
    if ((sum & 0xff) !== 0) throw new Error(`HEX 校验和错误：${line.slice(0, 16)}…`);

    for (let i = 0; i < count; i++) {
      bytes[addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
    }
    maxAddr = Math.max(maxAddr, addr + count);
  }

  const out = new Uint8Array(maxAddr);
  for (let i = 0; i < maxAddr; i++) out[i] = bytes[i] ?? 0xff;
  return out;
}

export class Stk500Flasher {
  /**
   * @param {SerialPort} port  已 open 的 Web Serial 端口
   * @param {(msg: string, pct?: number) => void} onProgress
   */
  constructor(port, onProgress = () => {}) {
    this.port = port;
    this.onProgress = onProgress;
    this.pageSize = 128; // ATmega328P
  }

  async write(data) {
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new Uint8Array(data));
    } finally {
      writer.releaseLock();
    }
  }

  /** 发一条命令并校验 INSYNC/OK 应答 */
  async cmd(bytes, timeoutMs = 1000) {
    await this.write([...bytes, STK.CRC_EOP]);
    const resp = await this.reader.read(2, timeoutMs);
    if (resp[0] !== STK.INSYNC) {
      throw new Error(`协议不同步：期望 0x14，收到 0x${resp[0].toString(16)}`);
    }
    if (resp[1] !== STK.OK) {
      throw new Error(`命令被拒绝：期望 0x10，收到 0x${resp[1].toString(16)}`);
    }
  }

  /**
   * 拉低 DTR/RTS 触发板载自动复位，把 MCU 拽进 bootloader。
   * 时序对不同批次的板子有差异，因此后面的 sync 会重试多次。
   */
  async reset() {
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(100);
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await sleep(100);
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(300);
  }

  /** bootloader 窗口很短且时序不稳，多试几次（avrdude 也是这么干的） */
  async sync(attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      try {
        this.reader.flush();
        await this.cmd([STK.GET_SYNC], 400);
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error('无法与 bootloader 同步。请确认：板子已连接、选对了串口、且没有被串口监视器占用。');
  }

  async flash(hexText) {
    const image = parseIntelHex(hexText);
    this.reader = new SerialReader(this.port);

    try {
      this.onProgress('复位板子…', 0);
      await this.reset();

      this.onProgress('与 bootloader 同步…', 5);
      await this.sync();

      this.onProgress('进入编程模式…', 10);
      await this.cmd([STK.ENTER_PROGMODE]);

      const pages = Math.ceil(image.length / this.pageSize);
      for (let p = 0; p < pages; p++) {
        const offset = p * this.pageSize;
        const chunk = image.slice(offset, Math.min(offset + this.pageSize, image.length));

        // STK_LOAD_ADDRESS 用的是**字地址**（字节地址 / 2）
        const wordAddr = offset >> 1;
        await this.cmd([STK.LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff]);

        await this.cmd([
          STK.PROG_PAGE,
          (chunk.length >> 8) & 0xff,
          chunk.length & 0xff,
          0x46, // 'F' = flash
          ...chunk,
        ], 2000);

        this.onProgress(
          `写入 ${offset + chunk.length}/${image.length} 字节`,
          10 + Math.round(((p + 1) / pages) * 85),
        );
      }

      await this.cmd([STK.LEAVE_PROGMODE]);
      this.onProgress(`完成，共写入 ${image.length} 字节`, 100);
      return image.length;
    } finally {
      await this.reader.release();
    }
  }
}

export const webSerialSupported = () => 'serial' in navigator;
