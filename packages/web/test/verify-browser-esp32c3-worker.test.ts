import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  flashWorkerCompletion,
  debugEsp32WorkerSource,
  loadFlashBoard,
  parseArgs,
  serialMarkerProject,
  serialMarkerSketch,
  staticRoute,
  validateRuntimeDescriptorEnvelope,
  validateWorkerCompletion,
  workerFlashResult,
  writeWorkerSmokeOutput,
} from '../../../scripts/verify-browser-esp32c3-worker.mjs';

const marker = 'AF-C3-WORKER-TEST1234';
const temporaryDirectories: string[] = [];

function artifact(name: string, offset: string, bytes: Uint8Array) {
  return { name, offset, base64: Buffer.from(bytes).toString('base64') };
}

function completionPayload(bootloaderOffset = '0x0') {
  return {
    ok: true,
    marker,
    browser: { userAgent: 'HeadlessChrome/test', crossOriginIsolated: true },
    progress: [{ stage: 'imaging', percent: 100 }],
    result: {
      status: 'success',
      staticArtifacts: [
        artifact('bootloader.bin', bootloaderOffset, Uint8Array.of(1)),
        artifact('partitions.bin', '0x8000', Uint8Array.of(2)),
        artifact('boot_app0.bin', '0xe000', Uint8Array.of(3)),
      ],
      artifacts: [artifact('firmware.bin', '0x10000', Buffer.from(`prefix-${marker}-suffix`))],
      diagnostics: [],
      timings: { total: 10 },
      memory: { flashUsed: 1, flashTotal: 2, ramUsed: 3, ramTotal: 4 },
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('real Chromium ESP32-C3 Worker smoke harness', () => {
  it('builds a deterministic request and validates all four flash fragments', () => {
    const options = parseArgs(['--marker', marker, '--timeout-ms', '120000', '--flash-port', 'COM13', '--production-route'], {
      cwd: 'C:/workspace',
      markerFactory: () => { throw new Error('marker factory must not run'); },
    });
    expect(options.marker).toBe(marker);
    expect(options.timeoutMs).toBe(120000);
    expect(options.flashPort).toBe('COM13');
    expect(options.productionRoute).toBe(true);
    expect(serialMarkerSketch(marker)).toContain(`Serial.println(AF_MARKER);`);
    const project = serialMarkerProject(marker);
    expect(project.map(({ name }) => name)).toEqual([
      'main.ino', 'include/af-smoke-marker.h', 'src/af-smoke-marker.cpp',
      'src/af-smoke-c.c', 'src/af-smoke-asm.S',
    ]);
    expect(project[0]!.content).not.toContain(marker);
    expect(project[2]!.content).toContain(marker);

    const libraryOptions = parseArgs([
      '--marker', marker, '--production-route', '--library-smoke',
    ], {
      cwd: 'C:/workspace',
      markerFactory: () => { throw new Error('marker factory must not run'); },
    });
    expect(libraryOptions.librarySmoke).toBe(true);
    expect(libraryOptions.librarySmokeProfile).toBe('pubsubclient');
    const libraryProject = serialMarkerProject(marker, { includePubSubClient: true });
    expect(libraryProject[0]!.content).toContain('#include <PubSubClient.h>');
    expect(libraryProject[0]!.content).toContain('afSmokeMqtt.setServer');
    const displayOptions = parseArgs([
      '--marker', marker, '--production-route', '--library-smoke', 'ssd1306',
    ], { cwd: 'C:/workspace' });
    expect(displayOptions.librarySmokeProfile).toBe('ssd1306');
    const displayProject = serialMarkerProject(marker, { librarySmokeProfile: 'ssd1306' });
    expect(displayProject[0]!.content).toContain('#include <Adafruit_SSD1306.h>');
    expect(displayProject[0]!.content).toContain('FreeMono9pt7b');
    expect(displayProject[0]!.content).toContain('afSmokeDisplay.width()');
    expect(displayProject[0]!.content).not.toContain('clearDisplay()');
    expect(displayProject[0]!.content).not.toContain('drawPixel(');
    const dhtProject = serialMarkerProject(marker, { librarySmokeProfile: 'dht' });
    expect(dhtProject[0]!.content).toContain('#include <DHT_U.h>');
    expect(dhtProject[0]!.content).toContain('getSensor(&afSmokeSensor)');
    const servoProject = serialMarkerProject(marker, { librarySmokeProfile: 'esp32servo' });
    expect(servoProject[0]!.content).toContain('#include <ESP32Servo.h>');
    expect(servoProject[0]!.content).toContain('afSmokeServo.attached()');
    const fastledProject = serialMarkerProject(marker, { librarySmokeProfile: 'fastled' });
    expect(fastledProject[0]!.content).toContain('#include <FastLED.h>');
    expect(fastledProject[0]!.content).toContain('FastLED.addLeds<WS2812B, 4, GRB>');
    expect(parseArgs(['--marker', marker, '--library-smoke'], { cwd: 'C:/workspace' }))
      .toMatchObject({ productionRoute: true, librarySmoke: true });
    expect(() => parseArgs([
      '--marker', marker, '--production-route', '--library-smoke', 'unknown',
    ], { cwd: 'C:/workspace' })).toThrow(/must be one of/);
    const diagnosticOptions = parseArgs([
      '--board', 'esp32', '--marker', marker, '--production-route', '--capture-elf',
    ], { cwd: 'C:/workspace' });
    expect(diagnosticOptions.captureElf).toBe(true);
    expect(diagnosticOptions.runtimeDir).toContain(join('esp32', 'v5', 'xtensa'));
    expect(() => parseArgs([
      '--board', 'esp32c3', '--marker', marker, '--capture-elf',
    ], { cwd: 'C:/workspace' })).toThrow(/requires --board esp32/);
    const c6Options = parseArgs([
      '--board', 'esp32c6', '--marker', marker, '--production-route',
    ], { cwd: 'C:/workspace' });
    expect(c6Options.runtimeDir.replaceAll('\\', '/')).toMatch(/\/esp32\/v2\/runtime-c6$/);
    const diagnosticWorker = debugEsp32WorkerSource({ elfUploadUrl: '/callback/firmware.elf' });
    expect(diagnosticWorker).toContain('const ELF_UPLOAD_URL = "/callback/firmware.elf"');
    expect(diagnosticWorker).toContain("method: 'POST'");
    expect(diagnosticWorker).toContain('createEsp32WorkerActionMessageHandler');
    expect(diagnosticWorker).not.toContain("type: 'compile'");

    const completion = validateWorkerCompletion(completionPayload(), { marker });
    expect(completion.artifacts.map(({ name, offset }) => ({ name, offset }))).toEqual([
      { name: 'bootloader.bin', offset: '0x0' },
      { name: 'partitions.bin', offset: '0x8000' },
      { name: 'boot_app0.bin', offset: '0xe000' },
      { name: 'firmware.bin', offset: '0x10000' },
    ]);
  });

  it('flashes all four Worker artifacts and requires the post-reset marker', async () => {
    const completion = validateWorkerCompletion(completionPayload(), { marker });
    const expected = workerFlashResult(completion);
    const expectedBytes = [...expected.staticArtifacts, ...expected.artifacts]
      .reduce((sum, artifact) => sum + artifact.size, 0);
    const fakePort = { capturedText: () => `BOOT ${marker}\n${marker} running\n` };
    const calls: string[] = [];

    const result = await flashWorkerCompletion({
      portPath: 'COM13',
      completion,
      board: { fqbn: 'esp32:esp32:esp32c3', upload: {} },
      dependencies: {
        listPorts: async () => [{ path: 'COM13' }],
        createPort: () => fakePort,
        forget: () => calls.push('forget'),
        flash: async (_port: unknown, flashResult: typeof expected) => {
          calls.push(`${flashResult.staticArtifacts.length}+${flashResult.artifacts.length}`);
          expect(flashResult.staticArtifacts.map(({ name, offset }) => `${name}@${offset}`)).toEqual([
            'bootloader.bin@0x0',
            'partitions.bin@0x8000',
            'boot_app0.bin@0xe000',
          ]);
          expect(flashResult.artifacts.map(({ name, offset }) => `${name}@${offset}`)).toEqual(['firmware.bin@0x10000']);
          return expectedBytes;
        },
      },
    });

    expect(calls).toEqual(['forget', '3+1']);
    expect(result.written).toBe(expectedBytes);
    expect(result.markers).toEqual([`BOOT ${marker}`, `${marker} running`]);
  });

  it('flashes the classic ESP32 0x1000 layout with CH340-safe upload speed', async () => {
    const options = parseArgs(['--board', 'esp32', '--marker', marker], {
      cwd: 'C:/workspace',
      markerFactory: () => { throw new Error('marker factory must not run'); },
    });
    const completion = validateWorkerCompletion(completionPayload('0x1000'), {
      marker,
      target: options.target,
    });
    const expected = workerFlashResult(completion, options.target);
    const expectedBytes = [...expected.staticArtifacts, ...expected.artifacts]
      .reduce((sum, artifact) => sum + artifact.size, 0);

    const result = await flashWorkerCompletion({
      portPath: 'COM3',
      completion,
      board: { fqbn: 'esp32:esp32:esp32', upload: {} },
      target: options.target,
      options: { flash_mode: 'qio', custom: 'kept', upload_speed: '921600' },
      dependencies: {
        listPorts: async () => [{ path: 'COM3' }],
        createPort: () => ({ capturedText: () => `BOOT ${marker}\n` }),
        flash: async (_port: unknown, flashResult: typeof expected, _board: unknown, flashOptions: Record<string, string>) => {
          expect(flashResult.staticArtifacts.map(({ name, offset }) => `${name}@${offset}`)).toEqual([
            'bootloader.bin@0x1000',
            'partitions.bin@0x8000',
            'boot_app0.bin@0xe000',
          ]);
          expect(flashResult.artifacts.map(({ name, offset }) => `${name}@${offset}`)).toEqual(['firmware.bin@0x10000']);
          expect(flashOptions).toMatchObject({
            cpu_freq: '240000000L', flash_mode: 'qio', custom: 'kept', upload_speed: '115200',
          });
          return expectedBytes;
        },
      },
    });

    expect(result.written).toBe(expectedBytes);
    expect(result.markers).toEqual([`BOOT ${marker}`]);
  });

  it('rejects a Worker flash when the device never emits its marker', async () => {
    const completion = validateWorkerCompletion(completionPayload(), { marker });
    await expect(flashWorkerCompletion({
      portPath: 'COM13',
      completion,
      board: { fqbn: 'esp32:esp32:esp32c3', upload: {} },
      dependencies: {
        listPorts: async () => [{ path: 'COM13' }],
        createPort: () => ({ capturedText: () => 'booted without stamp\n' }),
        flash: async () => workerFlashResult(completion).staticArtifacts
          .reduce((sum, artifact) => sum + artifact.size, 0)
          + workerFlashResult(completion).artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
      },
    })).rejects.toThrow(/did not receive/);
  });

  it('rejects a wrong layout and firmware that omits the serial marker', () => {
    const wrongLayout = completionPayload();
    wrongLayout.result.staticArtifacts[1]!.offset = '0x9000';
    expect(() => validateWorkerCompletion(wrongLayout, { marker })).toThrow(/partitions\.bin@0x8000/);

    const missingMarker = completionPayload();
    missingMarker.result.artifacts[0] = artifact('firmware.bin', '0x10000', Uint8Array.of(4));
    expect(() => validateWorkerCompletion(missingMarker, { marker })).toThrow(/does not contain/);
  });

  it('rejects C5 until it has a release-pinned Action runtime', () => {
    expect(() => parseArgs(['--board', 'esp32c5', '--marker', marker], { cwd: 'C:/workspace' }))
      .toThrow(/not an enabled release-pinned/);
  });

  it('rejects H2 and P4 until their Action runtimes are release-pinned', () => {
    for (const board of ['esp32h2', 'esp32p4']) {
      expect(() => parseArgs(['--board', board, '--marker', marker], { cwd: 'C:/workspace' }))
        .toThrow(/not an enabled release-pinned/);
    }
  });

  it('selects all three Xtensa Workers and their bootloader layouts', () => {
    const expected = [
      ['esp32', 'esp32:esp32:esp32', 'esp32-worker.js', 'esp32-arduino', '0x1000'],
      ['esp32s2', 'esp32:esp32:esp32s2', 's2-worker.js', 'esp32-s2-arduino', '0x1000'],
      ['esp32s3', 'esp32:esp32:esp32s3', 's3-worker.js', 'esp32-s3-arduino', '0x0'],
    ];
    for (const [board, fqbn, worker, runtimeId, bootloaderOffset] of expected) {
      const options = parseArgs(['--board', board, '--marker', marker], {
        cwd: 'C:/workspace',
        markerFactory: () => { throw new Error('marker factory must not run'); },
      });
      expect(options.target).toMatchObject({ fqbn, worker, runtimeId, bootloaderOffset });
      expect(options.runtimeDir.replaceAll('\\', '/')).toMatch(/\/esp32\/v5\/xtensa$/);
      expect(validateWorkerCompletion(completionPayload(bootloaderOffset), {
        marker,
        target: options.target,
      }).artifacts[0]).toMatchObject({ name: 'bootloader.bin', offset: bootloaderOffset });

      const production = parseArgs(['--board', board, '--marker', marker, '--production-route'], {
        cwd: 'C:/workspace',
        markerFactory: () => { throw new Error('marker factory must not run'); },
      });
      expect(production.productionRoute).toBe(true);
    }
  });

  it('accepts only schema 2 Board Packs and rejects the removed Flash Pack contract', () => {
    const target = parseArgs(['--board', 'esp32s2', '--marker', marker], {
      cwd: 'C:/workspace',
      markerFactory: () => { throw new Error('marker factory must not run'); },
    }).target;
    const pack = (role: string, suffix: string) => ({
      role,
      id: `esp32s2-${role}`,
      revision: suffix.repeat(64),
      manifest: `packs/${role}/toolchain.json`,
    });
    const envelope = (schema: number, finalRole: string) => ({
      schema,
      id: target.runtimeId,
      abi: 1,
      board: target.fqbn,
      packs: [pack('compiler', 'a'), pack('sdk', 'b'), pack(finalRole, 'c')],
    });

    expect(validateRuntimeDescriptorEnvelope(envelope(2, 'board'), target)).toMatchObject({
      schema: 2,
      packs: [{ role: 'compiler' }, { role: 'sdk' }, { role: 'board' }],
    });
    expect(() => validateRuntimeDescriptorEnvelope(envelope(1, 'flash'), target))
      .toThrow(/invalid envelope/);
    expect(() => validateRuntimeDescriptorEnvelope(envelope(2, 'flash'), target))
      .toThrow(/invalid board pack/);
    expect(() => validateRuntimeDescriptorEnvelope(envelope(1, 'board'), target))
      .toThrow(/invalid envelope/);
    expect(() => validateRuntimeDescriptorEnvelope(envelope(3, 'board'), target))
      .toThrow(/invalid envelope/);
  });

  it('limits the hardware gate to boards with real-device evidence', () => {
    expect(() => parseArgs(['--board', 'esp32s2', '--flash-port', 'COM4'], { cwd: 'C:/workspace' }))
      .toThrow(/hardware-verified/);
    expect(() => parseArgs(['--board', 'esp32s3', '--flash-port', 'COM5'], { cwd: 'C:/workspace' }))
      .toThrow(/hardware-verified/);
    expect(parseArgs(['--board', 'esp32', '--flash-port', 'COM3'], { cwd: 'C:/workspace' }).flashPort)
      .toBe('COM3');
  });

  it('loads the target-specific board file and rejects an FQBN mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'arduinofast-flash-board-test-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'boards'));
    const target = parseArgs(['--board', 'esp32', '--marker', marker], { cwd: root }).target;
    const boardPath = join(root, 'boards', 'esp32_esp32_esp32.json');
    writeFileSync(boardPath, JSON.stringify({ fqbn: target.fqbn, upload: {} }));
    expect(loadFlashBoard(root, target)).toMatchObject({ fqbn: target.fqbn });

    writeFileSync(boardPath, JSON.stringify({ fqbn: 'esp32:esp32:esp32c3', upload: {} }));
    expect(() => loadFlashBoard(root, target)).toThrow(/board definition is invalid/);
  });

  it('serves Xtensa Clang glue from the selected runtime instead of the public fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'arduinofast-worker-route-test-'));
    temporaryDirectories.push(root);
    const webRoot = join(root, 'public');
    const runtimeDir = join(root, 'runtime');
    const clangDir = join(runtimeDir, 'clang');
    const selectedBundle = join(clangDir, 'bundle.js');
    const publicBundle = join(webRoot, 'esp32', 'v4', 'xtensa', 'clang', 'bundle.js');
    mkdirSync(clangDir, { recursive: true });
    mkdirSync(join(publicBundle, '..'), { recursive: true });
    writeFileSync(selectedBundle, 'selected');
    writeFileSync(publicBundle, 'public');

    expect(staticRoute('/esp32/v5/xtensa/clang/bundle.js', { webRoot, runtimeDir, clangDir }))
      .toBe(selectedBundle);
  });

  it('writes compare-ready artifacts, source, hashes, and a manifest without overwriting', () => {
    const root = mkdtempSync(join(tmpdir(), 'arduinofast-worker-test-'));
    temporaryDirectories.push(root);
    const outputDir = join(root, 'output');
    const completion = validateWorkerCompletion(completionPayload(), { marker });
    const source = serialMarkerSketch(marker);
    const files = serialMarkerProject(marker);
    const manifest = writeWorkerSmokeOutput({
      outputDir,
      completion,
      source,
      files,
      runtime: { descriptorSha256: 'a'.repeat(64), descriptor: { schema: 2 } },
    });

    expect(manifest.artifacts).toHaveLength(4);
    expect(manifest.sources).toHaveLength(5);
    expect(readFileSync(join(outputDir, 'src', 'af-smoke-marker.cpp'), 'utf8')).toContain(marker);
    expect(readFileSync(join(outputDir, 'firmware.bin')).includes(Buffer.from(marker))).toBe(true);
    expect(JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8'))).toMatchObject({
      schema: 1,
      board: 'esp32:esp32:esp32c3',
      marker,
    });
    expect(() => writeWorkerSmokeOutput({ outputDir, completion, source, runtime: {} })).toThrow(/already exists/);
  });
});
