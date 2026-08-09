import type {
  BuildAction,
  BuildArtifact,
  BuildIR,
  MappedBuildDiagnostic,
  Sha256,
} from '../build-ir/types.js';
import type { DeadlineOptions } from '../deadline.js';

export type BuildExecutorKind = 'browser-wasm' | 'native';

export interface ActionOutputBlob {
  path: string;
  sha256: Sha256;
  bytes: Uint8Array;
}

export interface ActionCacheEntry {
  actionKey: Sha256;
  outputs: ActionOutputBlob[];
  /** Mapped diagnostics produced by a successful Action. Optional for legacy cache implementations. */
  diagnostics?: MappedBuildDiagnostic[];
}

/** Content-addressed Action cache shared by browser and native adapters. */
export interface ActionCache {
  get(actionKey: Sha256): Promise<ActionCacheEntry | null>;
  put(entry: ActionCacheEntry): Promise<void>;
}

export interface ActionExecutionResult {
  actionId: string;
  actionKey: Sha256;
  cached: boolean;
  durationMs: number;
  outputs: Array<Omit<ActionOutputBlob, 'bytes'>>;
}

export interface ExecutedBuildArtifact extends BuildArtifact {
  sha256: Sha256;
  size: number;
  bytes: Uint8Array;
}

export interface BuildExecutionSuccess {
  status: 'success';
  executor: BuildExecutorKind;
  actions: ActionExecutionResult[];
  artifacts: ExecutedBuildArtifact[];
  diagnostics: MappedBuildDiagnostic[];
  durationMs: number;
}

export interface BuildExecutionFailure {
  status: 'error';
  executor: BuildExecutorKind;
  actionId?: string;
  reason: 'invalid_ir' | 'integrity' | 'tool' | 'compile' | 'timeout' | 'resource_limit' | 'cancelled' | 'internal';
  message: string;
  actions: ActionExecutionResult[];
  diagnostics: MappedBuildDiagnostic[];
  durationMs: number;
}

export type BuildExecutionResult = BuildExecutionSuccess | BuildExecutionFailure;

export interface BuildExecutionProgress {
  completed: number;
  total: number;
  action: BuildAction;
  cached: boolean;
}

export interface BuildExecutionOptions extends DeadlineOptions {
  onProgress?: (progress: BuildExecutionProgress) => void;
}

export interface BuildExecutor {
  readonly kind: BuildExecutorKind;
  execute(ir: BuildIR, options?: BuildExecutionOptions): Promise<BuildExecutionResult>;
}
