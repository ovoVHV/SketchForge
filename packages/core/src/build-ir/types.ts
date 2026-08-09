/**
 * CK Build IR is deliberately a data-only contract.  Paths in this file are
 * logical POSIX paths inside an executor workspace; they are never host paths
 * and never refer to an Emscripten/wasm virtual filesystem.
 */

export const CK_BUILD_IR_KIND = 'ck-build-ir' as const;
export const CK_BUILD_IR_SCHEMA_VERSION = 1 as const;

export type Sha256 = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SourceLanguage = 'ino' | 'c' | 'c++' | 'asm' | 'header' | 'other';

export interface ProjectFileInput {
  path: string;
  content: string;
  language?: SourceLanguage;
  generated?: boolean;
}

export interface ProjectFile extends ProjectFileInput {
  language: SourceLanguage;
  sha256: Sha256;
  size: number;
}

export interface ProjectSnapshot {
  files: ProjectFile[];
  /** Hash of the canonical project file list and file contents. */
  sha256: Sha256;
}

export interface TargetInput {
  fqbn: string;
  options?: Record<string, string>;
  boardPack: BoardPackRef;
}

export interface TargetSpec {
  fqbn: string;
  options: Record<string, string>;
  boardPack: BoardPackRef;
  variant: string;
}

export interface PackRef {
  id: string;
  version: string;
  sha256: Sha256;
}

export interface ToolchainPackRef extends PackRef {
  kind: 'toolchain';
  abi: string;
  instructionSet: string;
}

export interface PlatformPackRef extends PackRef {
  kind: 'platform';
  platform: string;
}

export interface BoardPackRef extends PackRef {
  kind: 'board';
  fqbn: string;
  variant: string;
}

export interface LibraryDependencyRef {
  id: string;
  version: string;
  sha256: Sha256;
}

export interface LibraryPackRef extends PackRef {
  kind: 'library';
  name: string;
  architectures: string[];
  license?: string;
  manifest: Record<string, string>;
  dependencies: LibraryDependencyRef[];
}

export interface LibraryPackSet {
  roots: string[];
  packs: LibraryPackRef[];
}

export interface BuildPacks {
  toolchain: ToolchainPackRef;
  platform: PlatformPackRef;
  board: BoardPackRef;
  libraries: LibraryPackSet;
}

export interface ActionInput {
  path: string;
  /** Present for immutable/source inputs; generated inputs are covered by dependency action keys. */
  sha256?: Sha256;
  role?: string;
}

/**
 * Compact identity for immutable Pack content consumed through an Executor
 * adapter. Unlike ActionInput this reference is not a workspace file: it
 * binds an Action key to a verified Pack artifact/tree without expanding the
 * artifact's potentially thousands of files into the IR.
 */
export interface ActionPackInput {
  kind: 'pack-artifact';
  packId: string;
  packRevision: Sha256;
  packSchema: number;
  artifactId: string;
  sha256: Sha256;
  role?: string;
}

export interface ActionOutput {
  path: string;
  kind?: string;
  /** Optional immutable content contract verified by every Executor. */
  sha256?: Sha256;
}

export interface ActionResourceLimits {
  cpuMs?: number;
  memoryBytes?: number;
  outputBytes?: number;
}

export interface ActionBase {
  id: string;
  tool: string;
  inputs: ActionInput[];
  outputs: ActionOutput[];
  arguments: string[];
  environment: Record<string, string>;
  dependencies: string[];
  /** Pack ids whose content participates in this action, including direct library imports. */
  packDependencies: string[];
  /** Immutable Pack artifacts consumed implicitly by the Executor adapter. */
  packInputs?: ActionPackInput[];
  resourceLimits?: ActionResourceLimits;
  cacheKey: Sha256;
}

export interface CompileUnit {
  language: Exclude<SourceLanguage, 'ino' | 'header' | 'other'>;
  source: string;
  output: string;
  macros: Record<string, string | boolean>;
  includePaths: string[];
  flags: string[];
}

export interface CompileAction extends ActionBase {
  kind: 'compile';
  compileUnit: CompileUnit;
}

export interface ArchiveAction extends ActionBase {
  kind: 'archive';
  archive: {
    objects: string[];
    output: string;
    flags: string[];
  };
}

export interface LinkAction extends ActionBase {
  kind: 'link';
  link: {
    objects: string[];
    archives: string[];
    output: string;
    linkerScript?: string;
    flags: string[];
  };
}

export type TransformFormat = 'elf' | 'bin' | 'hex' | 'bootloader' | 'partition' | 'boot-app0' | 'model' | 'other';

export interface TransformAction extends ActionBase {
  kind: 'transform';
  transform: {
    input: string;
    output: string;
    format: TransformFormat;
    flags: string[];
  };
}

export type BuildAction = CompileAction | ArchiveAction | LinkAction | TransformAction;

/** Input form accepted by the planner; the cache key is filled in by it. */
export type BuildActionDraft =
  | (Omit<CompileAction, 'cacheKey'> & { cacheKey?: Sha256 })
  | (Omit<ArchiveAction, 'cacheKey'> & { cacheKey?: Sha256 })
  | (Omit<LinkAction, 'cacheKey'> & { cacheKey?: Sha256 })
  | (Omit<TransformAction, 'cacheKey'> & { cacheKey?: Sha256 });

export interface ActionGraph {
  actions: BuildAction[];
}

export interface BuildArtifact {
  path: string;
  format: TransformFormat;
  offset?: string | null;
}

export interface DiagnosticMapEntry {
  generatedFile: string;
  generatedLine: number;
  generatedColumn?: number;
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
}

export interface DiagnosticMap {
  entries: DiagnosticMapEntry[];
}

export type RawBuildDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface RawBuildDiagnostic {
  severity: RawBuildDiagnosticSeverity;
  file: string;
  line: number;
  column?: number;
  message: string;
  raw?: string;
}

export interface MappedBuildDiagnostic extends RawBuildDiagnostic {
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  generatedFile?: string;
  generatedLine?: number;
  generatedColumn?: number;
  fromGenerated: boolean;
}

export interface BuildIR {
  kind: typeof CK_BUILD_IR_KIND;
  schemaVersion: typeof CK_BUILD_IR_SCHEMA_VERSION;
  project: ProjectSnapshot;
  target: TargetSpec;
  packs: BuildPacks;
  graph: ActionGraph;
  artifacts: BuildArtifact[];
  diagnosticMap: DiagnosticMap;
}

export interface BuildIRInput {
  project: ProjectSnapshot | ProjectFileInput[];
  target: TargetSpec | TargetInput;
  packs: BuildPacks;
  actions: BuildActionDraft[];
  artifacts?: BuildArtifact[];
  diagnosticMap?: DiagnosticMapEntry[] | DiagnosticMap;
}

export interface LibraryResolutionInput {
  roots?: string[];
  packs: LibraryPackRef[];
}

export interface BuildIRValidationError {
  path: string;
  message: string;
}

export interface BuildIRValidationResult {
  valid: boolean;
  errors: BuildIRValidationError[];
  value?: BuildIR;
}
