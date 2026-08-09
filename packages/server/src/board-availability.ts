import {
  BoardRegistry,
  unsupportedOptionErrors,
  type BoardDefinition,
  type BoardInfo,
} from '@arduinofast/core';

/**
 * Public board metadata plus the current compiler availability. Board
 * definitions are static, while availability is determined by the local
 * toolchain or by live distributed worker capabilities.
 */
export interface AvailableBoardInfo extends BoardInfo {
  available: boolean;
}

export interface BoardAvailabilityResponse {
  boards: AvailableBoardInfo[];
  unavailableBoards: AvailableBoardInfo[];
}

/**
 * Validate the small set of board values that the public catalog explicitly
 * marks unavailable before a request is charged or queued.
 */
export function boardCompileOptionError(
  board: BoardDefinition,
  requested: Record<string, string> | undefined,
): string | undefined {
  const errors = unsupportedOptionErrors(board, requested);
  return errors.length > 0 ? errors.join('；') : undefined;
}

export function boardAvailabilityResponse(
  registry: BoardRegistry,
  isAvailable: (fqbn: string) => boolean,
): BoardAvailabilityResponse {
  const catalog = registry.list().map((board) => ({
    ...registry.toPublic(board),
    available: isAvailable(board.fqbn),
  }));
  return {
    boards: catalog.filter((board) => board.available),
    unavailableBoards: catalog.filter((board) => !board.available),
  };
}
