/**
 * ESP32 浏览器烧录 —— 基于乐鑫官方 esptool-js。
 *
 * 与 AVR 的 STK500 不同，ESP32 的烧录要分四片写到不同偏移：
 *   {bootloaderAddr}  bootloader.bin   ← 按 (flash 模式, 频率) 静态
 *   0x8000            partitions.bin   ← 按分区方案静态
 *   0xe000            boot_app0.bin    ← 完全静态
 *   0x10000           firmware.bin     ← 每次编译都变
 *
 * 底座把前三片放在 `staticArtifacts`、最后一片放在 `artifacts`，
 * 前端据此可以做「后续烧录只写 0x10000」的优化。
 *
 * ## 关于跳过静态分片的安全前提
 * 只有在**能证明是同一块芯片**时才跳过 —— 用 MAC 地址做设备标识。
 * 拿不到 MAC 就老老实实全写：给一块没有 bootloader 的新板子只写 0x10000，
 * 结果是它根本起不来，而用户完全不知道为什么。
 * 省那两三秒，不值得冒这个险。
 */

import { ESPLoader, Transport } from './vendor/esptool.js';
import { artifactBytes } from './artifacts.js';

/** 本页会话内已完整烧录过的设备：MAC → 静态分片指纹 */
const flashedDevices = new Map();

const USB_JTAG_SERIAL_PID = 0x1001;
const UART_RESET_HOLD_MS = 100;
const UART_RESET_SETTLE_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Native USB-JTAG is not wired like a conventional UART bridge. */
export function isUsbJtagSerial(transport) {
  return transport?.getPid?.() === USB_JTAG_SERIAL_PID;
}

/** Detect native USB-OTG on targets that expose the esptool-js probe. */
export async function isUsbOtg(loader) {
  const chip = loader?.chip;
  const probe = chip?.usesUsbOtg ?? chip?.usingUsbOtg;
  return typeof probe === 'function' && await probe.call(chip, loader);
}

/**
 * Run firmware after flashing through a conventional UART bridge.
 *
 * DTR controls GPIO0 and RTS controls EN on the usual CH340/CP210x reset
 * circuit. esptool-js's default after() only releases RTS; that does not
 * reset a board when RTS was already released after entering the bootloader.
 */
export async function resetEspUartToRun(transport, delay = sleep) {
  let resetCompleted = false;
  try {
    await transport.setDTR(false); // Release GPIO0 before resetting.
    await transport.setRTS(true); // Hold EN low.
    await delay(UART_RESET_HOLD_MS);
    await transport.setRTS(false); // Release EN and boot the flashed image.
    await delay(UART_RESET_SETTLE_MS);
    resetCompleted = true;
  } finally {
    // Do not leave GPIO0 or EN asserted if Web Serial is closed immediately.
    let cleanupError;
    try {
      await transport.setDTR(false);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await transport.setRTS(false);
    } catch (error) {
      cleanupError ??= error;
    }
    // Preserve an earlier reset failure while still attempting both releases.
    if (resetCompleted && cleanupError) throw cleanupError;
  }
}

/** Select the reset mechanism that matches the active serial transport. */
export async function resetEspAfterFlash(loader, transport, delay = sleep) {
  if (isUsbJtagSerial(transport)) {
    // Keep esptool-js's existing post-flash behavior. Its second after()
    // argument means USB-OTG, which is not interchangeable with USB-JTAG.
    await loader.after();
    return;
  }
  if (await isUsbOtg(loader)) {
    await loader.after('hard_reset', true);
    return;
  }
  await resetEspUartToRun(transport, delay);
}

function effectiveUploadSpeed(board, options) {
  const upload = board?.upload ?? {};
  for (const [optionId, byValue] of Object.entries(upload.speedByOption ?? {})) {
    const speed = byValue?.[options?.[optionId]];
    if (Number.isFinite(speed) && speed > 0) return speed;
  }
  return upload.speed ?? 921600;
}

function effectiveFlashSettings(board, options) {
  let mode = options?.flash_mode ?? 'dio';
  let frequency = options?.flash_freq ?? '40m';
  for (const [optionId, byValue] of Object.entries(board?.upload?.flashByOption ?? {})) {
    const setting = byValue?.[options?.[optionId]];
    if (!setting) continue;
    mode = setting.mode;
    frequency = setting.frequency;
  }
  return { mode, frequency };
}

function shouldEraseAll(board, options) {
  for (const [optionId, byValue] of Object.entries(board?.upload?.eraseAllByOption ?? {})) {
    const eraseAll = byValue?.[options?.[optionId]];
    if (typeof eraseAll === 'boolean') return eraseAll;
  }
  return false;
}

/**
 * @param {SerialPort} port         已 requestPort() 拿到、**未 open** 的端口
 * @param {object} result           底座返回的 CompileSuccess
 * @param {object} board            GET /v1/boards 里的板子信息
 * @param {object} options          当前选中的编译选项（flash 模式/频率/容量）
 * @param {(msg: string, pct?: number) => void} onProgress
 */
export async function flashEsp32(port, result, board, options, onProgress = () => {}) {
  const transport = new Transport(port);
  const flash = effectiveFlashSettings(board, options);
  const eraseAll = shouldEraseAll(board, options);

  // esptool-js 会往 terminal 写握手日志，转成进度提示比直接丢掉有用
  const terminal = {
    clean() {},
    writeLine(data) { if (data && data.trim()) onProgress(data.trim()); },
    write(data) { if (data && data.trim() && data.length > 3) onProgress(data.trim()); },
  };

  const loader = new ESPLoader({
    transport,
    baudrate: effectiveUploadSpeed(board, options),
    // 握手阶段必须用 115200，协商成功后再切到高速
    romBaudrate: 115200,
    terminal,
  });

  let chip = '';
  try {
    onProgress('连接芯片…', 2);
    chip = await loader.main();
    onProgress(`已连接：${chip}`, 8);

    // ---- 设备标识：只有确认是同一块芯片才敢跳过静态分片 ----
    let deviceId = null;
    try {
      deviceId = await loader.chip.readMac(loader);
    } catch {
      deviceId = null; // 拿不到就全写
    }

    const statics = result.staticArtifacts ?? [];
    const staticFingerprint = statics.map((a) => a.sha256).join(',');
    // A full-chip erase also removes bootloader and partition data. Never
    // reuse the static-part shortcut in that mode, even for a known device.
    const alreadyFlashed =
      !eraseAll && deviceId !== null && flashedDevices.get(deviceId) === staticFingerprint;

    const files = [];
    if (!alreadyFlashed) {
      for (const a of statics) {
        files.push({ data: await artifactBytes(a), address: parseInt(a.offset, 16) });
      }
    }
    for (const a of result.artifacts) {
      files.push({ data: await artifactBytes(a), address: parseInt(a.offset ?? '0x10000', 16) });
    }

    const totalBytes = files.reduce((s, f) => s + f.data.length, 0);
    onProgress(
      alreadyFlashed
        ? `仅更新程序（${(totalBytes / 1024).toFixed(0)} KB）`
        : `完整烧录 ${files.length} 个分片（${(totalBytes / 1024).toFixed(0)} KB）`,
      10,
    );

    await loader.writeFlash({
      fileArray: files,
      flashMode: flash.mode,
      flashFreq: flash.frequency,
      flashSize: options.flash_size ?? 'keep',
      eraseAll,
      compress: true,
      reportProgress: (idx, written, total) => {
        // 各分片合起来算一个总进度，别让进度条来回跳
        const before = files.slice(0, idx).reduce((s, f) => s + f.data.length, 0);
        const pct = 10 + Math.round(((before + written) / totalBytes) * 85);
        onProgress(`写入 ${files[idx] ? '0x' + files[idx].address.toString(16) : ''} ${written}/${total}`, pct);
      },
    });

    if (deviceId !== null) flashedDevices.set(deviceId, staticFingerprint);

    onProgress('复位…', 98);
    await resetEspAfterFlash(loader, transport);
    onProgress(`烧录完成，共写入 ${(totalBytes / 1024).toFixed(0)} KB`, 100);
    return totalBytes;
  } finally {
    // Transport 持有 reader/writer 锁，不释放的话串口监视器打不开
    try { await transport.disconnect(); } catch { /* 忽略 */ }
  }
}

/** 让上层能重置"已完整烧录"的记忆（例如用户手动选择完整烧录） */
export function forgetFlashedDevices() {
  flashedDevices.clear();
}
