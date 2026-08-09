import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateBrowserLibraryPolicy } from '../../../scripts/ck-browser-library-policy.mjs';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const verifier = fileURLToPath(new URL('../../../scripts/verify-ck-browser-large-library-matrix.mjs', import.meta.url));

describe('large ESP32 browser library compatibility matrix', () => {
  it.each([
    ['ArduinoBLE', '2.1.0', 's2'],
    ['CapacitiveSensor', '0.5.1', 'c3'],
    ['DallasTemperature', '4.0.6', 'c6'],
    ['ESP32Encoder', '5.0.0', 'c3'],
    ['ESPAsync_WiFiManager', '1.15.1', 'c3'],
    ['Firmata', '2.5.9', 'c3'],
    ['LedControl', '1.0.6', 'c3'],
    ['NeoGPS', '4.2.9', 'c3'],
    ['OneWire', '2.3.8', 'c6'],
    ['PulsePosition', '1.0.0', 'c3'],
    ['SD', '1.3.0', 'c3'],
    ['ServoESP32', '1.1.1', 'c3'],
  ])('classifies incompatible %s %s releases declaratively on %s', (library, libraryVersion, target) => {
    expect(evaluateBrowserLibraryPolicy({
      library,
      libraryVersion,
      target,
      platformVersion: '3.3.7',
    })).toMatchObject({ status: 'unsupported', minPlatformVersion: '3.3.0' });
    expect(evaluateBrowserLibraryPolicy({
      library,
      libraryVersion,
      target,
      platformVersion: '3.2.9',
    })).toBeNull();
    expect(evaluateBrowserLibraryPolicy({
      library,
      libraryVersion: '999.0.0',
      target,
      platformVersion: '3.3.7',
    })).toBeNull();
  });

  it.each([
    ['ArduinoBLE', '2.1.0', 'c3'],
    ['DallasTemperature', '4.0.6', 'c3'],
    ['ESP32Encoder', '5.0.0', 'c6'],
    ['OneWire', '2.3.8', 'c3'],
  ])('does not broaden the %s %s target policy to %s', (library, libraryVersion, target) => {
    expect(evaluateBrowserLibraryPolicy({
      library,
      libraryVersion,
      target,
      platformVersion: '3.3.7',
    })).toBeNull();
  });

  it('applies the C3 TFT_eSPI guidance only from Arduino-ESP32 3.3.0 onward', () => {
    expect(evaluateBrowserLibraryPolicy({
      library: 'TFT_eSPI',
      target: 'c3',
      platformVersion: '3.3.7',
    })).toMatchObject({ status: 'not-recommended', minPlatformVersion: '3.3.0' });
    expect(evaluateBrowserLibraryPolicy({
      library: 'TFT_eSPI',
      target: 'c3',
      platformVersion: '4.0.0',
    })).toMatchObject({ status: 'not-recommended' });
    expect(evaluateBrowserLibraryPolicy({
      library: 'TFT_eSPI',
      target: 'c3',
      platformVersion: '3.2.9',
    })).toBeNull();
  });

  it('classifies the pinned TFT_eSPI release as unsupported on C6', () => {
    expect(evaluateBrowserLibraryPolicy({
      library: 'TFT_eSPI',
      libraryVersion: '2.5.43',
      target: 'c6',
      platformVersion: '3.3.7',
    })).toMatchObject({ status: 'unsupported', minPlatformVersion: '3.3.0' });
    expect(evaluateBrowserLibraryPolicy({
      library: 'TFT_eSPI',
      libraryVersion: '2.6.0',
      target: 'c6',
      platformVersion: '3.3.7',
    })).toBeNull();
  });

  it('records TFT_eSPI on C3 as not recommended without invoking a compiler', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-library-matrix-'));
    const reportPath = join(directory, 'report.json');
    try {
      const output = execFileSync(process.execPath, [
        verifier,
        '--target', 'c3',
        '--library', 'TFT_eSPI',
        '--no-resume',
        '--report', reportPath,
      ], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));

      expect(output).toContain('"status": "success"');
      expect(report.results).toEqual([expect.objectContaining({
        library: 'TFT_eSPI',
        version: '2.5.43',
        target: 'c3',
        status: 'not-recommended',
        platformVersion: '3.3.7',
        reason: expect.stringContaining('Arduino-ESP32 3.3.x'),
      })]);
      expect(report.schema).toBe(2);
      expect(report.expected).toBe(1);
      expect(report.summary).toEqual({
        expected: 1,
        completed: 1,
        pending: 0,
        statuses: { 'not-recommended': 1 },
        failureClasses: {},
      });
      expect(report.results[0]).not.toHaveProperty('elapsedMs');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records the pinned TFT_eSPI release on C6 as unsupported without invoking a compiler', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-library-matrix-c6-'));
    const reportPath = join(directory, 'report.json');
    try {
      const output = execFileSync(process.execPath, [
        verifier,
        '--target', 'c6',
        '--library', 'TFT_eSPI',
        '--no-resume',
        '--report', reportPath,
      ], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));

      expect(output).toContain('"status": "success"');
      expect(report.results).toEqual([expect.objectContaining({
        library: 'TFT_eSPI',
        version: '2.5.43',
        target: 'c6',
        status: 'unsupported',
        reason: expect.stringContaining('does not provide an ESP32-C6'),
      })]);
      expect(report.summary).toEqual({
        expected: 1,
        completed: 1,
        pending: 0,
        statuses: { unsupported: 1 },
        failureClasses: {},
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps same-fingerprint results when a filtered run updates the report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-library-matrix-resume-'));
    const reportPath = join(directory, 'report.json');
    const command = [
      verifier,
      '--target', 'c3',
      '--library', 'TFT_eSPI',
      '--report', reportPath,
    ];
    try {
      execFileSync(process.execPath, [...command, '--no-resume'], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 30_000,
      });
      const seeded = JSON.parse(readFileSync(reportPath, 'utf8'));
      seeded.targets.push('c6');
      seeded.candidates.push({ name: 'AceButton', version: '1.10.1', header: 'AceButton.h' });
      seeded.results.push({
        library: 'AceButton',
        version: '1.10.1',
        target: 'c6',
        header: 'AceButton.h',
        packRevision: '0'.repeat(64),
        platformVersion: '3.3.7',
        status: 'success',
        exitCode: 0,
        elapsedMs: 1,
      });
      writeFileSync(reportPath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

      execFileSync(process.execPath, command, { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
      const updated = JSON.parse(readFileSync(reportPath, 'utf8'));

      expect(updated.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ library: 'AceButton', target: 'c6', status: 'success' }),
        expect.objectContaining({ library: 'TFT_eSPI', target: 'c3', status: 'not-recommended' }),
      ]));
      expect(updated.summary).toMatchObject({ expected: 4, completed: 2, pending: 2 });
      expect(updated.scope.summary).toMatchObject({ expected: 1, completed: 1, pending: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
