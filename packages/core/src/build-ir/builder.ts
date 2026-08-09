import { canonicalJson, sha256Hex } from './canonical.js';
import {
  CK_BUILD_IR_KIND,
  CK_BUILD_IR_SCHEMA_VERSION,
  type ActionGraph,
  type ActionPackInput,
  type BuildAction,
  type BuildActionDraft,
  type BuildArtifact,
  type BuildIR,
  type BuildIRInput,
  type BoardPackRef,
  type DiagnosticMap,
  type DiagnosticMapEntry,
  type LibraryPackRef,
  type LibraryPackSet,
  type LibraryResolutionInput,
  type MappedBuildDiagnostic,
  type PlatformPackRef,
  type ProjectFile,
  type ProjectFileInput,
  type ProjectSnapshot,
  type RawBuildDiagnostic,
  type TargetInput,
  type TargetSpec,
} from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;

const ACTION_BASE_FIELDS = [
  'id',
  'kind',
  'tool',
  'inputs',
  'outputs',
  'arguments',
  'environment',
  'dependencies',
  'packDependencies',
  'packInputs',
  'resourceLimits',
  'cacheKey',
] as const;
const ACTION_FIELDS = {
  compile: new Set<string>([...ACTION_BASE_FIELDS, 'compileUnit']),
  archive: new Set<string>([...ACTION_BASE_FIELDS, 'archive']),
  link: new Set<string>([...ACTION_BASE_FIELDS, 'link']),
  transform: new Set<string>([...ACTION_BASE_FIELDS, 'transform']),
} as const;
const ACTION_INPUT_FIELDS = new Set(['path', 'sha256', 'role']);
const ACTION_OUTPUT_FIELDS = new Set(['path', 'kind', 'sha256']);
const ACTION_PACK_INPUT_FIELDS = new Set([
  'kind',
  'packId',
  'packRevision',
  'packSchema',
  'artifactId',
  'sha256',
  'role',
]);
const ACTION_RESOURCE_LIMIT_FIELDS = new Set(['cpuMs', 'memoryBytes', 'outputBytes']);
const COMPILE_UNIT_FIELDS = new Set(['language', 'source', 'output', 'macros', 'includePaths', 'flags']);
const ARCHIVE_FIELDS = new Set(['objects', 'output', 'flags']);
const LINK_FIELDS = new Set(['objects', 'archives', 'output', 'linkerScript', 'flags']);
const TRANSFORM_FIELDS = new Set(['input', 'output', 'format', 'flags']);

export function resolveProject(input: ProjectSnapshot | readonly ProjectFileInput[]): ProjectSnapshot {
  if ('files' in input) return resolveProject(input.files);
  const files = input.map((file): ProjectFile => {
    const path = normalizePath(file.path, 'project file');
    return {
      path,
      content: file.content,
      language: file.language ?? inferLanguage(path),
      generated: file.generated ?? false,
      sha256: sha256Hex(file.content),
      size: utf8Size(file.content),
    };
  }).sort((left, right) => compareText(left.path, right.path));
  assertUniqueCaseFolded(files.map((file) => file.path), 'project file');
  const sha256 = sha256Hex(canonicalJson(files.map((file) => ({
    path: file.path,
    content: file.content,
    language: file.language,
    generated: file.generated,
  }))));
  return { files, sha256 };
}

export function resolveTarget(input: TargetSpec | TargetInput): TargetSpec {
  const boardPack: BoardPackRef = cloneBoardPack(input.boardPack);
  if (!input.fqbn.trim()) throw new TypeError('target fqbn must not be empty');
  if (boardPack.fqbn !== input.fqbn) {
    throw new TypeError(`target fqbn ${input.fqbn} does not match board pack fqbn ${boardPack.fqbn}`);
  }
  if (!boardPack.variant.trim()) throw new TypeError('board pack variant must not be empty');
  return {
    fqbn: input.fqbn,
    options: sortRecord(input.options ?? {}),
    boardPack,
    variant: boardPack.variant,
  };
}

export function resolvePlatform(input: PlatformPackRef): PlatformPackRef {
  if (input.kind !== 'platform') throw new TypeError('platform pack kind must be platform');
  assertPackRef(input, 'platform pack');
  if (!input.platform.trim()) throw new TypeError('platform pack platform must not be empty');
  return { ...input };
}

export function resolveLibraries(input: LibraryResolutionInput | readonly LibraryPackRef[]): LibraryPackSet {
  const value: LibraryResolutionInput = Array.isArray(input)
    ? { packs: Array.from(input as readonly LibraryPackRef[]) }
    : input as LibraryResolutionInput;
  const packs = value.packs.map(cloneLibraryPack).sort((left, right) => compareText(left.id, right.id));
  assertUnique(packs.map((pack) => pack.id), 'library pack');
  const byLogicalVersion = new Map<string, LibraryPackRef>();
  for (const pack of packs) {
    const key = `${pack.name.toLowerCase()}\0${pack.version}`;
    const existing = byLogicalVersion.get(key);
    if (existing) {
      const detail = existing.sha256 === pack.sha256 ? 'duplicate identity' : 'multiple revisions';
      throw new TypeError(`ambiguous library pack ${pack.name}@${pack.version}: ${detail}`);
    }
    byLogicalVersion.set(key, pack);
  }
  const ids = new Set(packs.map((pack) => pack.id));
  const byId = new Map(packs.map((pack) => [pack.id, pack] as const));
  for (const pack of packs) {
    for (const dependency of pack.dependencies) {
      if (!ids.has(dependency.id)) {
        throw new TypeError(`library ${pack.id} references missing dependency ${dependency.id}`);
      }
      const resolved = byId.get(dependency.id)!;
      if (resolved.version !== dependency.version || resolved.sha256 !== dependency.sha256) {
        throw new TypeError(`library ${pack.id} dependency identity does not match ${dependency.id}`);
      }
    }
  }
  const roots = [...new Set(value.roots ?? packs.map((pack) => pack.id))].sort(compareText);
  for (const root of roots) if (!ids.has(root)) throw new TypeError(`missing library root ${root}`);
  return { roots, packs };
}

export function createActionGraph(actions: readonly (BuildAction | BuildActionDraft)[]): ActionGraph {
  const normalized = actions.map(normalizeAction).sort((left, right) => compareText(left.id, right.id));
  assertUnique(normalized.map((action) => action.id), 'action');
  const ids = new Set(normalized.map((action) => action.id));
  for (const action of normalized) {
    for (const dependency of action.dependencies) {
      if (dependency === action.id) throw new TypeError(`action ${action.id} depends on itself`);
      if (!ids.has(dependency)) throw new TypeError(`action ${action.id} references missing dependency ${dependency}`);
    }
  }
  assertAcyclic(normalized);
  return { actions: normalized };
}

/**
 * Creates a complete IR and calculates action keys.  This is a planner only;
 * no compiler executable is looked up or run here.
 */
export function createBuildIR(input: BuildIRInput): BuildIR {
  const project = resolveProject(input.project);
  const target = resolveTarget(input.target);
  const packs = {
    toolchain: { ...input.packs.toolchain },
    platform: resolvePlatform(input.packs.platform),
    board: cloneBoardPack(input.packs.board),
    libraries: resolveLibraries(input.packs.libraries),
  };
  if (packs.toolchain.kind !== 'toolchain') throw new TypeError('toolchain pack kind must be toolchain');
  assertPackRef(packs.toolchain, 'toolchain pack');
  if (!packs.toolchain.abi.trim() || !packs.toolchain.instructionSet.trim()) {
    throw new TypeError('toolchain pack abi and instructionSet must not be empty');
  }
  if (!sameBoardPack(packs.board, target.boardPack)) {
    throw new TypeError('target and build pack board references do not match');
  }
  const diagnosticMap: DiagnosticMap = Array.isArray(input.diagnosticMap)
    ? { entries: input.diagnosticMap.map((entry) => ({ ...entry })) }
    : { entries: [...(input.diagnosticMap?.entries ?? [])].map((entry) => ({ ...entry })) };
  const ir: BuildIR = {
    kind: CK_BUILD_IR_KIND,
    schemaVersion: CK_BUILD_IR_SCHEMA_VERSION,
    project,
    target,
    packs,
    graph: createActionGraph(input.actions),
    artifacts: [...(input.artifacts ?? [])].map((artifact) => ({
      ...artifact,
      path: normalizePath(artifact.path, 'artifact'),
    })).sort((a, b) => compareText(a.path, b.path)),
    diagnosticMap: {
      entries: diagnosticMap.entries.slice().sort(compareDiagnosticMap),
    },
  };
  return calculateActionKeys(ir);
}

/** Return a copy with deterministic cache keys for every action. */
export function calculateActionKeys(ir: BuildIR): BuildIR {
  const graph = createActionGraph(ir.graph.actions);
  const byId = new Map(graph.actions.map((action) => [action.id, action] as const));
  const keys = new Map<string, string>();
  const visiting = new Set<string>();
  const fixedPackIdentity = {
    toolchain: ir.packs.toolchain.sha256,
    platform: ir.packs.platform.sha256,
    board: ir.packs.board.sha256,
  };
  const immutablePackById = indexImmutablePacks(ir);
  const libraryHashesFor = (action: BuildAction): [string, string][] => {
    const visited = new Set<string>();
    const libraryIds = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      const identity = immutablePackById.get(id);
      if (!identity) throw new TypeError(`action ${action.id} references missing pack dependency ${id}`);
      visited.add(id);
      // Fixed Packs already occupy dedicated cache-key slots; libraries add their transitive closure here.
      if (!identity.library) return;
      libraryIds.add(id);
      for (const dependency of identity.library.dependencies) visit(dependency.id);
    };
    for (const id of action.packDependencies) visit(id);
    return [...libraryIds].sort(compareText).map((id) => [id, immutablePackById.get(id)!.sha256]);
  };
  const keyFor = (id: string): string => {
    const existing = keys.get(id);
    if (existing) return existing;
    if (visiting.has(id)) throw new TypeError(`action graph cycle contains ${id}`);
    const action = byId.get(id);
    if (!action) throw new TypeError(`missing action ${id}`);
    for (const input of action.packInputs ?? []) {
      const identity = immutablePackById.get(input.packId);
      if (identity === undefined || identity.sha256 !== input.packRevision) {
        throw new TypeError(`action ${action.id} Pack input identity does not match ${input.packId}`);
      }
    }
    visiting.add(id);
    const dependencyKeys = action.dependencies.slice().sort(compareText).map(keyFor);
    visiting.delete(id);
    const { cacheKey: _cacheKey, ...withoutKey } = action;
    const key = sha256Hex(canonicalJson({
      schemaVersion: CK_BUILD_IR_SCHEMA_VERSION,
      packs: {
        ...fixedPackIdentity,
        libraries: libraryHashesFor(action),
      },
      action: withoutKey,
      dependencyKeys,
    }));
    keys.set(id, key);
    return key;
  };
  const actions = graph.actions.map((action) => ({ ...action, cacheKey: keyFor(action.id) }));
  return { ...ir, graph: { actions } };
}

interface ImmutablePackIdentity {
  kind: 'toolchain' | 'platform' | 'board' | 'library';
  sha256: string;
  library?: LibraryPackRef;
}

function indexImmutablePacks(ir: BuildIR): Map<string, ImmutablePackIdentity> {
  const byId = new Map<string, ImmutablePackIdentity>();
  const add = (
    kind: ImmutablePackIdentity['kind'],
    pack: { id: string; sha256: string },
    library?: LibraryPackRef,
  ): void => {
    const existing = byId.get(pack.id);
    if (existing) {
      throw new TypeError(`ambiguous Pack id ${pack.id}: used by ${existing.kind} and ${kind}`);
    }
    byId.set(pack.id, {
      kind,
      sha256: pack.sha256,
      ...(library === undefined ? {} : { library }),
    });
  };

  add('toolchain', ir.packs.toolchain);
  add('platform', ir.packs.platform);
  add('board', ir.packs.board);
  for (const library of ir.packs.libraries.packs) add('library', library, library);
  return byId;
}

export function normalizeBuildIR(ir: BuildIR): BuildIR {
  return createBuildIR({
    project: ir.project,
    target: ir.target,
    packs: ir.packs,
    actions: ir.graph.actions,
    artifacts: ir.artifacts,
    diagnosticMap: ir.diagnosticMap,
  });
}

interface LegacyBuildIRV0 {
  kind: typeof CK_BUILD_IR_KIND;
  schemaVersion: 0;
  project: Array<{
    name: string;
    content: string;
    language?: ProjectFileInput['language'];
    generated?: boolean;
  }>;
  target: {
    board: string;
    options?: Record<string, string>;
    boardPack?: BoardPackRef;
  };
  packs: BuildIR['packs'];
  actions: Array<BuildAction | BuildActionDraft>;
  artifacts?: BuildArtifact[];
  diagnostics?: DiagnosticMap | DiagnosticMapEntry[];
}

function migrateBuildIRV0(value: LegacyBuildIRV0): BuildIR {
  if (!Array.isArray(value.project)) throw new TypeError('Build IR v0 project must be an array');
  if (!Array.isArray(value.actions)) throw new TypeError('Build IR v0 actions must be an array');
  if (!value.target?.board) throw new TypeError('Build IR v0 target board is missing');
  const boardPack = value.target?.boardPack ?? value.packs?.board;
  if (!boardPack) throw new TypeError('Build IR v0 board Pack is missing');
  return createBuildIR({
    project: value.project.map((file) => ({
      path: file.name,
      content: file.content,
      ...(file.language === undefined ? {} : { language: file.language }),
      ...(file.generated === undefined ? {} : { generated: file.generated }),
    })),
    target: {
      fqbn: value.target.board,
      options: value.target?.options ?? {},
      boardPack,
    },
    packs: value.packs,
    actions: value.actions,
    artifacts: value.artifacts ?? [],
    diagnosticMap: value.diagnostics ?? [],
  });
}

/**
 * Migrate an untrusted serialized IR into the current deterministic schema.
 *
 * v0 used top-level Actions, `name` for project paths, and `board` for the
 * target FQBN. Each version step is explicit so executors never infer legacy
 * fields differently.
 */
export function migrateBuildIR(value: unknown): BuildIR {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Build IR must be an object');
  }
  const candidate = value as { kind?: unknown; schemaVersion?: unknown };
  if (candidate.kind !== CK_BUILD_IR_KIND) {
    throw new TypeError(`expected ${CK_BUILD_IR_KIND}`);
  }
  if (candidate.schemaVersion === 0) {
    return migrateBuildIRV0(value as LegacyBuildIRV0);
  }
  if (candidate.schemaVersion !== CK_BUILD_IR_SCHEMA_VERSION) {
    throw new TypeError(`unsupported schema version ${String(candidate.schemaVersion)}`);
  }
  return normalizeBuildIR(value as BuildIR);
}

export function serializeBuildIR(ir: BuildIR): string {
  return canonicalJson(normalizeBuildIR(ir));
}

export function mapDiagnostics(
  diagnostics: readonly RawBuildDiagnostic[],
  map: DiagnosticMap | readonly DiagnosticMapEntry[],
): MappedBuildDiagnostic[] {
  const entries: DiagnosticMapEntry[] = Array.isArray(map)
    ? Array.from(map as readonly DiagnosticMapEntry[])
    : [...(map as DiagnosticMap).entries];
  entries.sort(compareDiagnosticMap);
  return diagnostics.map((diagnostic) => {
    const candidates = entries.filter((entry) => (
      entry.generatedFile === diagnostic.file && entry.generatedLine === diagnostic.line
      && (entry.generatedColumn === undefined
        || diagnostic.column === undefined
        || entry.generatedColumn <= diagnostic.column)
    ));
    const entry = candidates[candidates.length - 1];
    if (!entry) {
      return {
        ...diagnostic,
        sourceFile: diagnostic.file,
        sourceLine: diagnostic.line,
        ...(diagnostic.column === undefined ? {} : { sourceColumn: diagnostic.column }),
        fromGenerated: false,
      };
    }
    const { column: generatedColumn, ...generatedDiagnostic } = diagnostic;
    return {
      ...generatedDiagnostic,
      file: entry.sourceFile,
      line: entry.sourceLine,
      ...(entry.sourceColumn === undefined ? {} : { column: entry.sourceColumn }),
      sourceFile: entry.sourceFile,
      sourceLine: entry.sourceLine,
      ...(entry.sourceColumn === undefined ? {} : { sourceColumn: entry.sourceColumn }),
      generatedFile: diagnostic.file,
      generatedLine: diagnostic.line,
      ...(generatedColumn === undefined ? {} : { generatedColumn }),
      fromGenerated: true,
    };
  });
}

function normalizeAction(action: BuildAction | BuildActionDraft): BuildAction {
  assertKnownActionFields(action);
  const { packInputs, ...withoutPackInputs } = action;
  const normalized = {
    ...withoutPackInputs,
    cacheKey: action.cacheKey ?? '',
    inputs: action.inputs.map((input) => ({ ...input })).sort(compareInput),
    outputs: action.outputs.map((output) => ({ ...output })).sort((left, right) => compareText(left.path, right.path)),
    arguments: [...action.arguments],
    environment: sortRecord(action.environment),
    dependencies: [...new Set(action.dependencies)].sort(compareText),
    packDependencies: [...new Set(action.packDependencies)].sort(compareText),
    ...(packInputs === undefined || packInputs.length === 0 ? {} : {
      packInputs: normalizePackInputs(packInputs, action.id),
    }),
    ...(action.resourceLimits === undefined ? {} : { resourceLimits: { ...action.resourceLimits } }),
  } as BuildAction;
  if (!normalized.id.trim()) throw new TypeError('action id must not be empty');
  if (!normalized.tool.trim()) throw new TypeError(`action ${normalized.id} tool must not be empty`);
  for (const input of normalized.inputs) {
    input.path = normalizePath(input.path, `action ${normalized.id} input`);
    if (input.sha256 !== undefined) assertSha256(input.sha256, `action ${normalized.id} input`);
  }
  for (const output of normalized.outputs) {
    output.path = normalizePath(output.path, `action ${normalized.id} output`);
    if (output.sha256 !== undefined) assertSha256(output.sha256, `action ${normalized.id} output`);
  }
  if (normalized.kind === 'compile') {
    normalized.compileUnit = {
      ...normalized.compileUnit,
      source: normalizePath(normalized.compileUnit.source, `action ${normalized.id} source`),
      output: normalizePath(normalized.compileUnit.output, `action ${normalized.id} output`),
      macros: sortRecord(normalized.compileUnit.macros),
      includePaths: [...normalized.compileUnit.includePaths].map((path) => normalizePath(path, `action ${normalized.id} include`)),
      flags: [...normalized.compileUnit.flags],
    };
  } else if (normalized.kind === 'archive') {
    normalized.archive = {
      objects: normalized.archive.objects.map((path) => normalizePath(path, `action ${normalized.id} archive input`)),
      output: normalizePath(normalized.archive.output, `action ${normalized.id} archive output`),
      flags: [...normalized.archive.flags],
    };
  } else if (normalized.kind === 'link') {
    normalized.link = {
      objects: normalized.link.objects.map((path) => normalizePath(path, `action ${normalized.id} link input`)),
      archives: normalized.link.archives.map((path) => normalizePath(path, `action ${normalized.id} link archive`)),
      output: normalizePath(normalized.link.output, `action ${normalized.id} link output`),
      ...(normalized.link.linkerScript === undefined ? {} : {
        linkerScript: normalizePath(normalized.link.linkerScript, `action ${normalized.id} linker script`),
      }),
      flags: [...normalized.link.flags],
    };
  } else {
    normalized.transform = {
      ...normalized.transform,
      input: normalizePath(normalized.transform.input, `action ${normalized.id} transform input`),
      output: normalizePath(normalized.transform.output, `action ${normalized.id} transform output`),
      flags: [...normalized.transform.flags],
    };
  }
  return normalized;
}

function normalizePackInputs(inputs: readonly ActionPackInput[], actionId: string): ActionPackInput[] {
  const normalized = inputs.map((input) => {
    if (input.kind !== 'pack-artifact') {
      throw new TypeError(`action ${actionId} Pack input kind is unsupported`);
    }
    if (!input.packId.trim() || !input.artifactId.trim()) {
      throw new TypeError(`action ${actionId} Pack input identity must not be empty`);
    }
    if (!Number.isSafeInteger(input.packSchema) || input.packSchema < 1 || input.packSchema > 0xffff_ffff) {
      throw new TypeError(`action ${actionId} Pack input schema must be a positive 32-bit unsigned integer`);
    }
    assertSha256(input.packRevision, `action ${actionId} Pack input revision`);
    assertSha256(input.sha256, `action ${actionId} Pack input artifact`);
    if (input.role !== undefined && !input.role.trim()) {
      throw new TypeError(`action ${actionId} Pack input role must not be empty`);
    }
    return { ...input };
  }).sort(comparePackInput);
  assertUniquePackInputs(normalized, actionId);
  return normalized;
}

function assertKnownActionFields(action: BuildAction | BuildActionDraft): void {
  const kind = action.kind;
  if (kind !== 'compile' && kind !== 'archive' && kind !== 'link' && kind !== 'transform') {
    throw new TypeError(`action ${String((action as { id?: unknown }).id ?? '<unknown>')} kind is unsupported`);
  }
  assertKnownFields(action, ACTION_FIELDS[kind], `action ${action.id}`);
  action.inputs.forEach((input, index) => {
    assertKnownFields(input, ACTION_INPUT_FIELDS, `action ${action.id} input ${index}`);
  });
  action.outputs.forEach((output, index) => {
    assertKnownFields(output, ACTION_OUTPUT_FIELDS, `action ${action.id} output ${index}`);
  });
  action.packInputs?.forEach((input, index) => {
    assertKnownFields(input, ACTION_PACK_INPUT_FIELDS, `action ${action.id} Pack input ${index}`);
  });
  if (action.resourceLimits !== undefined) {
    assertKnownFields(action.resourceLimits, ACTION_RESOURCE_LIMIT_FIELDS, `action ${action.id} resource limits`);
  }
  if (kind === 'compile') {
    assertKnownFields(action.compileUnit, COMPILE_UNIT_FIELDS, `action ${action.id} compile unit`);
  } else if (kind === 'archive') {
    assertKnownFields(action.archive, ARCHIVE_FIELDS, `action ${action.id} archive`);
  } else if (kind === 'link') {
    assertKnownFields(action.link, LINK_FIELDS, `action ${action.id} link`);
  } else {
    assertKnownFields(action.transform, TRANSFORM_FIELDS, `action ${action.id} transform`);
  }
}

function assertKnownFields(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`${label} contains unknown field ${field}`);
  }
}

function assertUniquePackInputs(inputs: readonly ActionPackInput[], actionId: string): void {
  const byPack = new Map<string, Map<string, Set<string>>>();
  for (const input of inputs) {
    let byArtifact = byPack.get(input.packId);
    if (!byArtifact) {
      byArtifact = new Map();
      byPack.set(input.packId, byArtifact);
    }
    let roles = byArtifact.get(input.artifactId);
    if (!roles) {
      roles = new Set();
      byArtifact.set(input.artifactId, roles);
    }
    const role = input.role ?? '';
    if (roles.has(role)) {
      throw new TypeError(`duplicate action ${actionId} Pack input`);
    }
    roles.add(role);
  }
}

function cloneBoardPack(pack: BoardPackRef): BoardPackRef {
  if (pack.kind !== 'board') throw new TypeError('board pack kind must be board');
  assertPackRef(pack, 'board pack');
  return { ...pack };
}

function sameBoardPack(left: BoardPackRef, right: BoardPackRef): boolean {
  return left.id === right.id
    && left.version === right.version
    && left.sha256 === right.sha256
    && left.fqbn === right.fqbn
    && left.variant === right.variant;
}

function cloneLibraryPack(pack: LibraryPackRef): LibraryPackRef {
  if (pack.kind !== 'library') throw new TypeError('library pack kind must be library');
  assertPackRef(pack, 'library pack');
  if (!pack.name.trim()) throw new TypeError('library pack name must not be empty');
  for (const dependency of pack.dependencies) {
    if (!dependency.id.trim() || !dependency.version.trim()) throw new TypeError('library dependency identity must not be empty');
    assertSha256(dependency.sha256, `library dependency ${dependency.id}`);
  }
  return {
    ...pack,
    architectures: [...pack.architectures].sort(compareText),
    manifest: sortRecord(pack.manifest),
    dependencies: pack.dependencies.map((dependency) => ({ ...dependency }))
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort(compareText).map((key) => [key, record[key]!]));
}

function normalizePath(value: string, label: string): string {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`${label} path must be relative and must not contain '..': ${value}`);
  }
  return path.split('/').filter((part) => part.length > 0 && part !== '.').join('/');
}

function inferLanguage(path: string): ProjectFile['language'] {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  if (extension === 'ino') return 'ino';
  if (extension === 'c') return 'c';
  if (extension === 'cc' || extension === 'cpp' || extension === 'cxx') return 'c++';
  if (extension === 's' || extension === 'S'.toLowerCase() || extension === 'asm') return 'asm';
  if (extension === 'h' || extension === 'hh' || extension === 'hpp' || extension === 'hxx') return 'header';
  return 'other';
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertUniqueCaseFolded(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const folded = value.toLowerCase();
    if (seen.has(folded)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(folded);
  }
}

function assertPackRef(pack: { id: string; version: string; sha256: string }, label: string): void {
  if (!pack.id.trim() || !pack.version.trim()) throw new TypeError(`${label} id and version must not be empty`);
  assertSha256(pack.sha256, label);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new TypeError(`${label} sha256 must be 64 lowercase hexadecimal characters`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareInput(left: { path: string; role?: string }, right: { path: string; role?: string }): number {
  return compareText(left.path, right.path) || compareText(left.role ?? '', right.role ?? '');
}

function comparePackInput(left: ActionPackInput, right: ActionPackInput): number {
  return compareText(left.packId, right.packId)
    || compareText(left.artifactId, right.artifactId)
    || compareText(left.role ?? '', right.role ?? '');
}

function compareDiagnosticMap(left: DiagnosticMapEntry, right: DiagnosticMapEntry): number {
  return compareText(left.generatedFile, right.generatedFile)
    || left.generatedLine - right.generatedLine
    || (left.generatedColumn ?? -1) - (right.generatedColumn ?? -1)
    || compareText(left.sourceFile, right.sourceFile)
    || left.sourceLine - right.sourceLine;
}

function assertAcyclic(actions: readonly BuildAction[]): void {
  const byId = new Map(actions.map((action) => [action.id, action] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`action graph cycle contains ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const action of actions) visit(action.id);
}
