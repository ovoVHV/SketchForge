import { createBuildIR, resolveLibraries, resolveProject, resolveTarget } from './builder.js';
export { discoverLocalLibraryExternalDependencies, resolveLocalLibraries } from './local-libraries.js';
export type { LocalLibraryResolution, LocalLibrarySource } from './local-libraries.js';
import { sha256Hex } from './canonical.js';
import { composeArduinoSketch, GENERATED_FILE, preprocess } from '../preprocess/index.js';
import type {
  ActionInput,
  ActionPackInput,
  BuildActionDraft,
  BuildArtifact,
  BuildIR,
  BuildPacks,
  CompileUnit,
  DiagnosticMapEntry,
  LibraryPackRef,
  ProjectFile,
  ProjectFileInput,
  ProjectSnapshot,
  Sha256,
  TargetInput,
  TargetSpec,
  TransformFormat,
} from './types.js';

/** A source tree attached to a platform or an immutable library pack. */
export interface PlannerSourceTree {
  files: readonly ProjectFileInput[] | ProjectSnapshot;
  includePaths?: readonly string[];
  macros?: Record<string, string | boolean>;
  flags?: PlannerCompilerFlags;
  /** Logical directory used when materialising the source pack. */
  rootPath?: string;
}

export interface PlannerCompilerFlags {
  c?: readonly string[];
  cxx?: readonly string[];
  asm?: readonly string[];
  common?: readonly string[];
}

export interface PlannerPlatformInput {
  /** Platform core sources. */
  core?: PlannerSourceTree;
  /** Board variant sources. They are archived together with the core. */
  variant?: PlannerSourceTree;
  /** Convenience form for a platform tree when core/variant are not split. */
  files?: readonly ProjectFileInput[] | ProjectSnapshot;
  includePaths?: readonly string[];
  macros?: Record<string, string | boolean>;
  flags?: PlannerCompilerFlags;
  linkerScript?: string;
  linkerFlags?: readonly string[];
  /** Immutable non-object files consumed directly by the linker. */
  linkerInputs?: readonly ActionInput[];
  /** Immutable prebuilt archives supplied by the Platform/Core Pack. */
  prebuiltArchives?: readonly ActionInput[];
  /** Flags that must follow project objects and static archives. */
  linkerTailFlags?: readonly string[];
  /** Archive operation emitted before the output path. Defaults to rcs. */
  archiveOperation?: string;
  archiveFlags?: readonly string[];
}

export interface PlannerLibraryInput {
  pack: LibraryPackRef;
  files: readonly ProjectFileInput[] | ProjectSnapshot;
  includePaths?: readonly string[];
  macros?: Record<string, string | boolean>;
  flags?: PlannerCompilerFlags;
  /** Logical directory used when materialising this pack. */
  rootPath?: string;
}

export interface PlannerToolNames {
  preprocess?: string;
  c?: string;
  cxx?: string;
  asm?: string;
  ar?: string;
  ld?: string;
  objcopy?: string;
}

export interface PlannerTransformSpec {
  /** Stable Action identity. Defaults to `transform-${productId || format}`. */
  id?: string;
  /** Stable product identity carried by the transform output descriptor. */
  productId?: string;
  /** Configuration products do not depend on project Library Packs. */
  lifecycle?: 'project' | 'configuration';
  /** Explicit Pack identities used by configuration products. */
  packDependencies?: readonly string[];
  /** Immutable Pack artifacts consumed by the transform executor adapter. */
  packInputs?: readonly ActionPackInput[];
  format: TransformFormat;
  /** Defaults to the linked ELF; Pack inputs can name another logical file. */
  input?: string;
  /** Content identity for immutable Pack inputs. */
  inputSha256?: Sha256;
  /** Complete declared input set for multi-input transforms. Must contain `input`. */
  inputs?: readonly ActionInput[];
  output?: string;
  /** Expected output bytes, verified after execution and on cache reads. */
  outputSha256?: Sha256;
  flags?: readonly string[];
  /** Logical tool id for target-specific image formats. */
  tool?: string;
  /** Complete argv override. Paths must remain logical executor paths. */
  arguments?: readonly string[];
  /** Defaults to the firmware link Action when input is the linked ELF. */
  dependencies?: readonly string[];
  /** Optional flash offset carried into the artifact descriptor. */
  offset?: string | null;
}

export interface BuildPlannerInput {
  project: ProjectSnapshot | readonly ProjectFileInput[];
  /** Optional subset of the snapshot that belongs to the main project. */
  projectCompilePaths?: readonly string[];
  target: TargetSpec | TargetInput;
  packs: BuildPacks;
  platform?: PlannerPlatformInput;
  /** Resolved library source trees. Every pack must exist in packs.libraries. */
  libraries?: readonly PlannerLibraryInput[];
  /** Alias accepted by callers that keep source trees separate from Pack refs. */
  librarySources?: readonly PlannerLibraryInput[];
  tools?: PlannerToolNames;
  macros?: Record<string, string | boolean>;
  includePaths?: readonly string[];
  flags?: PlannerCompilerFlags;
  /** Immutable compiler response/config files supplied by a Pack. */
  compilerInputs?: readonly ActionInput[];
  /** Compact identities for compiler VFS artifacts materialized by an adapter. */
  compilerPackInputs?: readonly ActionPackInput[];
  linkerFlags?: readonly string[];
  /** Immutable non-object files consumed directly by the linker. */
  linkerInputs?: readonly ActionInput[];
  /** Compact identities for linker VFS artifacts materialized by an adapter. */
  linkerPackInputs?: readonly ActionPackInput[];
  /** Flags that must follow project objects and static archives. */
  linkerTailFlags?: readonly string[];
  /** Archive operation emitted before the output path. Defaults to rcs. */
  archiveOperation?: string;
  archiveFlags?: readonly string[];
  preprocessFlags?: readonly string[];
  linkerScript?: string;
  /** Defaults to bin for non-AVR targets and hex for AVR targets. */
  transforms?: readonly (TransformFormat | PlannerTransformSpec)[];
  outputRoot?: string;
  resourceLimits?: {
    compile?: { cpuMs?: number; memoryBytes?: number; outputBytes?: number };
    archive?: { cpuMs?: number; memoryBytes?: number; outputBytes?: number };
    link?: { cpuMs?: number; memoryBytes?: number; outputBytes?: number };
    transform?: { cpuMs?: number; memoryBytes?: number; outputBytes?: number };
  };
}

export interface BuildActionPlan {
  actions: BuildActionDraft[];
  artifacts: BuildArtifact[];
  diagnosticMap: DiagnosticMapEntry[];
}

interface SourceUnit {
  file: ProjectFile;
  /** Root-level Arduino tabs represented by this single sketch translation unit. */
  sketchFiles?: readonly ProjectFile[];
  path: string;
  packId?: string;
  includePaths: string[];
  macros: Record<string, string | boolean>;
  flags: PlannerCompilerFlags;
  group: 'project' | 'core' | 'library';
}

interface ObjectRef {
  path: string;
  actionId: string;
}

interface ArchiveRef {
  path: string;
  actionId: string;
  packId?: string;
}

const DEFAULT_TOOLS: Required<PlannerToolNames> = {
  preprocess: 'ck:preprocess',
  c: 'toolchain:cc',
  cxx: 'toolchain:cxx',
  asm: 'toolchain:as',
  ar: 'toolchain:ar',
  ld: 'toolchain:ld',
  objcopy: 'toolchain:objcopy',
};

/**
 * Create a deterministic Action DAG from resolved project and Pack inputs.
 *
 * This function only plans data. It does not inspect the host filesystem and
 * does not invoke a compiler. Sketch `.ino` files are represented by a
 * transform action (`ck:preprocess`) so existing v1 executors can consume the
 * plan while a dedicated preprocess action kind is intentionally unnecessary.
 */
export function planBuildActions(input: BuildPlannerInput): BuildActionPlan {
  const project = resolveProject(input.project);
  const target = resolveTarget(input.target);
  const libraries = resolveLibraries(input.packs.libraries);
  const packs: BuildPacks = {
    ...input.packs,
    libraries,
  };
  const outputRoot = normalizePath(input.outputRoot ?? 'build', 'output root');
  const tools = { ...DEFAULT_TOOLS, ...(input.tools ?? {}) };
  const globalMacros = cloneRecord(input.macros ?? {});
  const globalIncludes = uniquePaths(input.includePaths ?? []);
  const globalFlags = normalizeFlags(input.flags);
  const actions: BuildActionDraft[] = [];
  const objects: ObjectRef[] = [];
  const archives: ArchiveRef[] = [];
  const diagnosticMap: DiagnosticMapEntry[] = [];
  // Like library Packs, project sources may include fragments with arbitrary
  // extensions. Keep every project file available to each project compile
  // Action so materialisation and cache keys reflect the complete snapshot.
  const projectCompilePaths = new Set(input.projectCompilePaths ?? project.files.map((file) => file.path));
  const projectFileInputs: ActionInput[] = project.files
    .filter((file) => projectCompilePaths.has(file.path))
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      role: file.language === 'header' ? 'project-header' : 'project-file',
    }));
  const projectSketches = orderProjectSketches(project.files.filter((file) => (
    projectCompilePaths.has(file.path)
  )));
  const projectSketchPaths = new Set(projectSketches.map((file) => file.path));
  const projectLibraryIds = libraries.packs.map((pack) => pack.id);
  const platform = input.platform;
  const archiveOperation = normalizeArchiveOperation(
    platform?.archiveOperation ?? input.archiveOperation,
  );
  const platformTrees: Array<{ tree: PlannerSourceTree; role: 'core' | 'variant' }> = [];
  if (platform?.core) platformTrees.push({ tree: platform.core, role: 'core' });
  if (platform?.variant) platformTrees.push({ tree: platform.variant, role: 'variant' });
  if (platform?.files && platformTrees.length === 0) {
    platformTrees.push({ tree: { files: platform.files, rootPath: `packs/platform/${slug(target.fqbn)}` }, role: 'core' });
  }

  const platformIncludePaths = uniquePaths([
    ...(platform?.includePaths ?? []),
    ...platformTrees.flatMap(({ tree, role }) => {
      const root = normalizePackRoot(
        tree.rootPath ?? `packs/platform/${slug(target.fqbn)}/${role}`,
      );
      return (tree.includePaths ?? []).map((path) => joinPath(root, path));
    }),
    // Core headers commonly include the board Variant (for example
    // Arduino.h -> pins_arduino.h). Make every platform tree visible to every
    // platform compilation unit, regardless of which tree owns the source.
    ...platformTrees.map(({ tree, role }) => normalizePackRoot(
      tree.rootPath ?? `packs/platform/${slug(target.fqbn)}/${role}`,
    )),
  ]);
  const platformMacros = mergeRecords(globalMacros, platform?.macros ?? {});
  const platformFlags = mergeFlags(globalFlags, platform?.flags);

  const libraryInputs = input.libraries ?? input.librarySources ?? [];
  const libraryById = new Map<string, PlannerLibraryInput>();
  for (const library of libraryInputs) {
    const existing = libraryById.get(library.pack.id);
    if (existing) throw new TypeError(`duplicate library source tree: ${library.pack.id}`);
    const resolved = libraries.packs.find((pack) => pack.id === library.pack.id);
    if (!resolved || resolved.version !== library.pack.version || resolved.sha256 !== library.pack.sha256) {
      throw new TypeError(`library source Pack does not match resolved Pack: ${library.pack.id}`);
    }
    libraryById.set(library.pack.id, library);
  }

  const textIncludedSourcesById = new Map<string, Set<string>>();
  for (const library of libraryInputs) {
    const files = resolveSourceTree(library.files).files;
    textIncludedSourcesById.set(
      library.pack.id,
      findTextIncludedSources(files, library.includePaths ?? []),
    );
  }

  const allLibraryIncludes = uniquePaths(libraryInputs.flatMap((library) => {
    const root = normalizePackRoot(library.rootPath ?? `packs/libraries/${slug(library.pack.id)}`);
    return [root, ...(library.includePaths ?? []).map((path) => joinPath(root, path))];
  }));
  const privateLibraryIncludes = resolvePrivateLibraryIncludePaths(libraryInputs);
  // A compiler can include files with arbitrary extensions (for example,
  // Adafruit GFX includes glcdfont.c). Every file exposed by a selected Pack
  // therefore participates in materialisation and the Action cache identity.
  // This is intentionally Pack-driven rather than a library-name allowlist.
  const libraryFileInputsById = new Map<string, ActionInput[]>();
  for (const pack of libraries.packs) {
    const sourceTree = libraryById.get(pack.id);
    if (!sourceTree) continue;
    const root = normalizePackRoot(sourceTree.rootPath ?? `packs/libraries/${slug(pack.id)}`);
    const textIncludedSources = textIncludedSourcesById.get(pack.id) ?? new Set<string>();
    const files = resolveSourceTree(sourceTree.files).files
      .map((file) => ({
        path: joinPath(root, file.path),
        sha256: file.sha256,
        role: file.language === 'header'
          ? 'library-header'
          : isLibraryIncludeFragment(file.path) || textIncludedSources.has(file.path)
            ? 'library-include-fragment'
            : 'library-file',
      }));
    libraryFileInputsById.set(pack.id, files);
  }
  const allLibraryFileInputs = [...libraryFileInputsById.values()].flat()
    .sort((left, right) => compareText(left.path, right.path));
  // Project Actions need headers and include-only template fragments, but not
  // independent library sources or metadata. Keeping archive sources out of
  // this list preserves independent library caching.
  const projectLibraryInputs = allLibraryFileInputs.filter((input) => (
    input.role === 'library-header' || input.role === 'library-include-fragment'
  ));

  for (const file of project.files) {
    if (!projectCompilePaths.has(file.path)) continue;
    if (!isCompilable(file)) continue;
    if (projectSketchPaths.has(file.path) && file.path !== projectSketches[0]?.path) continue;
    const unit: SourceUnit = {
      file,
      ...(file.path === projectSketches[0]?.path ? { sketchFiles: projectSketches } : {}),
      path: file.path,
      includePaths: uniquePaths([...globalIncludes, ...sourceDirectory(file.path), ...allLibraryIncludes, ...platformIncludePaths]),
      macros: globalMacros,
      flags: globalFlags,
      group: 'project',
    };
    const planned = addCompileUnit(unit, {
      actions,
      objects,
      allLibraryIds: projectLibraryIds,
      outputRoot,
      tools,
      preprocessFlags: input.preprocessFlags ?? [],
      additionalInputs: [...projectFileInputs, ...projectLibraryInputs, ...(input.compilerInputs ?? [])],
      packInputs: input.compilerPackInputs,
      resourceLimits: input.resourceLimits,
      diagnosticMap,
    });
    if (planned) objects.push(planned);
  }

  const coreObjects: ObjectRef[] = [];
  for (const { tree, role } of platformTrees) {
    const resolvedTree = resolveSourceTree(tree.files);
    const root = normalizePackRoot(tree.rootPath ?? `packs/platform/${slug(target.fqbn)}/${role}`);
    const treeIncludes = uniquePaths([
      ...platformIncludePaths,
      root,
      ...(tree.includePaths ?? []).map((path) => joinPath(root, path)),
      ...allLibraryIncludes,
    ]);
    for (const file of resolvedTree.files) {
      if (!isCompilable(file)) continue;
      const planned = addCompileUnit({
        file,
        path: joinPath(root, file.path),
        includePaths: treeIncludes,
        macros: mergeRecords(platformMacros, tree.macros ?? {}),
        flags: mergeFlags(platformFlags, tree.flags),
        group: 'core',
      }, {
        actions,
        objects: coreObjects,
        allLibraryIds: [],
        outputRoot,
        tools,
        preprocessFlags: input.preprocessFlags ?? [],
        additionalInputs: input.compilerInputs,
        packInputs: input.compilerPackInputs,
        resourceLimits: input.resourceLimits,
        diagnosticMap,
      });
      if (planned) coreObjects.push(planned);
    }
  }
  if (coreObjects.length) {
    const archivePath = joinPath(joinPath(outputRoot, 'lib'), 'core.a');
    const id = 'archive-core';
    actions.push({
      id,
      kind: 'archive',
      tool: tools.ar,
      inputs: coreObjects.map((object) => ({ path: object.path, role: 'object' })),
      outputs: [{ path: archivePath, kind: 'static-library' }],
      arguments: [archiveOperation, archivePath, ...coreObjects.map((object) => object.path), ...(platform?.archiveFlags ?? input.archiveFlags ?? [])],
      environment: {},
      dependencies: coreObjects.map((object) => object.actionId),
      packDependencies: [],
      ...(input.resourceLimits?.archive === undefined ? {} : { resourceLimits: input.resourceLimits.archive }),
      archive: {
        objects: coreObjects.map((object) => object.path),
        output: archivePath,
        flags: [...(platform?.archiveFlags ?? input.archiveFlags ?? [])],
      },
    });
    archives.push({ path: archivePath, actionId: id });
  }

  for (const pack of libraries.packs) {
    const sourceTree = libraryById.get(pack.id);
    if (!sourceTree) continue;
    const files = resolveSourceTree(sourceTree.files);
    const textIncludedSources = textIncludedSourcesById.get(pack.id) ?? new Set<string>();
    const root = normalizePackRoot(sourceTree.rootPath ?? `packs/libraries/${slug(pack.id)}`);
    const includes = uniquePaths([
      ...globalIncludes,
      root,
      ...(sourceTree.includePaths ?? []).map((path) => joinPath(root, path)),
      ...allLibraryIncludes,
      ...platformIncludePaths,
    ]);
    const libraryObjects: ObjectRef[] = [];
    const libraryPackDependencies = libraryDependencyClosure(pack.id, libraries.packs);
    const libraryFileInputs = libraryPackDependencies
      .flatMap((id) => libraryFileInputsById.get(id) ?? [])
      .sort((left, right) => compareText(left.path, right.path));
    const libraryProjectHeaders = referencedProjectHeaders(
      libraryPackDependencies.flatMap((id) => {
        const dependency = libraryById.get(id);
        return dependency ? resolveSourceTree(dependency.files).files : [];
      }),
      project.files,
      globalIncludes,
    );
    for (const file of files.files) {
      if (!isCompilable(file) || textIncludedSources.has(file.path)) continue;
      const planned = addCompileUnit({
        file,
        path: joinPath(root, file.path),
        // Quoted sibling headers are resolved relative to the source file by
        // native compilers. Browser adapters may add quote-only compatibility
        // roots, but nested library directories must not become ordinary -I
        // roots because private names can shadow SDK or standard headers.
        includePaths: includes,
        macros: mergeRecords(globalMacros, sourceTree.macros ?? {}),
        flags: mergeFlags(
          mergeFlags(globalFlags, sourceTree.flags),
          {
            common: (privateLibraryIncludes.get(pack.id) ?? [])
              .flatMap((path) => ['-idirafter', path]),
          },
        ),
        group: 'library',
        packId: pack.id,
      }, {
        actions,
        objects: libraryObjects,
        allLibraryIds: libraryPackDependencies,
        outputRoot,
        tools,
        preprocessFlags: input.preprocessFlags ?? [],
        additionalInputs: [
          ...libraryProjectHeaders,
          ...libraryFileInputs,
          ...(input.compilerInputs ?? []),
        ],
        packInputs: input.compilerPackInputs,
        resourceLimits: input.resourceLimits,
        diagnosticMap,
      });
      if (planned) libraryObjects.push(planned);
    }
    if (!libraryObjects.length) continue;
    const archivePath = joinPath(joinPath(outputRoot, 'lib'), `${slug(pack.id)}.a`);
    const id = `archive-library-${slug(pack.id)}`;
    const flags = [...(input.archiveFlags ?? [])];
    actions.push({
      id,
      kind: 'archive',
      tool: tools.ar,
      inputs: libraryObjects.map((object) => ({ path: object.path, role: 'object' })),
      outputs: [{ path: archivePath, kind: 'static-library' }],
      arguments: [archiveOperation, archivePath, ...libraryObjects.map((object) => object.path), ...flags],
      environment: {},
      dependencies: libraryObjects.map((object) => object.actionId),
      packDependencies: libraryPackDependencies,
      ...(input.resourceLimits?.archive === undefined ? {} : { resourceLimits: input.resourceLimits.archive }),
      archive: { objects: libraryObjects.map((object) => object.path), output: archivePath, flags },
    });
    archives.push({ path: archivePath, actionId: id, packId: pack.id });
  }

  // Static archives must be presented dependency-first. AVR's linker scans
  // archives from left to right; a lexical order is deterministic but can
  // leave symbols unresolved when a library depends on another archive.
  const archiveByPack = new Map(
    archives.filter((archive) => archive.packId).map((archive) => [archive.packId!, archive] as const),
  );
  const orderedArchives: ArchiveRef[] = [];
  const visitedPacks = new Set<string>();
  const visitPack = (packId: string): void => {
    if (visitedPacks.has(packId)) return;
    visitedPacks.add(packId);
    const pack = libraries.packs.find((candidate) => candidate.id === packId);
    if (!pack) return;
    for (const dependency of [...pack.dependencies].sort((left, right) => compareText(left.id, right.id))) {
      visitPack(dependency.id);
    }
    const archive = archiveByPack.get(packId);
    if (archive) orderedArchives.push(archive);
  };
  for (const pack of libraries.packs) visitPack(pack.id);
  const coreArchive = archives.find((archive) => archive.packId === undefined);
  if (coreArchive) orderedArchives.push(coreArchive);
  archives.splice(0, archives.length, ...orderedArchives);
  const elfPath = joinPath(outputRoot, 'firmware.elf');
  const linkId = 'link-firmware';
  const linkFlags = [...(platform?.linkerFlags ?? input.linkerFlags ?? [])];
  const linkTailFlags = [...(platform?.linkerTailFlags ?? input.linkerTailFlags ?? [])];
  const linkerScript = platform?.linkerScript ?? input.linkerScript;
  const additionalLinkerInputs = platform?.linkerInputs ?? input.linkerInputs ?? [];
  const prebuiltArchives = platform?.prebuiltArchives ?? [];
  const linkInputs = [
    ...objects.map((object) => ({ path: object.path, role: 'object' })),
    ...archives.map((archive) => ({ path: archive.path, role: 'static-library' })),
    ...prebuiltArchives.map((archive) => ({ ...archive, role: archive.role ?? 'static-library' })),
    ...(linkerScript ? [{ path: linkerScript, role: 'linker-script' }] : []),
    ...additionalLinkerInputs.map((item) => ({ ...item })),
  ];
  const linkDependencies = [
    ...objects.map((object) => object.actionId),
    ...archives.map((archive) => archive.actionId),
  ];
  actions.push({
    id: linkId,
    kind: 'link',
    tool: tools.ld,
    inputs: linkInputs,
    outputs: [{ path: elfPath, kind: 'elf' }],
    arguments: [
      ...linkFlags,
      ...(linkerScript ? ['-T', linkerScript] : []),
      ...objects.map((object) => object.path),
      ...archives.map((archive) => archive.path),
      ...prebuiltArchives.map((archive) => archive.path),
      ...linkTailFlags,
      '-o', elfPath,
    ],
    environment: {},
    dependencies: linkDependencies,
    packDependencies: projectLibraryIds,
    ...(input.linkerPackInputs?.length ? { packInputs: input.linkerPackInputs.map((item) => ({ ...item })) } : {}),
    ...(input.resourceLimits?.link === undefined ? {} : { resourceLimits: input.resourceLimits.link }),
    link: {
      objects: objects.map((object) => object.path),
      archives: [
        ...archives.map((archive) => archive.path),
        ...prebuiltArchives.map((archive) => archive.path),
      ],
      output: elfPath,
      ...(linkerScript ? { linkerScript } : {}),
      flags: [...linkFlags, ...linkTailFlags],
    },
  });

  const artifacts: BuildArtifact[] = [{ path: elfPath, format: 'elf' }];
  const transforms = normalizeTransforms(input.transforms, target, outputRoot).map((spec) => {
    if (spec.format === 'elf') return { spec };
    const productId = normalizeTransformProductId(spec.productId ?? spec.format);
    return {
      spec,
      id: normalizeTransformActionId(spec.id ?? `transform-${productId}`),
      productId,
      output: normalizePath(
        spec.output ?? defaultTransformOutput(outputRoot, spec.format),
        `transform ${productId} output`,
      ),
    };
  });
  const producerByOutput = new Map<string, string>();
  for (const action of actions) {
    for (const output of action.outputs) producerByOutput.set(output.path, action.id);
  }
  const transformIds = new Set<string>();
  for (const transform of transforms) {
    if (!transform.id || !transform.output || !transform.productId) continue;
    if (transformIds.has(transform.id)) {
      throw new TypeError(`duplicate transform action id: ${transform.id}`);
    }
    transformIds.add(transform.id);
    const existing = producerByOutput.get(transform.output);
    if (existing !== undefined) {
      throw new TypeError(`transform output has multiple owners: ${transform.output}`);
    }
    producerByOutput.set(transform.output, transform.id);
  }
  for (const { spec, id, productId, output } of transforms) {
    if (spec.format === 'elf') {
      if (spec.offset !== undefined) artifacts[0] = { ...artifacts[0]!, offset: spec.offset };
      continue;
    }
    const transformInput = normalizePath(
      spec.input ?? spec.inputs?.[0]?.path ?? elfPath,
      `transform ${spec.id ?? spec.productId ?? spec.format} input`,
    );
    const transformInputs = normalizeTransformInputs(spec, transformInput, elfPath);
    const flags = [...(spec.flags ?? [])];
    const dependencySet = new Set(spec.dependencies ?? []);
    for (const transformActionInput of transformInputs) {
      const producer = producerByOutput.get(transformActionInput.path);
      if (producer !== undefined) {
        if (producer === id) {
          throw new TypeError(`transform ${id} consumes its own output: ${transformActionInput.path}`);
        }
        dependencySet.add(producer);
      } else if (transformActionInput.sha256 === undefined) {
        throw new TypeError(
          `transform ${id} input has neither an immutable sha256 nor a producing Action: ${transformActionInput.path}`,
        );
      }
    }
    const dependencies = [...dependencySet].sort(compareText);
    actions.push({
      id: id!,
      kind: 'transform',
      tool: spec.tool ?? tools.objcopy,
      inputs: transformInputs,
      outputs: [{
        path: output!,
        kind: productId,
        ...(spec.outputSha256 === undefined ? {} : { sha256: spec.outputSha256 }),
      }],
      arguments: spec.arguments
        ? [...spec.arguments]
        : transformArguments(spec.format, transformInput, output!, flags),
      environment: {},
      dependencies,
      packDependencies: spec.packDependencies === undefined
        ? spec.lifecycle === 'configuration' ? [] : projectLibraryIds
        : [...spec.packDependencies],
      ...(spec.packInputs?.length ? { packInputs: spec.packInputs.map((item) => ({ ...item })) } : {}),
      ...(input.resourceLimits?.transform === undefined ? {} : { resourceLimits: input.resourceLimits.transform }),
      transform: { input: transformInput, output: output!, format: spec.format, flags },
    });
    artifacts.push({ path: output!, format: spec.format, ...(spec.offset === undefined ? {} : { offset: spec.offset }) });
  }

  actions.sort((left, right) => compareText(left.id, right.id));
  artifacts.sort((left, right) => compareText(left.path, right.path));
  diagnosticMap.sort(compareDiagnosticMap);
  return { actions, artifacts, diagnosticMap };
}

/** Build a complete, key-calculated CK Build IR from the same plan. */
export function planBuildIR(input: BuildPlannerInput): BuildIR {
  const plan = planBuildActions(input);
  return createBuildIR({
    project: resolveProject(input.project),
    target: input.target,
    packs: input.packs,
    actions: plan.actions,
    artifacts: plan.artifacts,
    diagnosticMap: plan.diagnosticMap,
  });
}

/** Alias used by callers that call all planners `create*`. */
export const createBuildActionPlan = planBuildActions;

function addCompileUnit(
  unit: SourceUnit,
  context: {
    actions: BuildActionDraft[];
    objects: ObjectRef[];
    allLibraryIds: string[];
    outputRoot: string;
    tools: Required<PlannerToolNames>;
    preprocessFlags: readonly string[];
    additionalInputs?: readonly ActionInput[];
    packInputs?: readonly ActionPackInput[];
    resourceLimits?: BuildPlannerInput['resourceLimits'];
    diagnosticMap: DiagnosticMapEntry[];
  },
): ObjectRef | undefined {
  if (!isCompilable(unit.file)) return undefined;
  let source = unit.path;
  let preprocessId: string | undefined;
  if (unit.file.language === 'ino') {
    const sketches = unit.sketchFiles?.length ? [...unit.sketchFiles] : [unit.file];
    const composition = composeArduinoSketch(sketches);
    const processed = preprocess(composition.source, { sourceName: unit.path });
    for (const [generatedLine, fn] of processed.generatedLineToFunction) {
      const origin = composition.lineOrigins.get(fn.line);
      if (!origin) throw new TypeError(`preprocessed sketch function has no source origin at line ${fn.line}`);
      context.diagnosticMap.push({
        generatedFile: GENERATED_FILE,
        generatedLine,
        generatedColumn: 1,
        sourceFile: origin.sourceFile,
        sourceLine: origin.sourceLine,
        sourceColumn: 1,
      });
    }
    source = joinPath(joinPath(context.outputRoot, 'generated'), `${withoutExtension(unit.path)}.cpp`);
    preprocessId = `preprocess-${slug(unit.path)}`;
    context.actions.push({
      id: preprocessId,
      kind: 'transform',
      tool: context.tools.preprocess,
      inputs: sketches.map((sketch, index) => ({
        path: sketch.path,
        sha256: sketch.sha256,
        role: index === 0 ? 'sketch-main' : 'sketch-tab',
      })),
      outputs: [{ path: source, kind: 'generated-source' }],
      arguments: [...sketches.map((sketch) => sketch.path), '-o', source, ...context.preprocessFlags],
      environment: {},
      dependencies: [],
      packDependencies: context.allLibraryIds,
      ...(context.resourceLimits?.transform === undefined ? {} : { resourceLimits: context.resourceLimits.transform }),
      transform: { input: unit.path, output: source, format: 'other', flags: [...context.preprocessFlags] },
    });
  }
  // Include the source identity in the object name. `foo.c` and `foo.cpp`
  // are valid siblings and must never overwrite one another.
  const output = joinPath(joinPath(joinPath(context.outputRoot, 'obj'), unit.group), `${slug(unit.path)}.o`);
  const id = `${unit.group === 'project' ? 'compile-project' : unit.group === 'core' ? 'compile-core' : 'compile-library'}-${slug(unit.path)}`;
  const flags = compileFlags(unit.file.language, unit.flags);
  const macroArgs = Object.entries(unit.macros).sort(([a], [b]) => compareText(a, b))
    .map(([key, value]) => `-D${key}${value === true ? '' : `=${value}`}`);
  const includeArgs = uniquePaths(unit.includePaths).map((path) => `-I${path}`);
  const compiler = unit.file.language === 'c' ? context.tools.c : unit.file.language === 'asm' ? context.tools.asm : context.tools.cxx;
  const compileUnit: CompileUnit = {
    // Arduino sketches are preprocessed into C++ before the compiler action.
    // Build IR describes the executable compile unit, not the source file's
    // frontend extension, so `.ino` must be represented as `c++` here.
    language: unit.file.language === 'ino' ? 'c++' : unit.file.language as CompileUnit['language'],
    source,
    output,
    macros: cloneRecord(unit.macros),
    includePaths: uniquePaths(unit.includePaths),
    flags: [...flags],
  };
  const sourceInput = unit.file.language === 'ino'
    ? { path: source, role: 'generated-source' }
    : { path: unit.path, sha256: unit.file.sha256, role: 'source' };
  const additionalInputs = (context.additionalInputs ?? [])
    .filter((input) => (
      input.path !== sourceInput.path
      && (input.role !== 'compiler-response-file' || flags.includes(`@${input.path}`))
    ))
    .map((input) => ({ ...input }));
  context.actions.push({
    id,
    kind: 'compile',
    tool: compiler,
    inputs: [sourceInput, ...additionalInputs],
    outputs: [{ path: output, kind: 'object' }],
    arguments: [...flags, ...macroArgs, ...includeArgs, '-c', source, '-o', output],
    environment: {},
    dependencies: preprocessId ? [preprocessId] : [],
    packDependencies: context.allLibraryIds,
    ...(context.packInputs?.length ? { packInputs: context.packInputs.map((item) => ({ ...item })) } : {}),
    ...(context.resourceLimits?.compile === undefined ? {} : { resourceLimits: context.resourceLimits.compile }),
    compileUnit,
  });
  return { path: output, actionId: id };
}

function orderProjectSketches(files: readonly ProjectFile[]): ProjectFile[] {
  const sketches = files
    .filter((file) => file.language === 'ino' && !file.path.includes('/'))
    .slice()
    .sort((left, right) => compareText(left.path, right.path));
  if (sketches.length < 2) return sketches;
  const mainIndex = sketches.findIndex((file) => file.path.toLowerCase() === 'main.ino');
  if (mainIndex <= 0) return sketches;
  const [main] = sketches.splice(mainIndex, 1);
  sketches.unshift(main!);
  return sketches;
}

function compareDiagnosticMap(left: DiagnosticMapEntry, right: DiagnosticMapEntry): number {
  return compareText(left.generatedFile, right.generatedFile)
    || left.generatedLine - right.generatedLine
    || (left.generatedColumn ?? 0) - (right.generatedColumn ?? 0)
    || compareText(left.sourceFile, right.sourceFile)
    || left.sourceLine - right.sourceLine
    || (left.sourceColumn ?? 0) - (right.sourceColumn ?? 0);
}

function libraryDependencyClosure(packId: string, packs: readonly LibraryPackRef[]): string[] {
  const byId = new Map(packs.map((pack) => [pack.id, pack] as const));
  const ids = new Set<string>();
  const visit = (id: string): void => {
    if (ids.has(id)) return;
    const pack = byId.get(id);
    if (!pack) throw new TypeError(`library source Pack references missing dependency: ${id}`);
    ids.add(id);
    for (const dependency of pack.dependencies) visit(dependency.id);
  };
  visit(packId);
  return [...ids].sort(compareText);
}

function normalizeTransforms(
  values: BuildPlannerInput['transforms'],
  target: TargetSpec,
  outputRoot: string,
): PlannerTransformSpec[] {
  if (values?.length) return values.map((value) => typeof value === 'string' ? { format: value } : { ...value });
  const arch = target.fqbn.split(':')[1]?.toLowerCase() ?? '';
  return [{ format: arch === 'avr' || arch.includes('avr') ? 'hex' : 'bin', output: defaultTransformOutput(outputRoot, arch === 'avr' || arch.includes('avr') ? 'hex' : 'bin') }];
}

function normalizeTransformProductId(value: string): string {
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new TypeError(`transform product id is invalid: ${value}`);
  }
  return id;
}

function normalizeTransformActionId(value: string): string {
  const id = value.trim();
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new TypeError(`transform action id is invalid: ${value}`);
  }
  return id;
}

function normalizeTransformInputs(
  spec: PlannerTransformSpec,
  transformInput: string,
  elfPath: string,
): ActionInput[] {
  if (spec.inputs === undefined) {
    return [{
      path: transformInput,
      ...(spec.inputSha256 === undefined ? {} : { sha256: spec.inputSha256 }),
      role: transformInput === elfPath ? 'elf' : 'transform-input',
    }];
  }
  if (!spec.inputs.length) throw new TypeError(`transform ${spec.id ?? spec.format} inputs must not be empty`);
  const seen = new Set<string>();
  const inputs = spec.inputs.map((input, index): ActionInput => {
    const path = normalizePath(input.path, `transform ${spec.id ?? spec.format} input ${index}`);
    if (seen.has(path)) throw new TypeError(`transform ${spec.id ?? spec.format} has duplicate input: ${path}`);
    seen.add(path);
    return {
      ...input,
      path,
      role: input.role ?? (path === transformInput
        ? transformInput === elfPath ? 'elf' : 'transform-input'
        : 'transform-input'),
    };
  });
  const primary = inputs.find((input) => input.path === transformInput);
  if (!primary) {
    throw new TypeError(`transform ${spec.id ?? spec.format} inputs do not contain primary input: ${transformInput}`);
  }
  if (spec.inputSha256 !== undefined) {
    if (primary.sha256 !== undefined && primary.sha256 !== spec.inputSha256) {
      throw new TypeError(`transform ${spec.id ?? spec.format} primary input sha256 does not match inputSha256`);
    }
    primary.sha256 = spec.inputSha256;
  }
  return inputs;
}

function defaultTransformOutput(root: string, format: TransformFormat): string {
  if (format === 'model') return joinPath(root, 'srmodels.bin');
  const extension = format === 'boot-app0'
    ? 'boot_app0.bin'
    : format === 'bootloader'
      ? 'bootloader.bin'
      : format === 'partition'
        ? 'partitions.bin'
        : format;
  return joinPath(root, `firmware.${extension}`);
}

function transformArguments(
  format: TransformFormat,
  input: string,
  output: string,
  flags: readonly string[],
): string[] {
  // GNU objcopy expects the output format before the input/output paths. Keep
  // user flags last so callers can append target-specific switches without
  // accidentally changing the logical input or output operand.
  const outputFormat = format === 'hex' ? 'ihex' : format === 'bin' ? 'binary' : format;
  return ['-O', outputFormat, input, output, ...flags];
}

function resolveSourceTree(input: readonly ProjectFileInput[] | ProjectSnapshot): ProjectSnapshot {
  return 'files' in input ? resolveProject(input.files) : resolveProject(input);
}

const TEXT_SOURCE_INCLUDE = /^\s*#\s*include\s*([<"])([^>"]+\.(?:c|cc|cpp|cxx))[>"]/gmi;
const HEADER_INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gmi;
const PRIVATE_HEADER_INCLUDE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/gmi;

/**
 * Resolve legacy private headers by their full include path.
 *
 * Arduino libraries sometimes keep headers under `src/utility` while source
 * files include them as `<Header.h>`. Those directories must be searchable,
 * but making every nested directory an ordinary `-I` root lets private files
 * such as `assert.h` shadow platform or standard headers. Add only uniquely
 * referenced directories and use `-idirafter` so public and system roots win.
 * A qualified path narrows candidates by its complete suffix; a bare filename
 * still requires a globally unique basename.
 */
function resolvePrivateLibraryIncludePaths(
  libraries: readonly PlannerLibraryInput[],
): Map<string, string[]> {
  const trees = libraries.map((library) => {
    const root = normalizePackRoot(library.rootPath ?? `packs/libraries/${slug(library.pack.id)}`);
    const files = resolveSourceTree(library.files).files;
    return {
      packId: library.pack.id,
      root,
      files,
      visibleRoots: uniquePaths([
        root,
        ...(library.includePaths ?? []).map((path) => joinPath(root, path)),
      ]),
    };
  });
  const allFiles = trees.flatMap((tree) => tree.files.map((file) => ({
    tree,
    file,
    path: joinPath(tree.root, file.path),
  })));
  const paths = new Set(allFiles.map(({ path }) => path));
  const visibleRoots = uniquePaths(trees.flatMap((tree) => tree.visibleRoots));
  const result = new Map<string, Set<string>>();

  for (const tree of trees) {
    for (const owner of tree.files) {
      const source = withoutCxxComments(owner.content);
      PRIVATE_HEADER_INCLUDE.lastIndex = 0;
      for (let match = PRIVATE_HEADER_INCLUDE.exec(source); match; match = PRIVATE_HEADER_INCLUDE.exec(source)) {
        const include = match[2]!.replaceAll('\\', '/').replace(/^\.\//, '');
        if (!include || include.startsWith('/') || include.includes('\0') || include.split('/').includes('..')) continue;

        if (match[1] === '"') {
          const ownerDirectory = sourceDirectory(owner.path)[0] ?? '';
          const sibling = resolveIncludePath(joinPath(tree.root, ownerDirectory || '.'), include);
          if (sibling && paths.has(sibling)) continue;
        }

        const ordinaryCandidates = visibleRoots
          .map((root) => resolveIncludePath(root, include))
          .filter((path): path is string => path !== undefined);
        if (ordinaryCandidates.some((path) => paths.has(path))) continue;

        const suffix = `/${include}`;
        const matches = allFiles.filter(({ path }) => path.endsWith(suffix));
        if (matches.length !== 1) continue;
        const privateRoot = matches[0]!.path.slice(0, -suffix.length);
        if (!privateRoot || visibleRoots.includes(privateRoot)) continue;
        let pathsForPack = result.get(tree.packId);
        if (!pathsForPack) {
          pathsForPack = new Set<string>();
          result.set(tree.packId, pathsForPack);
        }
        pathsForPack.add(privateRoot);
      }
    }
  }

  return new Map([...result].map(([packId, pathsForPack]) => [
    packId,
    [...pathsForPack].sort(compareText),
  ]));
}

/** Source fragments included as text belong to their including compile unit. */
function findTextIncludedSources(files: readonly ProjectFile[], includePaths: readonly string[]): Set<string> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const roots = ['', ...includePaths];
  const included = new Set<string>();
  for (const owner of files) {
    const source = withoutCxxComments(owner.content);
    TEXT_SOURCE_INCLUDE.lastIndex = 0;
    for (let match = TEXT_SOURCE_INCLUDE.exec(source); match; match = TEXT_SOURCE_INCLUDE.exec(source)) {
      const include = match[2]!.replaceAll('\\', '/');
      const candidates = match[1] === '"'
        ? [resolveIncludePath(sourceDirectory(owner.path)[0] ?? '', include)]
        : [];
      candidates.push(...roots.map((root) => resolveIncludePath(root, include)));
      const target = candidates.find((path): path is string => path !== undefined && byPath.has(path));
      const targetFile = target === undefined ? undefined : byPath.get(target);
      if (targetFile && target !== owner.path && (targetFile.language === 'c' || targetFile.language === 'c++')) {
        included.add(targetFile.path);
      }
    }
  }
  return included;
}

/**
 * Return project headers that a library Pack can include through the target's
 * include search paths. Library Actions must declare these inputs so an
 * executor can materialise user configuration headers (for example
 * `lv_conf.h`) without making every project header invalidate every library.
 */
function referencedProjectHeaders(
  libraryFiles: readonly ProjectFile[],
  projectFiles: readonly ProjectFile[],
  includePaths: readonly string[],
): ActionInput[] {
  const headers = projectFiles.filter((file) => file.language === 'header');
  if (!headers.length || !libraryFiles.length) return [];

  const byPath = new Map(headers.map((file) => [file.path, file]));
  const roots = projectIncludeRoots(includePaths);
  const referenced = new Set<string>();

  for (const owner of libraryFiles) {
    const source = withoutCxxComments(owner.content);
    HEADER_INCLUDE.lastIndex = 0;
    for (let match = HEADER_INCLUDE.exec(source); match; match = HEADER_INCLUDE.exec(source)) {
      const include = match[1]!.replaceAll('\\', '/').replace(/^\.\//, '');
      if (!include || include.startsWith('/') || include.includes('\0')) continue;

      for (const root of roots) {
        const candidate = resolveIncludePath(root, include);
        if (candidate && byPath.has(candidate)) {
          referenced.add(candidate);
        }
      }
      // Some libraries intentionally keep a user configuration header outside
      // their Pack root (for example LVGL's ../../lv_conf.h convention). Once
      // the parent segments escape packs/libraries/<id>, match the remaining
      // suffix against the project snapshot. This records the real input in
      // Build IR; the executor is responsible for its isolated VFS mapping.
      if (include.includes('..')) {
        const escaped = escapedLibraryIncludeSuffix(owner.path, include);
        if (escaped !== undefined) {
          const matches = headers.filter((header) => (
            header.path === escaped || header.path.endsWith(`/${escaped}`)
          ));
          if (matches.length === 1) referenced.add(matches[0]!.path);
        }
      }
    }
  }

  return headers
    .filter((header) => referenced.has(header.path))
    .map((header) => ({ path: header.path, sha256: header.sha256, role: 'project-header' }));
}

function escapedLibraryIncludeSuffix(ownerPath: string, include: string): string | undefined {
  const normalizedOwner = ownerPath.replaceAll('\\', '/');
  const match = /^packs\/libraries\/[^/]+\/(.*)$/.exec(normalizedOwner);
  const relativeOwner = match?.[1] ?? normalizedOwner;
  const slash = relativeOwner.lastIndexOf('/');
  const directory = slash < 0 ? [] : relativeOwner.slice(0, slash).split('/').filter(Boolean);
  const segments = include.split('/').filter((segment) => segment && segment !== '.');
  let depth = directory.length;
  let escaped = false;
  const suffix: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) escaped = true;
    } else suffix.push(segment);
  }
  return escaped && suffix.length ? suffix.join('/') : undefined;
}

function projectIncludeRoots(includePaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const raw of includePaths) {
    const path = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!path) continue;
    if (path === 'project') roots.add('');
    else if (path.startsWith('project/')) roots.add(path.slice('project/'.length));
    else roots.add(path);
  }
  return [...roots].sort(compareText);
}

function withoutCxxComments(source: string): string {
  let result = '';
  let state: 'normal' | 'line' | 'block' | 'string' | 'char' = 'normal';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        result += char;
        state = 'normal';
      } else result += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'normal';
      } else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'string' || state === 'char') {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) state = 'normal';
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line';
    } else if (char === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block';
    } else {
      result += char;
      if (char === '"') state = 'string';
      else if (char === "'") state = 'char';
    }
  }
  return result;
}

function resolveIncludePath(root: string, include: string): string | undefined {
  if (!include || include.startsWith('/') || /^[A-Za-z]:\//.test(include) || include.includes('\0')) return undefined;
  const segments = root ? root.split('/').filter(Boolean) : [];
  for (const segment of include.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join('/');
}

function isCompilable(file: ProjectFile): boolean {
  return file.language === 'ino' || file.language === 'c' || file.language === 'c++' || file.language === 'asm';
}

function isLibraryIncludeFragment(path: string): boolean {
  return /\.(?:inc|ipp|tpp)$/i.test(path);
}

function compileFlags(language: ProjectFile['language'], flags: PlannerCompilerFlags): string[] {
  return [...(flags.common ?? []), ...(language === 'c' ? (flags.c ?? []) : language === 'asm' ? (flags.asm ?? []) : (flags.cxx ?? []))];
}

function normalizeArchiveOperation(value: string | undefined): string {
  const operation = value ?? 'rcs';
  if (!/^[A-Za-z]+$/.test(operation)) {
    throw new TypeError(`archive operation is invalid: ${operation}`);
  }
  return operation;
}

function normalizeFlags(flags: PlannerCompilerFlags | undefined): PlannerCompilerFlags {
  return {
    ...(flags?.common ? { common: [...flags.common] } : {}),
    ...(flags?.c ? { c: [...flags.c] } : {}),
    ...(flags?.cxx ? { cxx: [...flags.cxx] } : {}),
    ...(flags?.asm ? { asm: [...flags.asm] } : {}),
  };
}

function mergeFlags(left: PlannerCompilerFlags, right: PlannerCompilerFlags | undefined): PlannerCompilerFlags {
  return normalizeFlags({
    common: [...(left.common ?? []), ...(right?.common ?? [])],
    c: [...(left.c ?? []), ...(right?.c ?? [])],
    cxx: [...(left.cxx ?? []), ...(right?.cxx ?? [])],
    asm: [...(left.asm ?? []), ...(right?.asm ?? [])],
  });
}

function mergeRecords(...records: Record<string, string | boolean>[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const record of records) for (const [key, value] of Object.entries(record)) result[key] = value;
  return result;
}

function cloneRecord(record: Record<string, string | boolean>): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareText(a, b)));
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => normalizePath(path, 'path')))].sort(compareText);
}

function sourceDirectory(path: string): string[] {
  const index = path.lastIndexOf('/');
  return index < 1 ? [] : [path.slice(0, index)];
}

function normalizePackRoot(path: string): string {
  return normalizePath(path, 'pack root');
}

function normalizePath(value: string, label: string): string {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`${label} must be relative and must not contain '..': ${value}`);
  }
  return path.split('/').filter((part) => part && part !== '.').join('/');
}

function joinPath(left: string, right: string): string {
  return normalizePath(`${left}/${right}`, 'logical path');
}

function withoutExtension(path: string): string {
  return path.replace(/\.[^/.]+$/, '');
}

function slug(value: string): string {
  const clean = value.replaceAll('\\', '/').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+|\.+$/g, '');
  const digest = sha256Hex(value).slice(0, 8);
  return `${clean || 'source'}-${digest}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
