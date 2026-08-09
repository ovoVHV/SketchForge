import { dirname, resolve } from 'node:path';

/** Minimal board shape needed to decide which ESP32 caches can be prepared. */
export interface Esp32PrewarmBoard {
  fqbn: string;
  arch: string;
}

export interface Esp32PrewarmSelection<T extends Esp32PrewarmBoard> {
  /** Boards that can be compiled with the local toolchain. */
  boards: T[];
  /** ESP32 boards intentionally skipped because the local toolchain lacks an input. */
  unavailable: T[];
  /** Invalid explicit selections. An empty list means it is safe to proceed. */
  errors: string[];
}

/**
 * Parses AF_PREWARM_BOARDS. An unset or blank value means every locally
 * supported ESP32 board; a comma-only value remains an explicit error.
 */
export function parseEsp32PrewarmBoardAllowlist(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  return [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
}

/**
 * Selects supported ESP32 boards without probing a compiler or touching disk.
 * An explicitly requested unavailable board is an error, while default mode
 * simply reports it as skipped for a partial local toolchain.
 */
export function selectEsp32PrewarmBoards<T extends Esp32PrewarmBoard>(
  candidates: readonly T[],
  isSupported: (board: T) => boolean,
  allowlist: readonly string[] | null,
): Esp32PrewarmSelection<T> {
  const esp32 = candidates.filter((board) => board.arch === 'esp32');
  const byFqbn = new Map(esp32.map((board) => [board.fqbn, board]));
  const boards: T[] = [];
  const unavailable: T[] = [];
  const errors: string[] = [];

  if (allowlist !== null) {
    if (allowlist.length === 0) {
      return { boards, unavailable, errors: ['AF_PREWARM_BOARDS does not contain a board FQBN'] };
    }
    for (const fqbn of allowlist) {
      const board = byFqbn.get(fqbn);
      if (!board) {
        errors.push(`AF_PREWARM_BOARDS contains an unknown or non-ESP32 board: ${fqbn}`);
        continue;
      }
      if (!isSupported(board)) {
        unavailable.push(board);
        errors.push(`local ESP32 toolchain does not support requested board: ${fqbn}`);
        continue;
      }
      boards.push(board);
    }
    return { boards, unavailable, errors };
  }

  for (const board of esp32) {
    if (isSupported(board)) boards.push(board);
    else unavailable.push(board);
  }
  if (boards.length === 0) {
    errors.push('no locally supported ESP32 boards were found');
  }
  return { boards, unavailable, errors };
}

/** Resolves the optional dedicated preparation cache without mutating it. */
export function resolveEsp32PrewarmCacheDir(defaultCacheDir: string, override?: string): string {
  return resolve(override?.trim() || defaultCacheDir);
}

/** A cache root is never a sensible target for a preparation job. */
export function isSafeEsp32PrewarmCacheDir(cacheDir: string): boolean {
  const absolute = resolve(cacheDir);
  return dirname(absolute) !== absolute;
}
