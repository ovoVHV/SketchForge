/**
 * Real-hardware regression for the browser ESP32 flashing path.
 *
 * Usage:
 *   npx tsx scripts/flash-esp32-hardware.ts [COM3] [esp32:esp32:esp32]
 *
 * The serial shim lets Node exercise the exact production `flashEsp32()`
 * implementation. It deliberately waits for the stamped serial output after
 * that function's post-flash reset and before closing the physical port, so
 * the verification never depends on a second, manual reset.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerialPort } from 'serialport';
import {
  BoardRegistry,
  CompileService,
  FileL0Cache,
  LibraryRegistry,
  LocalExecutor,
  detectLocalToolchain,
} from '../packages/core/src/index.js';
import { flashEsp32 } from '../packages/web/public/esp32flash.js';
import { NodeWebSerialPort } from './node-web-serial-port.mjs';

const portPath = process.argv[2] ?? 'COM3';
const fqbn = process.argv[3] ?? 'esp32:esp32:esp32';
const stamp = `AF-ESP-${Date.now().toString(36).toUpperCase()}`;

async function compileFirmware() {
  const toolchain = detectLocalToolchain();
  if (!toolchain.esp32) throw new Error('ESP32 toolchain was not detected');

  const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
  const board = boards.get(fqbn);
  if (!board) throw new Error(`board not found: ${fqbn}`);

  const cacheDir = join(toolchain.cacheDir, 'hardware-esp32');
  const service = new CompileService({
    boards,
    toolchain: { ...toolchain, cacheDir },
    executor: new LocalExecutor(),
    cache: new FileL0Cache(join(cacheDir, 'l0')),
    libraries: LibraryRegistry.fromDirectories(toolchain.librariesDirs),
    // This is an explicitly local, one-shot hardware regression. Avoid a
    // multi-minute full SDK content scan before reaching the serial test.
    toolchainIdentityHint: 'hardware-esp32-regression-v1',
  });

  const source = `
const char* const STAMP = "${stamp}";

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.print("BOOT ");
  Serial.println(STAMP);
}

void loop() {
  static unsigned long tick = 0;
  Serial.print(STAMP);
  Serial.print(" tick=");
  Serial.println(tick++);
  delay(400);
}
`;
  const result = await service.compile({
    board: fqbn,
    files: [{ name: 'main.ino', content: source }],
    options: {
      flash_size: '4MB',
      flash_mode: 'dio',
      flash_freq: '40m',
      upload_speed: '115200',
    },
  });
  if (result.status !== 'success') {
    throw new Error(`${result.reason}: ${result.message}\n${result.diagnostics.map((d) => d.message).join('\n')}`);
  }
  return { board, result };
}

async function main() {
  const ports = await SerialPort.list();
  const info = ports.find((port) => port.path.toLowerCase() === portPath.toLowerCase());
  if (!info) throw new Error(`${portPath} is not present in the serial-port list`);
  console.log(`port: ${portPath} (${info.manufacturer ?? 'unknown'})`);
  console.log(`stamp: ${stamp}`);

  const { board, result } = await compileFirmware();
  const parts = [...result.staticArtifacts, ...result.artifacts];
  console.log(`compiled: ${parts.map((part) => `${part.name}@${part.offset}=${part.size}`).join(', ')}`);
  if (result.artifacts[0]?.offset !== '0x10000' || result.staticArtifacts.length !== 3) {
    throw new Error('unexpected ESP32 flash artifact layout');
  }

  // Keep the port open just long enough to observe the serial marker after
  // production flashEsp32() issues its UART reset. No signal is changed here.
  const port = new NodeWebSerialPort(portPath, info, 2_000);
  const written = await flashEsp32(
    port,
    result,
    board,
    { flash_size: '4MB', flash_mode: 'dio', flash_freq: '40m', upload_speed: '115200' },
    (message: string, percent?: number) => console.log(`[${String(percent ?? '').padStart(3)}] ${message}`),
  );

  const output = port.capturedText();
  const markers = output.split(/\r?\n/).filter((line) => line.includes(stamp));
  console.log(`written: ${written} bytes`);
  markers.forEach((line) => console.log(`serial: ${line.trim()}`));
  if (markers.length === 0) {
    throw new Error(`did not receive ${stamp} after the production post-flash reset`);
  }
  console.log('PASS: firmware started through flashEsp32() post-flash UART reset.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
