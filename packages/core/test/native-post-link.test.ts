import { describe, expect, it } from 'vitest';

import type {
  ActionInput,
  ActionOutput,
  BuildAction,
  TransformAction,
  TransformFormat,
} from '../src/build-ir/types.js';
import {
  runNativeInternalAction,
  validateNativePostLinkActions,
} from '../src/executor/native-post-link.js';

const CONTRACT_FLAG = `--ck-post-link-contract=${'9'.repeat(64)}`;
const CACHE_KEY = '8'.repeat(64);
const MODEL_SHA256 = '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879';
const MODEL_CAPACITY = 0x2f0000;

interface TransformFixture {
  id: string;
  tool: string;
  inputs: ActionInput[];
  output: ActionOutput;
  arguments: string[];
  dependencies?: string[];
  format: TransformFormat;
  flags?: string[];
}

function transformAction(fixture: TransformFixture): TransformAction {
  return {
    id: fixture.id,
    kind: 'transform',
    tool: fixture.tool,
    inputs: fixture.inputs,
    outputs: [fixture.output],
    arguments: fixture.arguments,
    environment: {},
    dependencies: fixture.dependencies ?? [],
    packDependencies: [],
    cacheKey: CACHE_KEY,
    transform: {
      input: fixture.inputs[0]!.path,
      output: fixture.output.path,
      format: fixture.format,
      flags: fixture.flags ?? [CONTRACT_FLAG],
    },
  };
}

function espSrPostLinkActions(): BuildAction[] {
  const application = transformAction({
    id: 'transform-application',
    tool: 'toolchain:esptool',
    inputs: [{ path: 'build/firmware.elf', role: 'linked-elf' }],
    output: { path: 'build/firmware.bin', kind: 'application' },
    arguments: [
      '--chip', 'esp32s3', 'elf2image',
      '--flash-mode', 'dio', '--flash-freq', '80m', '--flash-size', '16MB',
      '--elf-sha256-offset', '0xb0',
      '-o', 'build/firmware.bin', 'build/firmware.elf',
    ],
    dependencies: ['link-firmware'],
    format: 'bin',
    flags: [
      '--chip=esp32s3', '--flash-mode=dio', '--flash-freq=80m', '--flash-size=16MB',
      '--elf-sha256-offset=0xb0', CONTRACT_FLAG,
    ],
  });
  const bootloader = transformAction({
    id: 'transform-bootloader',
    tool: 'ck:copy',
    inputs: [{
      path: 'packs/board/bootloader.bin', role: 'bootloader-source', sha256: 'a'.repeat(64),
    }],
    output: { path: 'build/bootloader.bin', kind: 'bootloader' },
    arguments: ['packs/board/bootloader.bin', '-o', 'build/bootloader.bin'],
    format: 'bootloader',
  });
  const partitions = transformAction({
    id: 'transform-partitions',
    tool: 'ck:copy',
    inputs: [{
      path: 'packs/board/partitions.bin', role: 'partitions-source', sha256: 'b'.repeat(64),
    }],
    output: { path: 'build/partitions.bin', kind: 'partitions' },
    arguments: ['packs/board/partitions.bin', '-o', 'build/partitions.bin'],
    format: 'partition',
  });
  const bootApp0 = transformAction({
    id: 'transform-boot-app0',
    tool: 'ck:copy',
    inputs: [{
      path: 'packs/board/boot_app0.bin', role: 'boot-app0-source', sha256: 'c'.repeat(64),
    }],
    output: { path: 'build/boot_app0.bin', kind: 'boot-app0' },
    arguments: ['packs/board/boot_app0.bin', '-o', 'build/boot_app0.bin'],
    format: 'boot-app0',
  });
  const model = transformAction({
    id: 'transform-model',
    tool: 'ck:copy',
    inputs: [{
      path: 'packs/board/srmodels.bin', role: 'model-source', sha256: MODEL_SHA256,
    }],
    output: { path: 'build/srmodels.bin', kind: 'model' },
    arguments: ['packs/board/srmodels.bin', '-o', 'build/srmodels.bin'],
    format: 'model',
  });
  const mergedInputs: ActionInput[] = [
    { path: 'build/bootloader.bin', role: 'bootloader-image' },
    { path: 'build/partitions.bin', role: 'partitions-image' },
    { path: 'build/boot_app0.bin', role: 'boot-app0-image' },
    { path: 'build/firmware.bin', role: 'application-image' },
    { path: 'build/srmodels.bin', role: 'model-image' },
  ];
  const merged = transformAction({
    id: 'transform-merged',
    tool: 'toolchain:esptool',
    inputs: mergedInputs,
    output: { path: 'build/firmware.merged.bin', kind: 'merged' },
    arguments: [
      '--chip', 'esp32s3', 'merge-bin',
      '-o', 'build/firmware.merged.bin', '--pad-to-size', '16MB',
      '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
      '0x0', 'build/bootloader.bin',
      '0x8000', 'build/partitions.bin',
      '0xe000', 'build/boot_app0.bin',
      '0x10000', 'build/firmware.bin',
      '0xd10000', 'build/srmodels.bin',
    ],
    dependencies: [
      'transform-application',
      'transform-bootloader',
      'transform-partitions',
      'transform-boot-app0',
      'transform-model',
    ],
    format: 'bin',
    flags: [
      '--chip=esp32s3', '--pad-to-size=16MB',
      '--flash-mode=keep', '--flash-freq=keep', '--flash-size=keep', CONTRACT_FLAG,
    ],
  });

  return [
    {
      id: 'link-firmware',
      kind: 'link',
      tool: 'toolchain:ld',
      inputs: [],
      outputs: [{ path: 'build/firmware.elf', kind: 'elf' }],
      arguments: ['-o', 'build/firmware.elf'],
      environment: {},
      dependencies: [],
      packDependencies: [],
      cacheKey: CACHE_KEY,
      link: { objects: [], archives: [], output: 'build/firmware.elf', flags: [] },
    },
    application,
    bootloader,
    partitions,
    bootApp0,
    model,
    merged,
  ];
}

function requiredTransform(actions: BuildAction[], id: string): TransformAction {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action || action.kind !== 'transform') throw new Error(`missing transform fixture: ${id}`);
  return action;
}

describe('native ESP32-S3 ESP-SR post-link contract', () => {
  it('accepts the independent six-product graph and five merge segments', () => {
    const actions = espSrPostLinkActions();
    const merged = requiredTransform(actions, 'transform-merged');

    expect(merged.inputs).toHaveLength(5);
    expect(merged.arguments.slice(-2)).toEqual(['0xd10000', 'build/srmodels.bin']);
    expect(validateNativePostLinkActions(actions)).toBeNull();
  });

  it('rejects model provenance, offset, and flash-capacity drift before execution', () => {
    const badProvenance = espSrPostLinkActions();
    requiredTransform(badProvenance, 'transform-model').inputs[0]!.role = 'boot-app0-source';
    expect(validateNativePostLinkActions(badProvenance))
      .toMatch(/model copy input provenance is invalid/);

    const badOffset = espSrPostLinkActions();
    requiredTransform(badOffset, 'transform-merged').arguments[21] = '0xd00000';
    expect(validateNativePostLinkActions(badOffset))
      .toMatch(/offset does not match model-image/);

    const badCapacity = espSrPostLinkActions();
    const capacityMerge = requiredTransform(badCapacity, 'transform-merged');
    capacityMerge.arguments[6] = '15MB';
    capacityMerge.transform.flags[1] = '--pad-to-size=15MB';
    expect(validateNativePostLinkActions(badCapacity))
      .toMatch(/16MB flash image with five segments/);
  });

  it('rejects model bytes that exceed the reserved 0x2f0000-byte capacity', () => {
    const model = requiredTransform(espSrPostLinkActions(), 'transform-model');
    const result = runNativeInternalAction({
      action: model,
      workspace: 'unused',
      readFile: () => new Uint8Array(MODEL_CAPACITY + 1),
      writeFile: () => {},
    });

    expect(result).toEqual({
      ok: false,
      message: 'model copy exceeds its flash capacity: transform-model',
    });
  });
});
