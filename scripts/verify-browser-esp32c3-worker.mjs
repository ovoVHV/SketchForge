#!/usr/bin/env node

/**
 * Real-Chromium smoke test for ESP32 browser module Workers.
 *
 * The runtime packs must already exist. This script serves the checked-in web
 * modules and a selected runtime directory from localhost, launches a fresh
 * headless Chromium profile, and receives the four compiled flash fragments
 * back over a private HTTP callback.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerialPort } from 'serialport';
import { flashEsp32, forgetFlashedDevices } from '../packages/web/public/esp32flash.js';
import { NodeWebSerialPort } from './node-web-serial-port.mjs';

const FQBN = 'esp32:esp32:esp32c3';
const SOURCE_NAME = 'main.ino';
const CALLBACK_BODY_LIMIT = 70 * 1024 * 1024;
const LINKED_ELF_BODY_LIMIT = 64 * 1024 * 1024;
const BROWSER_LOG_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const SAFE_MARKER = /^[A-Z0-9-]{8,64}$/;
const SAFE_PACK_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_PACK_MANIFEST = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}\.json$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_OPTIONS = Object.freeze({
  partition_scheme: 'default',
  flash_mode: 'dio',
  flash_freq: '40m',
  flash_size: '4MB',
  cpu_freq: '160000000L',
  usb_cdc_on_boot: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
const BOARD_TARGETS = Object.freeze({
  esp32: Object.freeze({
    key: 'esp32', label: 'ESP32', fqbn: 'esp32:esp32:esp32', runtimeId: 'esp32-arduino',
    worker: 'esp32-worker.js', bootloaderOffset: '0x1000',
    options: Object.freeze({
      psram: 'disabled', flash_mode: 'dio', flash_freq: '40m', flash_size: '4MB',
      partition_scheme: 'default', cpu_freq: '240000000L', loop_core: '1', event_core: '1',
      debug_level: 'none', upload_speed: '921600', erase_flash: 'disabled',
    }),
  }),
  esp32s2: Object.freeze({
    key: 'esp32s2', label: 'ESP32-S2', fqbn: 'esp32:esp32:esp32s2', runtimeId: 'esp32-s2-arduino',
    worker: 's2-worker.js', bootloaderOffset: '0x1000',
    options: Object.freeze({
      psram: 'disabled', flash_mode: 'qio', flash_freq: '80m', flash_size: '4MB',
      partition_scheme: 'default', cpu_freq: '240000000L', usb_cdc_on_boot: 'disabled',
      usb_msc_on_boot: 'disabled', usb_dfu_on_boot: 'disabled', debug_level: 'none',
      upload_speed: '921600', erase_flash: 'disabled',
    }),
  }),
  esp32s3: Object.freeze({
    key: 'esp32s3', label: 'ESP32-S3', fqbn: 'esp32:esp32:esp32s3', runtimeId: 'esp32-s3-arduino',
    worker: 's3-worker.js', bootloaderOffset: '0x0',
    options: Object.freeze({
      psram: 'disabled', flash_mode: 'qio', flash_freq: '80m', flash_size: '4MB',
      partition_scheme: 'default', cpu_freq: '240000000L', loop_core: '1', event_core: '1',
      usb_mode: 'hwcdc', usb_cdc_on_boot: 'disabled', usb_msc_on_boot: 'disabled',
      usb_dfu_on_boot: 'disabled', debug_level: 'none', upload_speed: '921600',
      erase_flash: 'disabled',
    }),
  }),
  esp32c3: Object.freeze({
    key: 'esp32c3', label: 'ESP32-C3', fqbn: FQBN, runtimeId: 'esp32-c3-arduino',
    worker: 'c3-worker.js', bootloaderOffset: '0x0',
    options: DEFAULT_OPTIONS,
  }),
  esp32c6: Object.freeze({
    key: 'esp32c6', label: 'ESP32-C6', fqbn: 'esp32:esp32:esp32c6', runtimeId: 'esp32-c6-arduino',
    worker: 'c6-worker.js', bootloaderOffset: '0x0',
    options: Object.freeze({
      flash_mode: 'qio', flash_freq: '80m', flash_size: '4MB', partition_scheme: 'default',
      cpu_freq: '160000000L', usb_cdc_on_boot: 'disabled', zigbee_mode: 'disabled',
      debug_level: 'none', upload_speed: '921600', erase_flash: 'disabled',
    }),
  }),
  esp32h2: Object.freeze({
    key: 'esp32h2', label: 'ESP32-H2', fqbn: 'esp32:esp32:esp32h2', runtimeId: 'esp32-h2-arduino',
    worker: 'h2-worker.js', bootloaderOffset: '0x0',
    options: Object.freeze({
      flash_mode: 'qio', flash_freq: '64m', flash_size: '4MB', partition_scheme: 'default',
      usb_cdc_on_boot: 'disabled', zigbee_mode: 'disabled', debug_level: 'none',
      upload_speed: '921600', erase_flash: 'disabled',
    }),
  }),
  esp32c5: Object.freeze({
    key: 'esp32c5', label: 'ESP32-C5', fqbn: 'esp32:esp32:esp32c5', runtimeId: 'esp32-c5-arduino',
    worker: 'c5-worker.js', bootloaderOffset: '0x2000',
    options: Object.freeze({
      psram: 'disabled', flash_mode: 'qio', flash_freq: '80m', flash_size: '4MB',
      partition_scheme: 'default', cpu_freq: '240000000L', usb_cdc_on_boot: 'disabled',
      zigbee_mode: 'disabled', debug_level: 'none', upload_speed: '921600', erase_flash: 'disabled',
    }),
  }),
  esp32p4: Object.freeze({
    key: 'esp32p4', label: 'ESP32-P4', fqbn: 'esp32:esp32:esp32p4', runtimeId: 'esp32-p4-arduino',
    worker: 'p4-worker.js', bootloaderOffset: '0x2000',
    options: Object.freeze({
      chip_variant: 'prev3', psram: 'disabled', usb_mode: 'tinyusb',
      usb_cdc_on_boot: 'disabled', usb_msc_on_boot: 'disabled', usb_dfu_on_boot: 'disabled',
      flash_mode: 'qio', flash_freq: '80m', flash_size: '4MB', partition_scheme: 'default',
      debug_level: 'none', upload_speed: '921600', erase_flash: 'disabled',
    }),
  }),
});
const PRODUCTION_ROUTE_TARGETS = new Set(['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6']);
const HARDWARE_GATE_TARGETS = new Set(['esp32', 'esp32c3']);
const LIBRARY_SMOKE_PROFILES = Object.freeze({
  pubsubclient: Object.freeze({
    libraries: Object.freeze([Object.freeze({ name: 'PubSubClient', version: '2.8' })]),
    preamble: '#include <PubSubClient.h>\n\nPubSubClient afSmokeMqtt;\nstatic volatile int afSmokeMqttState;\n',
    probe: '  afSmokeMqtt.setServer("127.0.0.1", 1883);\n  afSmokeMqttState = afSmokeMqtt.state();\n',
  }),
  ssd1306: Object.freeze({
    libraries: Object.freeze([Object.freeze({ name: 'Adafruit SSD1306', version: '2.5.17' })]),
    preamble: [
      '#include <Adafruit_SSD1306.h>',
      '#include <Fonts/FreeMono9pt7b.h>',
      '',
      'Adafruit_SSD1306 afSmokeDisplay(128, 64, &Wire, -1);',
      'static volatile int afSmokeDisplayState;',
      '',
    ].join('\n'),
    probe: [
      '  afSmokeDisplay.setFont(&FreeMono9pt7b);',
      '  afSmokeDisplayState = afSmokeDisplay.width();',
      '',
    ].join('\n'),
  }),
  dht: Object.freeze({
    libraries: Object.freeze([Object.freeze({ name: 'DHT sensor library', version: '1.4.7' })]),
    preamble: [
      '#include <DHT_U.h>',
      '',
      'DHT_Unified afSmokeDht(4, DHT22);',
      'static volatile int32_t afSmokeDhtState;',
      '',
    ].join('\n'),
    probe: [
      '  sensor_t afSmokeSensor;',
      '  afSmokeDht.temperature().getSensor(&afSmokeSensor);',
      '  afSmokeDhtState = afSmokeSensor.version;',
      '',
    ].join('\n'),
  }),
  esp32servo: Object.freeze({
    libraries: Object.freeze([Object.freeze({ name: 'ESP32Servo', version: '3.2.1' })]),
    preamble: [
      '#include <ESP32Servo.h>',
      '',
      'Servo afSmokeServo;',
      'static volatile int afSmokeServoState;',
      '',
    ].join('\n'),
    probe: [
      '  afSmokeServoState = afSmokeServo.read();',
      '  afSmokeServoState += afSmokeServo.attached() ? 1 : 0;',
      '',
    ].join('\n'),
  }),
  fastled: Object.freeze({
    libraries: Object.freeze([Object.freeze({ name: 'FastLED', version: '3.9.4' })]),
    preamble: [
      '#include <FastLED.h>',
      '',
      'CRGB afSmokeLeds[1];',
      'static volatile uint32_t afSmokeLedState;',
      '',
    ].join('\n'),
    probe: [
      '  FastLED.addLeds<WS2812B, 4, GRB>(afSmokeLeds, 1);',
      '  afSmokeLeds[0] = CRGB::Red;',
      '  afSmokeLedState = afSmokeLeds[0].r;',
      '',
    ].join('\n'),
  }),
});

function expectedArtifactsForTarget(target = BOARD_TARGETS.esp32c3) {
  return Object.freeze([
    Object.freeze({ name: 'bootloader.bin', offset: target.bootloaderOffset }),
    Object.freeze({ name: 'partitions.bin', offset: '0x8000' }),
    Object.freeze({ name: 'boot_app0.bin', offset: '0xe000' }),
    Object.freeze({ name: 'firmware.bin', offset: '0x10000' }),
  ]);
}

export function createSmokeMarker() {
  return `AF-C3-WORKER-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export function serialMarkerSketch(marker) {
  assertMarker(marker);
  return `const char* const AF_MARKER = "${marker}";

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.print("BOOT ");
  Serial.println(AF_MARKER);
}

void loop() {
  Serial.print(AF_MARKER);
  Serial.println(" running");
  delay(400);
}
`;
}

export function serialMarkerProject(marker, { includePubSubClient = false, librarySmokeProfile } = {}) {
  assertMarker(marker);
  const profileName = librarySmokeProfile ?? (includePubSubClient ? 'pubsubclient' : undefined);
  const profile = profileName === undefined ? undefined : LIBRARY_SMOKE_PROFILES[profileName];
  if (profileName !== undefined && !profile) throw new Error(`unsupported browser library smoke profile: ${profileName}`);
  const libraryPreamble = profile?.preamble ?? '';
  const libraryProbe = profile?.probe ?? '';
  return Object.freeze([
    Object.freeze({
      name: SOURCE_NAME,
      content: `#include <af-smoke-marker.h>
${libraryPreamble}

void setup() {
${libraryProbe}
  Serial.begin(115200);
  delay(800);
  Serial.print("BOOT ");
  Serial.println(afSmokeMarker());
}

void loop() {
  Serial.print(afSmokeMarker());
  Serial.println(" running");
  delay(400);
}
`,
    }),
    Object.freeze({
      name: 'include/af-smoke-marker.h',
      content: `#pragma once
#ifdef __cplusplus
extern "C" {
#endif
int afSmokeCValue(void);
extern const char af_smoke_asm_tag[];
#ifdef __cplusplus
}
#endif
const char* afSmokeMarker();
`,
    }),
    Object.freeze({
      name: 'src/af-smoke-marker.cpp',
      content: `#include "../include/af-smoke-marker.h"

static volatile int afSmokeLinkGuard;
const char* afSmokeMarker() {
  afSmokeLinkGuard = afSmokeCValue() + af_smoke_asm_tag[0];
  return "${marker}";
}
`,
    }),
    Object.freeze({
      name: 'src/af-smoke-c.c',
      content: 'int afSmokeCValue(void) { return 7; }\n',
    }),
    Object.freeze({
      name: 'src/af-smoke-asm.S',
      content: `.section .rodata.af_smoke,"a",@progbits
.global af_smoke_asm_tag
.type af_smoke_asm_tag,@object
af_smoke_asm_tag:
.asciz "ASM"
.size af_smoke_asm_tag, .-af_smoke_asm_tag
`,
    }),
  ]);
}

export function parseArgs(argv, { cwd = process.cwd(), markerFactory = createSmokeMarker } = {}) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      values.help = true;
      continue;
    }
    if (argument === '--production-route') {
      values['production-route'] = true;
      continue;
    }
    if (argument === '--library-smoke') {
      const profile = argv[index + 1];
      if (profile && !profile.startsWith('--')) index += 1;
      values['library-smoke'] = profile && !profile.startsWith('--') ? profile : 'pubsubclient';
      continue;
    }
    if (argument === '--capture-elf') {
      values['capture-elf'] = true;
      continue;
    }
    if (!['--web-root', '--runtime-dir', '--out', '--chrome', '--timeout-ms', '--marker', '--flash-port', '--board'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    values[argument.slice(2)] = value;
  }

  const marker = values.marker ?? markerFactory();
  assertMarker(marker);
  const timeoutMs = values['timeout-ms'] === undefined
    ? DEFAULT_TIMEOUT_MS
    : Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
    throw new Error('--timeout-ms must be an integer between 1000 and 1800000');
  }

  const workspace = resolve(cwd);
  const target = BOARD_TARGETS[values.board ?? 'esp32c3'];
  if (!target) {
    throw new Error('--board must be esp32, esp32s2, esp32s3, esp32c3, esp32c5, esp32c6, esp32h2, or esp32p4');
  }
  if (!PRODUCTION_ROUTE_TARGETS.has(target.key)) {
    throw new Error('--board is not an enabled release-pinned ESP32 browser target');
  }
  if (values['library-smoke'] !== undefined && !LIBRARY_SMOKE_PROFILES[values['library-smoke']]) {
    throw new Error(`--library-smoke must be one of ${Object.keys(LIBRARY_SMOKE_PROFILES).join(', ')}`);
  }
  if (values['capture-elf'] === true && target.key !== 'esp32') {
    throw new Error('--capture-elf currently requires --board esp32');
  }
  if (values['flash-port'] && !HARDWARE_GATE_TARGETS.has(target.key)) {
    throw new Error('--flash-port is only available for hardware-verified ESP32 browser targets');
  }
  const defaultRuntimeDir = target.key === 'esp32' || target.key === 'esp32s2' || target.key === 'esp32s3'
    ? join('packages', 'web', 'public', 'esp32', 'v5', 'xtensa')
    : target.key === 'esp32c6'
      ? join('packages', 'web', 'public', 'esp32', 'v2', 'runtime-c6')
      : join('packages', 'web', 'public', 'esp32', 'v2', 'runtime');
  return Object.freeze({
    help: values.help === true,
    workspace,
    webRoot: resolve(workspace, values['web-root'] ?? join('packages', 'web', 'public')),
    runtimeDir: resolve(workspace, values['runtime-dir'] ?? defaultRuntimeDir),
    outputDir: resolve(workspace, values.out ?? join('var', 'work', `${target.key}-browser-worker`, marker)),
    chrome: values.chrome ? resolve(workspace, values.chrome) : undefined,
    timeoutMs,
    marker,
    flashPort: values['flash-port'],
    productionRoute: true,
    librarySmoke: values['library-smoke'] !== undefined,
    librarySmokeProfile: values['library-smoke'],
    captureElf: values['capture-elf'] === true,
    target,
  });
}

export function validateWorkerCompletion(value, { marker, target = BOARD_TARGETS.esp32c3 } = {}) {
  assertMarker(marker);
  if (!isRecord(value)) throw new Error('browser Worker callback is not an object');
  if (value.ok !== true) {
    const detail = typeof value.error === 'string' ? value.error : JSON.stringify(value.error ?? 'unknown browser failure');
    throw new Error(`browser Worker failed: ${detail}`);
  }
  if (value.marker !== marker) throw new Error('browser Worker marker does not match the request');
  if (!isRecord(value.result) || value.result.status !== 'success') {
    throw new Error(`browser Worker did not return a successful compile: ${JSON.stringify(value.result ?? null)}`);
  }
  if (!Array.isArray(value.result.staticArtifacts) || !Array.isArray(value.result.artifacts)) {
    throw new Error('browser Worker result has no flash artifacts');
  }

  const candidates = [...value.result.staticArtifacts, ...value.result.artifacts];
  const expectedArtifacts = expectedArtifactsForTarget(target);
  if (candidates.length !== expectedArtifacts.length) {
    throw new Error(`browser Worker returned ${candidates.length} flash artifacts instead of four`);
  }
  const artifacts = expectedArtifacts.map((expected, index) => {
    const candidate = candidates[index];
    if (!isRecord(candidate) || candidate.name !== expected.name || candidate.offset !== expected.offset) {
      throw new Error(`browser Worker flash artifact ${index} is not ${expected.name}@${expected.offset}`);
    }
    const bytes = decodeBase64(candidate.base64, expected.name);
    if (bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error(`browser Worker flash artifact is too large: ${expected.name}`);
    }
    return Object.freeze({ ...expected, bytes });
  });
  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
  if (totalBytes > 48 * 1024 * 1024) throw new Error('browser Worker flash artifacts exceed 48 MiB');
  const firmware = artifacts.at(-1).bytes;
  if (!Buffer.from(firmware).includes(Buffer.from(marker, 'ascii'))) {
    throw new Error('browser-built firmware does not contain the requested serial marker');
  }

  return Object.freeze({
    marker,
    artifacts: Object.freeze(artifacts),
    diagnostics: Array.isArray(value.result.diagnostics) ? value.result.diagnostics : [],
    timings: isRecord(value.result.timings) ? value.result.timings : {},
    memory: isRecord(value.result.memory) ? value.result.memory : undefined,
    progress: Array.isArray(value.progress) ? value.progress : [],
    browser: isRecord(value.browser) ? value.browser : {},
  });
}

export function writeWorkerSmokeOutput({
  outputDir,
  completion,
  source,
  files,
  libraries = [],
  runtime,
  target = BOARD_TARGETS.esp32c3,
  linkedElf,
}) {
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  mkdirSync(outputDir, { recursive: true });

  const artifacts = completion.artifacts.map((artifact) => {
    const path = join(outputDir, artifact.name);
    writeFileSync(path, artifact.bytes);
    return {
      name: artifact.name,
      offset: artifact.offset,
      size: artifact.bytes.byteLength,
      sha256: sha256(artifact.bytes),
      path: artifact.name,
    };
  });
  const projectFiles = files ?? [{ name: SOURCE_NAME, content: source }];
  for (const file of projectFiles) {
    const path = join(outputDir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, 'utf8');
  }
  const sketch = projectFiles.find((file) => file.name === SOURCE_NAME);
  if (!sketch) throw new Error(`browser Worker smoke project has no ${SOURCE_NAME}`);
  const linkedElfManifest = linkedElf instanceof Uint8Array && linkedElf.byteLength > 0
    ? (() => {
        writeFileSync(join(outputDir, 'firmware.elf'), linkedElf);
        return {
          name: 'firmware.elf',
          size: linkedElf.byteLength,
          sha256: sha256(linkedElf),
          path: 'firmware.elf',
        };
      })()
    : undefined;
  const manifest = {
    schema: 1,
    kind: `${target.key}-browser-worker-smoke`,
    board: target.fqbn,
    marker: completion.marker,
    source: {
      name: SOURCE_NAME,
      sha256: sha256(Buffer.from(sketch.content, 'utf8')),
    },
    sources: projectFiles.map((file) => ({
      name: file.name,
      sha256: sha256(Buffer.from(file.content, 'utf8')),
    })),
    libraries,
    runtime: {
      descriptorSha256: runtime.descriptorSha256,
      descriptor: runtime.descriptor,
    },
    browser: completion.browser,
    progress: completion.progress,
    diagnostics: completion.diagnostics,
    timings: completion.timings,
    ...(completion.memory ? { memory: completion.memory } : {}),
    ...(linkedElfManifest ? { linkedElf: linkedElfManifest } : {}),
    artifacts,
  };
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return Object.freeze(manifest);
}

export function workerFlashResult(completion, target = BOARD_TARGETS.esp32c3) {
  if (!isRecord(completion) || !Array.isArray(completion.artifacts)) {
    throw new Error('validated browser Worker completion is required for flashing');
  }
  const expectedArtifacts = expectedArtifactsForTarget(target);
  if (completion.artifacts.length !== expectedArtifacts.length) {
    throw new Error(`browser Worker hardware gate requires exactly four flash artifacts`);
  }
  const artifacts = expectedArtifacts.map((expected, index) => {
    const artifact = completion.artifacts[index];
    if (!isRecord(artifact) || artifact.name !== expected.name || artifact.offset !== expected.offset) {
      throw new Error(`browser Worker hardware artifact ${index} is not ${expected.name}@${expected.offset}`);
    }
    if (!(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength === 0) {
      throw new Error(`browser Worker hardware artifact is empty: ${expected.name}`);
    }
    return Object.freeze({
      ...expected,
      size: artifact.bytes.byteLength,
      sha256: sha256(artifact.bytes),
      base64: Buffer.from(artifact.bytes).toString('base64'),
    });
  });
  return Object.freeze({
    staticArtifacts: Object.freeze(artifacts.slice(0, 3)),
    artifacts: Object.freeze(artifacts.slice(3)),
  });
}

export async function flashWorkerCompletion({
  portPath,
  completion,
  board,
  target = BOARD_TARGETS.esp32c3,
  options,
  dependencies = {},
}) {
  if (typeof portPath !== 'string' || !portPath.trim()) throw new Error('flash port is required');
  if (!isRecord(target) || typeof target.fqbn !== 'string') throw new Error('flash target is invalid');
  if (!isRecord(board) || board.fqbn !== target.fqbn) throw new Error(`flash board must be ${target.fqbn}`);

  const listPorts = dependencies.listPorts ?? (() => SerialPort.list());
  const createPort = dependencies.createPort
    ?? ((path, info) => new NodeWebSerialPort(path, info, 2_000));
  const flash = dependencies.flash ?? flashEsp32;
  const forget = dependencies.forget ?? forgetFlashedDevices;
  const ports = await listPorts();
  const info = ports.find((port) => port.path.toLowerCase() === portPath.toLowerCase());
  if (!info) throw new Error(`${portPath} is not present in the serial-port list`);

  const result = workerFlashResult(completion, target);
  const expectedBytes = [...result.staticArtifacts, ...result.artifacts]
    .reduce((sum, artifact) => sum + artifact.size, 0);
  const flashOptions = { ...target.options, ...options, upload_speed: '115200' };
  const port = createPort(portPath, info);
  forget();
  const written = await flash(
    port,
    result,
    board,
    flashOptions,
    (message, percent) => console.log(`[${String(percent ?? '').padStart(3)}] ${message}`),
  );
  if (written !== expectedBytes) {
    throw new Error(`hardware gate wrote ${written} of ${expectedBytes} browser Worker bytes`);
  }

  const markers = port.capturedText().split(/\r?\n/).filter((line) => line.includes(completion.marker));
  console.log(`written ${written} bytes from all four browser Worker artifacts`);
  markers.forEach((line) => console.log(`serial ${line.trim()}`));
  if (markers.length === 0) {
    throw new Error(`did not receive ${completion.marker} after the production post-flash reset`);
  }
  return Object.freeze({ written, markers: Object.freeze(markers) });
}

export function findChromiumExecutable(explicit, env = process.env, platform = process.platform) {
  if (explicit) return requireExecutable(explicit, '--chrome');
  if (env.CHROME_PATH) return requireExecutable(env.CHROME_PATH, 'CHROME_PATH');

  const candidates = [];
  if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      for (const directory of String(env.PATH ?? '').split(':').filter(Boolean)) candidates.push(join(directory, name));
    }
  }
  const found = candidates.find(isRegularFile);
  if (!found) throw new Error('Chromium executable not found; pass --chrome or set CHROME_PATH');
  return resolve(found);
}

async function run(options) {
  const runtime = loadRuntime(options.runtimeDir, options.target);
  const clangDir = isRegularFile(join(options.runtimeDir, 'clang', 'bundle.js'))
    ? join(options.runtimeDir, 'clang')
    : join(options.webRoot, 'esp32', 'v2', 'clang');
  requireFile(join(options.webRoot, 'esp32', 'v2', options.target.worker), `${options.target.label} v2 Worker`);
  requireFile(join(clangDir, 'bundle.js'), `${options.target.label} Chromium Clang bundle`);
  const chrome = findChromiumExecutable(options.chrome);
  const libraryProfile = options.librarySmokeProfile === undefined
    ? undefined
    : LIBRARY_SMOKE_PROFILES[options.librarySmokeProfile];
  const libraries = libraryProfile?.libraries ?? Object.freeze([]);
  const files = serialMarkerProject(options.marker, { librarySmokeProfile: options.librarySmokeProfile });
  const source = files.find((file) => file.name === SOURCE_NAME).content;
  const callbackToken = randomBytes(16).toString('hex');
  const browserHarness = await startBrowserHarness({
    webRoot: options.webRoot,
    runtimeDir: options.runtimeDir,
    clangDir,
    callbackToken,
    marker: options.marker,
    files,
    libraries,
    timeoutMs: options.timeoutMs,
    productionRoute: options.productionRoute,
    target: options.target,
    descriptorName: runtime.descriptorName,
    captureElf: options.captureElf,
  });
  const profileDir = mkdtempSync(join(tmpdir(), 'sketchforge-c3-chromium-'));
  let browser;
  let browserLog = '';
  let hardwareCompletion;
  try {
    const url = `${browserHarness.origin}/__af_c3_worker_smoke__/${callbackToken}/`;
    const args = [
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      `--user-data-dir=${profileDir}`,
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
      url,
    ];
    browser = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const capture = (chunk) => {
      browserLog = `${browserLog}${chunk.toString()}`.slice(-BROWSER_LOG_LIMIT);
    };
    browser.stdout.on('data', capture);
    browser.stderr.on('data', capture);
    const browserExit = new Promise((resolveExit, rejectExit) => {
      browser.once('error', rejectExit);
      browser.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    const timeout = delayReject(options.timeoutMs, `Chromium Worker timed out after ${options.timeoutMs} ms`);
    const payload = await Promise.race([
      browserHarness.completion,
      browserExit.then(({ code, signal }) => {
        if (browserHarness.completionReceived()) return browserHarness.completion;
        throw new Error(`Chromium exited before the Worker completed (code=${code}, signal=${signal})\n${browserLog}`);
      }),
      timeout.promise,
    ]).finally(timeout.cancel);
    const completion = validateWorkerCompletion(payload, { marker: options.marker, target: options.target });
    const linkedElf = browserHarness.capturedElf();
    if (options.captureElf && !(linkedElf instanceof Uint8Array && linkedElf.byteLength > 0)) {
      throw new Error('diagnostic browser Worker did not return firmware.elf');
    }
    hardwareCompletion = completion;
    const manifest = writeWorkerSmokeOutput({
      outputDir: options.outputDir,
      completion,
      source,
      files,
      libraries,
      runtime,
      target: options.target,
      linkedElf,
    });
    console.log(`PASS Chromium module Worker compiled ${options.target.fqbn}`);
    console.log(`marker ${options.marker}`);
    for (const artifact of manifest.artifacts) {
      console.log(`${artifact.name}@${artifact.offset} ${artifact.size} bytes sha256=${artifact.sha256}`);
    }
    if (manifest.linkedElf) {
      console.log(`${manifest.linkedElf.name} ${manifest.linkedElf.size} bytes sha256=${manifest.linkedElf.sha256}`);
    }
    console.log(`output ${options.outputDir}`);
  } finally {
    if (browser && browser.exitCode === null && browser.signalCode === null) browser.kill();
    await browserHarness.close();
    try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Chrome may release profile files late. */ }
  }
  if (options.flashPort) {
    const board = loadFlashBoard(options.workspace, options.target);
    console.log(`flash port ${options.flashPort}; marker ${options.marker}`);
    await flashWorkerCompletion({
      portPath: options.flashPort,
      completion: hardwareCompletion,
      board,
      target: options.target,
    });
    console.log('PASS browser Worker firmware started through flashEsp32() post-flash UART reset');
  }
}

export function loadFlashBoard(workspace, target = BOARD_TARGETS.esp32c3) {
  const boardPath = join(workspace, 'boards', `esp32_esp32_${target.key}.json`);
  requireFile(boardPath, `${target.label} board definition`);
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath, 'utf8'));
  } catch (error) {
    throw new Error(`${target.label} board definition is invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(board) || board.fqbn !== target.fqbn || !isRecord(board.upload)) {
    throw new Error(`${target.label} board definition is invalid: ${boardPath}`);
  }
  return board;
}

function loadRuntime(runtimeDir, target = BOARD_TARGETS.esp32c3) {
  const targetDescriptorName = `${target.key}.json`;
  const descriptorName = isRegularFile(join(runtimeDir, 'runtime.json')) ? 'runtime.json' : targetDescriptorName;
  const descriptorPath = join(runtimeDir, descriptorName);
  requireFile(descriptorPath, 'ESP32-C3 runtime descriptor');
  const descriptorBytes = readFileSync(descriptorPath);
  let descriptorValue;
  try {
    descriptorValue = JSON.parse(descriptorBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`ESP32-C3 runtime descriptor is invalid JSON: ${errorMessage(error)}`);
  }
  const descriptor = validateRuntimeDescriptorEnvelope(descriptorValue, target);
  for (const pack of descriptor.packs) {
    requireFile(join(runtimeDir, ...pack.manifest.split('/')), `ESP32-C3 ${pack.role} pack manifest`);
  }
  return Object.freeze({ descriptor, descriptorName, descriptorSha256: sha256(descriptorBytes) });
}

export function validateRuntimeDescriptorEnvelope(value, target = BOARD_TARGETS.esp32c3) {
  if (
    !isRecord(value)
    || value.schema !== 2
    || value.id !== target.runtimeId
    || value.abi !== 1
    || value.board !== target.fqbn
    || !Array.isArray(value.packs)
    || value.packs.length !== 3
  ) throw new Error('ESP32-C3 runtime descriptor has an invalid envelope');
  const roles = ['compiler', 'sdk', 'board'];
  const packs = value.packs.map((pack, index) => {
    if (
      !isRecord(pack)
      || pack.role !== roles[index]
      || typeof pack.id !== 'string'
      || !SAFE_PACK_ID.test(pack.id)
      || typeof pack.revision !== 'string'
      || !SHA256.test(pack.revision)
      || !isAllowedPackManifest(pack)
    ) throw new Error(`ESP32-C3 runtime descriptor has an invalid ${roles[index]} pack`);
    return Object.freeze({
      role: pack.role,
      id: pack.id,
      revision: pack.revision,
      manifest: pack.manifest,
    });
  });
  return Object.freeze({
    schema: value.schema,
    id: target.runtimeId,
    abi: 1,
    board: target.fqbn,
    packs: Object.freeze(packs),
  });
}

function isAllowedPackManifest(pack) {
  if (typeof pack?.manifest !== 'string') return false;
  const local = SAFE_PACK_MANIFEST.test(pack.manifest)
    && !pack.manifest.split('/').some((segment) => !segment || segment === '.' || segment === '..');
  if (local) return true;
  return pack.role === 'compiler'
    && SAFE_PACK_ID.test(pack.id)
    && SHA256.test(pack.revision)
    && pack.manifest === `../toolchains/${pack.id}/${pack.revision}/toolchain.json`;
}

async function startBrowserHarness({
  webRoot,
  runtimeDir,
  clangDir,
  callbackToken,
  marker,
  files,
  libraries,
  timeoutMs,
  productionRoute,
  target,
  descriptorName,
  captureElf,
}) {
  let received = false;
  let capturedElf;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolveValue, rejectValue) => {
    resolveCompletion = resolveValue;
    rejectCompletion = rejectValue;
  });
  const basePath = `/__af_c3_worker_smoke__/${callbackToken}`;
  let origin;
  const driver = browserDriverSource({
    marker,
    files,
    libraries,
    timeoutMs,
    productionRoute,
    target,
    descriptorUrl: `/__runtime__/${descriptorName}`,
    completeUrl: `${basePath}/complete`,
    progressUrl: `${basePath}/progress`,
    captureElf,
    elfUrl: `${basePath}/firmware.elf`,
    debugWorkerUrl: `${basePath}/debug-worker.js`,
  });
  const server = createServer((request, response) => {
    void (async () => {
      addIsolationHeaders(response);
      const requestUrl = new URL(request.url ?? '/', origin ?? 'http://127.0.0.1');
      if (request.method === 'GET' && requestUrl.pathname === `${basePath}/`) {
        sendBytes(response, 200, 'text/html; charset=utf-8', Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>ESP32-C3 Worker smoke</title><pre>running</pre>'
          + `<script type="module" src="${basePath}/driver.js"></script>`,
        ));
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === `${basePath}/driver.js`) {
        sendBytes(response, 200, 'text/javascript; charset=utf-8', Buffer.from(driver));
        return;
      }
      if (captureElf && request.method === 'GET' && requestUrl.pathname === `${basePath}/debug-worker.js`) {
        sendBytes(response, 200, 'text/javascript; charset=utf-8', Buffer.from(debugEsp32WorkerSource({
          elfUploadUrl: productionRoute ? `${basePath}/firmware.elf` : undefined,
        })));
        return;
      }
      if (captureElf && request.method === 'POST' && requestUrl.pathname === `${basePath}/firmware.elf`) {
        if (capturedElf) {
          sendBytes(response, 409, 'text/plain; charset=utf-8', Buffer.from('linked ELF already received'));
          return;
        }
        capturedElf = new Uint8Array(await readRequestBody(request, LINKED_ELF_BODY_LIMIT));
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === `${basePath}/progress`) {
        const progress = JSON.parse((await readRequestBody(request, 64 * 1024)).toString('utf8'));
        if (isRecord(progress)) {
          const percent = Number.isFinite(progress.percent) ? `${progress.percent}%` : '?';
          console.log(`[browser ${percent}] ${String(progress.stage ?? '')}${progress.detail ? `: ${progress.detail}` : ''}`);
        }
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === `${basePath}/complete`) {
        if (received) {
          sendBytes(response, 409, 'text/plain; charset=utf-8', Buffer.from('completion already received'));
          return;
        }
        const payload = JSON.parse((await readRequestBody(request, CALLBACK_BODY_LIMIT)).toString('utf8'));
        received = true;
        response.writeHead(204).end(() => resolveCompletion(payload));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendBytes(response, 405, 'text/plain; charset=utf-8', Buffer.from('method not allowed'));
        return;
      }
      const file = staticRoute(requestUrl.pathname, { webRoot, runtimeDir, clangDir });
      if (!file) {
        sendBytes(response, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
        return;
      }
      streamFile(request, response, file);
    })().catch((error) => {
      if (!response.headersSent) sendBytes(response, 500, 'text/plain; charset=utf-8', Buffer.from(errorMessage(error)));
      else response.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
      if (!received) rejectCompletion(error);
    });
  });
  server.on('clientError', (error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    if (!received) rejectCompletion(error);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('browser smoke server did not bind a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({
    origin,
    completion,
    completionReceived: () => received,
    capturedElf: () => capturedElf,
    close: () => new Promise((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.();
    }),
  });
}

function browserDriverSource(config) {
  return `import { compileEsp32InBrowser } from '/browser-esp32.js';

const CONFIG = ${JSON.stringify(config)};
const OPTIONS = ${JSON.stringify(config.target.options)};
const progress = [];
let settled = false;
let timer;

function browserMemory() {
  const memory = performance.memory;
  return memory ? {
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
    totalJSHeapSize: memory.totalJSHeapSize,
    usedJSHeapSize: memory.usedJSHeapSize,
  } : null;
}

async function post(path, value) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error('smoke callback returned HTTP ' + response.status);
}

async function finish(value) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    await post(CONFIG.completeUrl, value);
    document.title = value.ok ? 'PASS' : 'FAIL';
  } catch (error) {
    document.title = 'CALLBACK FAILED';
    document.querySelector('pre').textContent = String(error?.stack ?? error);
  }
}

function fail(error) {
  void finish({
    ok: false,
    marker: CONFIG.marker,
    error: String(error?.stack ?? error?.message ?? error),
    progress,
    browser: { userAgent: navigator.userAgent, crossOriginIsolated, memory: browserMemory() },
  });
}

async function main() {
  timer = setTimeout(() => fail(new Error('module Worker timeout')), CONFIG.timeoutMs - 250);
  if (CONFIG.captureElf) {
    const BrowserWorker = globalThis.Worker;
    globalThis.Worker = new Proxy(BrowserWorker, {
      construct(Target, [url, options]) {
        const requested = new URL(url, location.href);
        const redirected = requested.pathname === '/esp32/v2/${config.target.worker}'
          ? CONFIG.debugWorkerUrl
          : url;
        return Reflect.construct(Target, [redirected, options]);
      },
    });
  }
  const routed = await compileEsp32InBrowser({
    board: '${config.target.fqbn}',
    files: CONFIG.files,
    ...(CONFIG.libraries.length ? { libraries: CONFIG.libraries } : {}),
    options: OPTIONS,
  }, (value) => {
    progress.push(value);
    void post(CONFIG.progressUrl, value).catch(() => {});
  });
  if (!routed?.handled) {
    const detail = routed?.error?.message ?? routed?.error ?? 'unknown';
    throw new Error('production browser route fell back: ' + String(routed?.reason ?? 'unknown') + ': ' + String(detail));
  }
  if (routed.result?.status !== 'success') {
    throw new Error(String(routed.result?.reason ?? 'compile_error') + ': ' + String(routed.result?.message ?? 'browser compile failed'));
  }
  await finish({
    ok: true,
    marker: CONFIG.marker,
    progress,
    browser: { userAgent: navigator.userAgent, crossOriginIsolated, memory: browserMemory() },
    result: routed.result,
  });
}

main().catch(fail);
`;
}

export function debugEsp32WorkerSource({ elfUploadUrl } = {}) {
  return `import { preprocess } from '/avr/v3/preprocess.js';
import { createBrowserToolchainPackLoader } from '/avr/v3/toolchain-pack.js';
import { createEsp32WorkerActionMessageHandler } from '/esp32/v1/c3-runtime.js';
import { buildEsp32Image } from '/esp32/v2/image-builder.js';
import { loadEsp32C3Toolchain } from '/esp32/v2/c3-clang-runtime.js';
import { createEsp32BrowserActionExecutor } from '/esp32/v2/c3-compiler.js';

const ELF_UPLOAD_URL = ${JSON.stringify(elfUploadUrl ?? null)};

const dependencies = Object.freeze({
  createPackLoader: createBrowserToolchainPackLoader,
  loadToolchain: (loader) => loadEsp32C3Toolchain({
    loader,
    bundleUrl: new URL('/esp32/v5/xtensa/clang/bundle.js', location.href),
  }),
  preprocess,
  async buildImage(elf, options) {
    const snapshot = elf.slice();
    if (!ELF_UPLOAD_URL) throw new Error('ELF callback URL is required');
    const response = await fetch(ELF_UPLOAD_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: snapshot,
    });
    if (!response.ok) throw new Error('ELF callback returned HTTP ' + response.status);
    return buildEsp32Image(elf, options);
  },
});

addEventListener('message', createEsp32WorkerActionMessageHandler({
  async openSession(request) {
    const executor = await createEsp32BrowserActionExecutor({ init: request, dependencies });
    return {
      runAction(action, context) {
        return executor.execute(action, [...context.inputs.entries()].map(([path, bytes]) => ({ path, bytes })));
      },
      close() {
        executor.close();
      },
    };
  },
  postMessage(message, transfer) {
    globalThis.postMessage(message, transfer);
  },
}));
`;
}

export function staticRoute(pathname, { webRoot, runtimeDir, clangDir }) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.startsWith('/__runtime__/')) {
    return safeRegularFile(runtimeDir, decoded.slice('/__runtime__/'.length));
  }
  if (decoded.startsWith('/esp32/v2/clang/')) {
    return safeRegularFile(clangDir, decoded.slice('/esp32/v2/clang/'.length));
  }
  if (decoded.startsWith('/esp32/v5/xtensa/clang/')) {
    return safeRegularFile(clangDir, decoded.slice('/esp32/v5/xtensa/clang/'.length));
  }
  return safeRegularFile(webRoot, decoded.replace(/^\/+/, ''));
}

function safeRegularFile(root, relativePath) {
  const candidate = resolve(root, ...relativePath.split('/'));
  const fromRoot = relative(resolve(root), candidate);
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) return null;
  return isRegularFile(candidate) ? candidate : null;
}

function streamFile(request, response, path) {
  const size = lstatSync(path).size;
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': String(size),
    'content-type': contentType(path),
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(path).on('error', (error) => response.destroy(error)).pipe(response);
}

function addIsolationHeaders(response) {
  response.setHeader('cross-origin-embedder-policy', 'require-corp');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('x-content-type-options', 'nosniff');
}

function sendBytes(response, status, type, bytes) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-type': type,
  });
  response.end(bytes);
}

function contentType(path) {
  return ({
    '.bin': 'application/octet-stream',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.tar': 'application/x-tar',
    '.wasm': 'application/wasm',
  })[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function readRequestBody(request, limit) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new Error('browser callback body exceeds its size limit');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('browser callback body exceeds its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`browser Worker artifact is not valid base64: ${label}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.byteLength) throw new Error(`browser Worker artifact is empty: ${label}`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertMarker(value) {
  if (typeof value !== 'string' || !SAFE_MARKER.test(value)) {
    throw new Error('marker must contain 8-64 uppercase ASCII letters, digits, or hyphens');
  }
}

function requireExecutable(path, label) {
  const resolved = resolve(path);
  if (!isRegularFile(resolved)) throw new Error(`${label} does not point to a browser executable: ${resolved}`);
  return resolved;
}

function requireFile(path, label) {
  if (!isRegularFile(path)) throw new Error(`${label} is missing: ${path}`);
}

function isRegularFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delayReject(ms, message) {
  let timer;
  const promise = new Promise((_, rejectDelay) => {
    timer = setTimeout(() => rejectDelay(new Error(message)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function usage() {
  return `Usage: node scripts/verify-browser-esp32c3-worker.mjs [options]

Options:
  --board <target>     esp32, esp32s2, esp32s3, esp32c3 (default), or esp32c6
  --runtime-dir <dir>  Runtime directory containing runtime.json and packs
                       (default: packages/web/public/esp32/v2/runtime)
  --web-root <dir>     Static web root (default: packages/web/public)
  --out <dir>          New output directory for the four flash artifacts
  --chrome <file>      Chrome, Edge, or Chromium executable
  --timeout-ms <ms>    Browser compile timeout (default: ${DEFAULT_TIMEOUT_MS})
  --marker <text>      Fixed serial marker for a reproducible hardware check
  --flash-port <port>  Flash all four Worker artifacts and verify auto-reset
  --production-route   Accepted for compatibility; the smoke is always Action-only
  --library-smoke [id] Compile a pubsubclient (default), ssd1306, dht,
                       esp32servo, or fastled profile
                       through the production library registry
  -h, --help           Show this help
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await run(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
