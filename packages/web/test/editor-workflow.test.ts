import { describe, expect, it, vi } from 'vitest';

import {
  boardOptionUnavailable,
  browserCompileUnavailableMessage,
  compileFallbackRoute,
  diagnosticsForFile,
  firmwareArtifacts,
  unsupportedBoardOptionReason,
  validateRestoredBoardConfiguration,
  withTimeout,
} from '../public/editor-workflow.js';

describe('editor workflow boundaries', () => {
  it('uses a handled Browser result even when no Native worker is online', () => {
    expect(compileFallbackRoute({ handled: true, result: {} }, false)).toBe('browser');
    expect(compileFallbackRoute({ handled: false }, true)).toBe('server');
    expect(compileFallbackRoute({ handled: false }, false)).toBe('unavailable');
  });

  it('distinguishes a missing board Pack from an unsupported browser option', () => {
    expect(browserCompileUnavailableMessage(
      { handled: false, reason: 'options' },
      { supported: true, execution: 'browser' },
    )).toBe('当前板卡的所选处理器或编译选项尚未纳入浏览器编译包');
    expect(browserCompileUnavailableMessage(
      { handled: false, reason: 'runtime' },
      { supported: false, execution: 'server', reason: 'browser_pack' },
    )).toBe('当前板卡已有板卡定义，但浏览器编译包尚未发布');
    expect(browserCompileUnavailableMessage(
      { handled: false, reason: 'headers' },
      { supported: true, execution: 'browser' },
    )).toBe('代码引用的头文件尚未纳入浏览器编译包');
  });

  it('marks only diagnostics for the active project file in the gutter', () => {
    const diagnostics = [
      { file: 'main.ino', line: 4, severity: 'error' },
      { file: 'tabs/io.ino', line: 4, severity: 'warning' },
      { file: 'main.ino', line: 8, severity: 'warning' },
    ];
    expect(diagnosticsForFile(diagnostics, 'main.ino')).toEqual([
      diagnostics[0],
      diagnostics[2],
    ]);
    expect(diagnosticsForFile(diagnostics, 'tabs/io.ino')).toEqual([diagnostics[1]]);
  });

  it('includes dedicated download artifacts in the firmware download list', () => {
    expect(firmwareArtifacts({
      artifacts: [{ name: 'firmware.bin', offset: '0x10000' }],
      staticArtifacts: [
        { name: 'partitions.bin', offset: '0x8000' },
        { name: 'bootloader.bin', offset: '0x0' },
      ],
      downloadArtifacts: [{ name: 'firmware.merged.bin', size: 1024 }],
    }).map((artifact) => artifact.name)).toEqual([
      'bootloader.bin',
      'partitions.bin',
      'firmware.bin',
      'firmware.merged.bin',
    ]);
  });

  it('treats a contract-marked board value as unavailable without affecting ordinary values', () => {
    expect(unsupportedBoardOptionReason({ value: 'esp_sr_16', unsupported: { reason: 'missing model segment' } }))
      .toBe('missing model segment');
    expect(boardOptionUnavailable({ value: 'esp_sr_16', unsupported: { reason: 'missing model segment' } }))
      .toBe(true);
    expect(boardOptionUnavailable({ value: 'default' })).toBe(false);
    expect(unsupportedBoardOptionReason({ value: 'default' })).toBe('');
  });

  it('rejects stale restored boards and board options instead of silently using defaults', () => {
    const boards = [{
      fqbn: 'esp32:esp32:unit',
      options: [
        {
          id: 'FlashMode',
          default: 'qio',
          values: [
            { value: 'qio' },
            { value: 'opi', requires: { PSRAM: ['opi'] } },
          ],
        },
        {
          id: 'PSRAM',
          default: 'disabled',
          values: [
            { value: 'disabled' },
            { value: 'opi' },
            { value: 'legacy', unsupported: { reason: 'removed runtime segment' } },
          ],
        },
      ],
    }];

    expect(validateRestoredBoardConfiguration(boards, 'missing:board:id')).toMatchObject({
      valid: false,
      reason: 'board',
    });
    expect(validateRestoredBoardConfiguration(boards, 'esp32:esp32:unit', { Removed: 'old' }))
      .toMatchObject({ valid: false, reason: 'options' });
    expect(validateRestoredBoardConfiguration(boards, 'esp32:esp32:unit', { PSRAM: 'legacy' }))
      .toMatchObject({ valid: false, reason: 'options' });
    expect(validateRestoredBoardConfiguration(boards, 'esp32:esp32:unit', {
      FlashMode: 'opi',
      PSRAM: 'disabled',
    })).toMatchObject({ valid: false, reason: 'options' });
    expect(validateRestoredBoardConfiguration(boards, 'esp32:esp32:unit', {
      FlashMode: 'opi',
      PSRAM: 'opi',
    })).toMatchObject({ valid: true });
    expect(validateRestoredBoardConfiguration([{
      fqbn: 'esp32:esp32:bad-default',
      options: [{
        id: 'PartitionScheme',
        default: 'removed',
        values: [{ value: 'removed', unsupported: { reason: 'missing flash segment' } }],
      }],
    }], 'esp32:esp32:bad-default')).toMatchObject({ valid: false, reason: 'options' });
  });

  it('bounds optional catalog loads without delaying unrelated UI setup', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise(() => {}), 50, 'catalog');
      const rejection = expect(pending).rejects.toThrow('catalog timed out');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      await expect(withTimeout(Promise.resolve('ready'), 50, 'catalog')).resolves.toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });
});
