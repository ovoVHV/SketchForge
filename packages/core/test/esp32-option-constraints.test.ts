import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardRegistry, resolveOptions, unsupportedOptionErrors } from '../src/toolchain/board.js';
import { resolveEsp32BuildProfile } from '../src/toolchain/esp32.js';

const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const classic = boards.get('esp32:esp32:esp32')!;
const zigbeeBoards = [
  boards.get('esp32:esp32:esp32c5')!,
  boards.get('esp32:esp32:esp32c6')!,
  boards.get('esp32:esp32:esp32h2')!,
];

describe('ESP32 trusted option constraints', () => {
  it('publishes ESP32-S3 ESP SR as unsupported and rejects both option spellings', () => {
    const s3 = boards.get('esp32:esp32:esp32s3')!;
    const partition = s3.options.find((option) => option.id === 'partition_scheme')!;
    const espSr = partition.values.find((value) => value.value === 'esp_sr_16')!;

    expect(espSr.unsupported).toEqual({
      reason: '需要尚未建模的 srmodels.bin 额外 Flash 段',
    });
    expect(resolveOptions(s3, { partition_scheme: 'esp_sr_16' }).errors.join(' '))
      .toMatch(/partition_scheme=esp_sr_16.*暂不支持/);
    expect(unsupportedOptionErrors(s3, { PartitionScheme: 'esp_sr_16' }).join(' '))
      .toMatch(/PartitionScheme=esp_sr_16.*暂不支持/);
    expect(resolveOptions(s3, { partition_scheme: 'default' }).errors).toEqual([]);
  });

  it('keeps the 4 MB Storage APP partition tied to a 4 MB flash image', () => {
    expect(resolveOptions(classic, {
      flash_size: '8MB',
      partition_scheme: 'storage_4MB',
    }).errors).not.toEqual([]);

    const resolved = resolveOptions(classic, {
      flash_size: '4MB',
      partition_scheme: 'storage_4MB',
    });
    expect(resolved.errors).toEqual([]);
    expect(resolveEsp32BuildProfile(classic, resolved.options)).toMatchObject({
      flashSize: '4MB',
      partitions: 'storage_4MB_noota',
      maxFlash: 2_097_152,
    });
  });

  it('keeps native Zigbee end-device and coordinator partition layouts separate', () => {
    for (const board of zigbeeBoards) {
      const endDevice = resolveOptions(board, {
        partition_scheme: 'zigbee',
        zigbee_mode: 'ed',
      });
      expect(endDevice.errors).toEqual([]);
      expect(resolveEsp32BuildProfile(board, endDevice.options)).toMatchObject({
        partitions: 'zigbee',
      });
      expect(resolveEsp32BuildProfile(board, endDevice.options).defines)
        .toContain('ZIGBEE_MODE_ED');
      expect(resolveEsp32BuildProfile(board, endDevice.options).linkerFlags)
        .toEqual(expect.arrayContaining([
          '-lesp_zb_api.ed',
          '-lzboss_stack.ed',
          '-lzboss_port.native',
        ]));

      const coordinator = resolveOptions(board, {
        partition_scheme: 'zigbee_zczr',
        zigbee_mode: 'zczr',
      });
      expect(coordinator.errors).toEqual([]);
      expect(resolveEsp32BuildProfile(board, coordinator.options).defines)
        .toContain('ZIGBEE_MODE_ZCZR');

      expect(resolveOptions(board, {
        partition_scheme: 'zigbee',
        zigbee_mode: 'zczr',
      }).errors).not.toEqual([]);
      expect(resolveOptions(board, {
        partition_scheme: 'zigbee_zczr',
        zigbee_mode: 'ed',
      }).errors).not.toEqual([]);
    }
  });
});
