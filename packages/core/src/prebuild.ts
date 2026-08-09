import type { BoardDefinition } from './toolchain/board.js';
import { buildOptions, resolveOptions } from './toolchain/board.js';
import { resolveEsp32BuildProfile } from './toolchain/esp32.js';
import { hashJson } from './build-ir/canonical.js';

export type PrebuildMatrixKind = 'core' | 'static-firmware';

export interface PrebuildMatrixEntry {
  id: string;
  kind: PrebuildMatrixKind;
  fqbn: string;
  options: Record<string, string>;
  identity: string;
}

const STATIC_OPTION_IDS = new Set([
  'flashmode',
  'flash_mode',
  'flashfreq',
  'flash_freq',
  'flashsize',
  'flash_size',
  'partition',
  'partitions',
  'partition_scheme',
  'chipvariant',
  'chip_variant',
  'psram',
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function matrixForOptions(
  board: BoardDefinition,
  optionIds: readonly string[],
): Record<string, string>[] {
  const selected = optionIds
    .map((id) => board.options.find((option) => option.id === id))
    .filter((option): option is BoardDefinition['options'][number] => Boolean(option));
  const defaults = Object.fromEntries(board.options.map((option) => [option.id, option.default]));
  const candidates: Record<string, string>[] = [];

  function visit(index: number, options: Record<string, string>): void {
    if (index === selected.length) {
      const resolved = resolveOptions(board, options);
      if (resolved.errors.length === 0) candidates.push(buildOptions(board, resolved.options));
      return;
    }
    const option = selected[index]!;
    for (const value of option.values) visit(index + 1, { ...options, [option.id]: value.value });
  }

  visit(0, defaults);
  const unique = new Map<string, Record<string, string>>();
  for (const candidate of candidates) {
    const key = JSON.stringify(Object.fromEntries(Object.entries(candidate).sort(([left], [right]) => compareText(left, right))));
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

function entry(
  kind: PrebuildMatrixKind,
  board: BoardDefinition,
  options: Record<string, string>,
  identityMaterial: Record<string, string> = options,
): PrebuildMatrixEntry {
  const identity = hashJson({ schema: 1, kind, fqbn: board.fqbn, identity: identityMaterial });
  return {
    id: `${safeId(board.fqbn)}-${kind}-${identity.slice(0, 16)}`,
    kind,
    fqbn: board.fqbn,
    options,
    identity,
  };
}

export interface PrebuildShard {
  /** Zero-based internal index. The environment syntax is one-based. */
  index: number;
  total: number;
}

export function parsePrebuildShard(raw: string | undefined): PrebuildShard {
  if (raw === undefined || !raw.trim()) return { index: 0, total: 1 };
  const match = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (!match) throw new TypeError('AF_PREBUILD_SHARD must use one-based INDEX/TOTAL syntax, for example 1/8');
  const ordinal = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || !Number.isSafeInteger(total) || total < 1 || ordinal < 1 || ordinal > total) {
    throw new TypeError('AF_PREBUILD_SHARD index and total are out of range');
  }
  return { index: ordinal - 1, total };
}

export function selectPrebuildShard<T extends Pick<PrebuildMatrixEntry, 'identity'>>(
  entries: readonly T[],
  shard: PrebuildShard,
): T[] {
  if (!Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.total)
    || shard.total < 1 || shard.index < 0 || shard.index >= shard.total) {
    throw new TypeError('prebuild shard is invalid');
  }
  if (shard.total === 1) return [...entries];
  const total = BigInt(shard.total);
  return entries.filter((candidate) => (
    Number(BigInt(`0x${candidate.identity.slice(0, 16)}`) % total) === shard.index
  ));
}

function staticFirmwareIdentity(board: BoardDefinition, options: Record<string, string>): Record<string, string> {
  const profile = resolveEsp32BuildProfile(board, options);
  return {
    sdkTarget: profile.sdkTarget,
    variant: board.build.variant,
    boot: profile.boot,
    bootFreq: profile.bootFreq,
    flashMode: profile.flashMode,
    flashFreq: profile.flashFreq,
    imageFreq: profile.imageFreq,
    flashSize: profile.flashSize,
    partitions: profile.partitions,
    bootAddr: board.build.bootloaderAddr ?? '0x1000',
  };
}

/**
 * Plans only cache-relevant release assets. Core preparation varies the LTO
 * selector (and defaults for every board/variant); static firmware varies the
 * flash/partition/chip dimensions while filtering invalid menu constraints.
 */
export function planPrebuildMatrix(
  boards: readonly BoardDefinition[],
  kinds: readonly PrebuildMatrixKind[] = ['core', 'static-firmware'],
): PrebuildMatrixEntry[] {
  const result: PrebuildMatrixEntry[] = [];
  for (const board of [...boards].sort((left, right) => compareText(left.fqbn, right.fqbn))) {
    if (kinds.includes('core')) {
      const coreIds = board.options
        .filter((option) => {
          if (option.affectsBuild === false) return false;
          if (option.id === 'optimize') return true;
          if (board.arch !== 'avr') return false;
          return Object.values(board.build.optionEffects?.[option.id] ?? {}).some((effect) => (
            effect.mcu !== undefined
            || effect.fCpu !== undefined
            || effect.boardDefine !== undefined
            || effect.defines !== undefined
            || effect.compilerFlags !== undefined
          ));
        })
        .map((option) => option.id);
      for (const options of matrixForOptions(board, coreIds)) result.push(entry('core', board, options));
    }
    if (kinds.includes('static-firmware') && board.arch === 'esp32') {
      const staticIds = board.options
        .filter((option) => option.affectsBuild !== false && STATIC_OPTION_IDS.has(option.id.toLowerCase()))
        .map((option) => option.id);
      const staticProfiles = new Map<string, { options: Record<string, string>; identity: Record<string, string> }>();
      for (const options of matrixForOptions(board, staticIds)) {
        const identity = staticFirmwareIdentity(board, options);
        const key = hashJson(identity);
        if (!staticProfiles.has(key)) staticProfiles.set(key, { options, identity });
      }
      for (const candidate of staticProfiles.values()) {
        result.push(entry('static-firmware', board, candidate.options, candidate.identity));
      }
    }
  }
  const unique = new Map(result.map((candidate) => [`${candidate.kind}:${candidate.fqbn}:${candidate.identity}`, candidate]));
  return [...unique.values()].sort((left, right) => (
    compareText(left.fqbn, right.fqbn)
    || compareText(left.kind, right.kind)
    || compareText(JSON.stringify(left.options), JSON.stringify(right.options))
  ));
}
