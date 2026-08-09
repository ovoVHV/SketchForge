#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../packages/web/public/avr/v3/toolchain-pack.js';

import {
  decodePackArtifact,
  publishCkPlatformManifests,
} from './publish-ck-platform-manifests.mjs';
import { createEsp32RecipeLoweringInput } from './ck-esp32-recipe-lowering.mjs';
import { resolvePlatformManifest } from '../packages/core/dist/platform-pack/builder.js';
import { derivePlatformRecipeCommands } from '../packages/core/dist/platform-pack/recipe-command-lowering.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REPACK_BYTES = 1024 * 1024;
const ASM_FLAGS_ARTIFACT_ID = 'compile-asm-flags';
const ASM_FLAGS_SHA256 = Object.freeze({
  xtensa: '0a15db7ce05157b7918584762445723feb47505718da311ef73fe39969f538c2',
  riscv32: 'c4751c67c68e46d6ded3dd95cbcaf01f900a018266c5ab69947cf090597e675d',
});
const C_ONLY_FLAGS = new Set([
  '-Wno-frame-address',
  '-fno-builtin-memcpy',
  '-fno-builtin-memset',
  '-fno-builtin-bzero',
  '-fno-builtin-stpcpy',
  '-fno-builtin-strncpy',
  '-std=gnu17',
  '-Wno-old-style-declaration',
  '-Wno-strict-prototypes',
]);
const DEFAULT_TARGETS = [
  'packages/web/public/esp32/v5/xtensa/esp32.json',
  'packages/web/public/esp32/v5/xtensa/esp32s2.json',
  'packages/web/public/esp32/v5/xtensa/esp32s3.json',
  'packages/web/public/esp32/v2/runtime/runtime.json',
  'packages/web/public/esp32/v2/runtime-c6/runtime.json',
];
const LEGACY_PLATFORM_MANIFEST_KEYS = [
  'architecture', 'boards', 'files', 'id', 'kind', 'platformProperties',
  'programmers', 'recipes', 'schemaVersion', 'sha256', 'tools', 'vendor', 'version',
];
const CURRENT_PLATFORM_MANIFEST_KEYS = [
  ...LEGACY_PLATFORM_MANIFEST_KEYS, 'recipeLowering',
];
const SHARED_PLATFORM_FIELDS = [
  'kind', 'id', 'version', 'vendor', 'architecture',
  'platformProperties', 'recipes', 'programmers', 'files',
];

export function migrateCkPlatformProfiles({
  root = ROOT,
  targets = DEFAULT_TARGETS,
  platformManifest,
  output,
  install = false,
  maxRepackBytes = MAX_REPACK_BYTES,
} = {}) {
  const workspace = resolve(root);
  if (output && install) throw new TypeError('migration output and in-place install are mutually exclusive');
  if (typeof install !== 'boolean') throw new TypeError('migration install must be a boolean');
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError('migration targets must not be empty');
  }
  const loaded = targets.map((name) => loadTarget(workspace, name));
  const discovered = resolveSharedManifest(workspace, loaded, platformManifest);
  const shared = discovered.manifest;
  const globalBlockers = [...discovered.blockers, ...validateSharedManifest(shared, loaded, discovered.blockers.length > 0)];
  const analyses = loaded.map((target) => analyzeTarget(target, shared, globalBlockers));
  const report = {
    kind: 'ck-profile-migration-report', schemaVersion: 1, dryRun: !output && !install,
    migratable: analyses.every((entry) => entry.blockers.length === 0),
    counts: {
      targets: analyses.length,
      migratable: analyses.filter((entry) => !entry.blockers.length).length,
      blocked: analyses.filter((entry) => entry.blockers.length).length,
    },
    targets: analyses.map(({ generated: _generated, source: _source, ...entry }) => entry),
  };
  if (output) {
    if (!report.migratable) throw migrationError(report);
    const outputPath = resolve(workspace, output);
    assertInside(workspace, outputPath, 'migration output');
    report.output = emitMigration(outputPath, analyses, maxRepackBytes);
    report.dryRun = false;
  }
  if (install) {
    if (!report.migratable) throw migrationError(report);
    report.installation = installMigration(workspace, analyses, maxRepackBytes);
    if (isDefaultProductionInstall(workspace, analyses)) {
      const published = publishCkPlatformManifests();
      report.installation.publication = {
        registry: slash(relative(workspace, published.registry)),
        registrySha256: published.registrySha256,
        entries: published.entries.length,
        descriptorPins: published.descriptorPins,
      };
    }
    report.dryRun = false;
  }
  return report;
}

function isDefaultProductionInstall(workspace, analyses) {
  if (resolve(workspace) !== ROOT || analyses.length !== DEFAULT_TARGETS.length) return false;
  const expected = DEFAULT_TARGETS.map((path) => slash(path)).sort(compareUtf16);
  const actual = analyses.map((entry) => entry.source.descriptorName).sort(compareUtf16);
  return sameArray(actual, expected);
}

function loadTarget(root, descriptorName) {
  const descriptorPath = resolve(root, descriptorName);
  assertInside(root, descriptorPath, 'runtime descriptor');
  const descriptor = readJson(descriptorPath);
  if (descriptor?.schema !== 2 || typeof descriptor.board !== 'string' || !Array.isArray(descriptor.packs)) {
    throw new Error(`${descriptorName}: invalid runtime descriptor`);
  }
  const packs = {};
  for (const role of ['compiler', 'sdk', 'board']) {
    const matches = descriptor.packs.filter((pin) => pin?.role === role);
    if (matches.length !== 1) throw new Error(`${descriptorName}: expected one ${role} Pack`);
    const pin = matches[0];
    const manifestPath = resolve(dirname(descriptorPath), ...String(pin.manifest).split('/'));
    assertInside(root, manifestPath, `${role} Pack manifest`);
    const manifest = readJson(manifestPath);
    validatePack(manifest, pin, role);
    packs[role] = { pin, manifest, manifestPath };
  }
  const legacySdkProfile = packs.sdk.manifest.artifacts.some((artifact) => artifact?.id === 'profile');
  const sdkProfile = decodeProfile(
    packs.sdk,
    legacySdkProfile ? 'profile' : 'profile-v5',
    legacySdkProfile ? 4 : 5,
  );
  const legacyBoardProfile = packs.board.manifest.artifacts.some((artifact) => artifact?.id === 'profile');
  const boardProfile = decodeProfile(
    packs.board,
    legacyBoardProfile ? 'profile' : 'profile-v4',
    legacyBoardProfile ? 3 : 4,
  );
  if (boardProfile.board !== descriptor.board || sdkProfile.sdkVersion !== boardProfile.sdkVersion) {
    throw new Error(`${descriptorName}: legacy profiles disagree with descriptor`);
  }
  const current = decodeCurrentMigration(packs, descriptor);
  return {
    descriptorName: slash(relative(root, descriptorPath)),
    descriptor,
    descriptorPath,
    packs,
    sdkProfile,
    boardProfile,
    legacySdkProfile,
    legacyBoardProfile,
    current,
  };
}

function resolveSharedManifest(root, targets, suppliedName) {
  const currentTargets = targets.filter((target) => target.current);
  if (currentTargets.length > 0) {
    const shared = upgradePlatformManifest(currentTargets[0].current.platformManifest);
    const blockers = validateSharedManifest(shared, targets);
    for (const target of currentTargets.slice(1)) {
      if (canonicalJson(upgradePlatformManifest(target.current.platformManifest)) !== canonicalJson(shared)) {
        blockers.push({
          field: 'platformRef',
          reason: `${target.descriptor.board} current Platform Manifest conflicts with the shared value`,
        });
      }
    }
    for (const target of targets.filter((candidate) => !candidate.current)) {
      try {
        validateLegacyTargetAgainstShared(root, target, shared);
      } catch (error) {
        blockers.push({
          field: typeof error?.field === 'string' ? error.field : 'platformRef',
          reason: String(error?.message ?? error),
        });
      }
    }
    if (suppliedName) {
      const suppliedPath = resolve(root, suppliedName);
      assertInside(root, suppliedPath, 'shared Platform Manifest');
      if (canonicalJson(upgradePlatformManifest(readJson(suppliedPath))) !== canonicalJson(shared)) {
        blockers.push({
          field: 'platformRef',
          reason: 'supplied shared Platform Manifest differs from the installed current Manifest',
        });
      }
    }
    return { manifest: shared, blockers };
  }

  let merged;
  try {
    let registry;
    const inputs = targets.map((target) => {
      let manifest = target.sdkProfile.platformManifest;
      if (Array.isArray(manifest?.tools) && manifest.tools.length === 0) {
        registry ??= loadLegacyPlatformRegistry(root);
        manifest = loadBoundLegacyManifest(root, registry, target, manifest);
      }
      return {
        fqbn: target.descriptor.board,
        sdkVersion: target.sdkProfile.sdkVersion,
        manifest,
        compilerPack: {
          id: target.packs.compiler.pin.id,
          version: target.packs.compiler.manifest.version,
          sha256: target.packs.compiler.pin.revision,
        },
      };
    });
    merged = mergeLegacyPlatformManifests(inputs);
  } catch (error) {
    return { blockers: [{
      field: typeof error?.field === 'string' ? error.field : 'platformRef',
      reason: String(error?.message ?? error),
    }] };
  }
  const upgraded = upgradePlatformManifest(merged);
  if (!suppliedName) return { manifest: upgraded, blockers: [] };

  const suppliedPath = resolve(root, suppliedName);
  assertInside(root, suppliedPath, 'shared Platform Manifest');
  const supplied = upgradePlatformManifest(readJson(suppliedPath));
  const blockers = validateSharedManifest(supplied, targets);
  if (blockers.length) return { blockers };
  for (const field of [...SHARED_PLATFORM_FIELDS, 'boards', 'tools', 'recipeLowering', 'sha256']) {
    if (canonicalJson(supplied[field]) !== canonicalJson(upgraded[field])) {
      return { blockers: [{
        field: `platformManifest.${field}`,
        reason: `supplied shared Platform Manifest ${field} differs from the strictly merged legacy inputs`,
      }] };
    }
  }
  return { manifest: supplied, blockers: [] };
}

function validateLegacyTargetAgainstShared(root, target, shared) {
  let manifest = target.sdkProfile.platformManifest;
  if (Array.isArray(manifest?.tools) && manifest.tools.length === 0) {
    manifest = loadBoundLegacyManifest(root, loadLegacyPlatformRegistry(root), target, manifest);
  }
  validateLegacyManifest(manifest, target.descriptor.board);
  validateCompilerToolBinding(manifest.tools, {
    id: target.packs.compiler.pin.id,
    version: target.packs.compiler.manifest.version,
    sha256: target.packs.compiler.pin.revision,
  }, target.descriptor.board);
  for (const field of SHARED_PLATFORM_FIELDS) {
    if (canonicalJson(manifest[field]) !== canonicalJson(shared[field])) {
      throw mergeFailure(
        `platformManifest.${field}`,
        `${target.descriptor.board} legacy Manifest ${field} conflicts with the installed shared value`,
      );
    }
  }
  const sharedBoard = shared.boards?.find((board) => board?.fqbn === target.descriptor.board);
  if (!sharedBoard || canonicalJson(manifest.boards[0]) !== canonicalJson(sharedBoard)) {
    throw mergeFailure(
      'platformManifest.boards',
      `${target.descriptor.board} legacy board conflicts with the installed shared value`,
    );
  }
}

function loadLegacyPlatformRegistry(root) {
  const registryPath = join(root, 'packages', 'web', 'public', 'esp32', 'v1', 'platform-manifests', 'registry.json');
  if (!existsSync(registryPath)) {
    throw mergeFailure(
      'platformManifest.tools',
      'target-bound tool removal cannot be proved because the legacy Platform Manifest registry is missing',
    );
  }
  const registry = readJson(registryPath);
  if (!isRecord(registry) || registry.kind !== 'ck-platform-manifest-registry'
    || registry.schemaVersion !== 1 || !Array.isArray(registry.entries)) {
    throw mergeFailure('platformManifest.tools', 'legacy Platform Manifest registry is invalid');
  }
  return { path: registryPath, entries: registry.entries };
}

function loadBoundLegacyManifest(root, registry, target, unboundManifest) {
  const fqbn = target.descriptor.board;
  validateLegacyManifest(unboundManifest, fqbn);
  const matches = registry.entries.filter((entry) => entry?.fqbn === fqbn);
  if (matches.length !== 1) {
    throw mergeFailure(
      'platformManifest.tools',
      `${fqbn} does not have exactly one tool-bound legacy Manifest registry entry`,
    );
  }
  const entry = matches[0];
  if (!isRecord(entry) || !sameKeys(entry, ['fqbn', 'id', 'path', 'sdkPack', 'sha256', 'version'])
    || !nonEmptyString(entry.path) || !SHA256.test(entry.sha256)
    || !isRecord(entry.sdkPack) || !sameKeys(entry.sdkPack, ['id', 'revision'])
    || entry.sdkPack.id !== target.packs.sdk.pin.id
    || entry.sdkPack.revision !== target.packs.sdk.pin.revision) {
    throw mergeFailure(
      'platformManifest.tools',
      `${fqbn} legacy Manifest registry entry does not bind the target SDK Pack`,
    );
  }
  const manifestPath = resolve(dirname(registry.path), ...entry.path.split('/'));
  assertInside(root, manifestPath, `${fqbn} legacy Platform Manifest`);
  if (basename(dirname(manifestPath)) !== entry.sha256 || !existsSync(manifestPath)) {
    throw mergeFailure(
      'platformManifest.tools',
      `${fqbn} tool-bound legacy Manifest immutable address is invalid`,
    );
  }
  const boundManifest = readJson(manifestPath);
  validateLegacyManifest(boundManifest, fqbn);
  if (entry.id !== boundManifest.id || entry.version !== boundManifest.version
    || entry.sha256 !== boundManifest.sha256) {
    throw mergeFailure(
      'platformManifest.tools',
      `${fqbn} tool-bound legacy Manifest does not match its registry identity`,
    );
  }
  const { sha256: _boundSha256, ...boundBody } = boundManifest;
  const unboundBody = canonicalClone({ ...boundBody, tools: [] });
  const reconstructedUnbound = {
    ...unboundBody,
    sha256: sha256(Buffer.from(canonicalJson(unboundBody))),
  };
  if (canonicalJson(reconstructedUnbound) !== canonicalJson(unboundManifest)) {
    throw mergeFailure(
      'platformManifest.tools',
      `${fqbn} tool-bound and no-tools legacy Manifests differ outside the explicit tool binding`,
    );
  }
  return boundManifest;
}

function validateSharedManifest(manifest, targets, absenceAlreadyReported = false) {
  if (!manifest) return absenceAlreadyReported ? [] : [{ field: 'platformRef', reason: 'no shared Platform Manifest was supplied' }];
  const blockers = [];
  if (!isRecord(manifest) || !sameKeys(manifest, CURRENT_PLATFORM_MANIFEST_KEYS)
    || manifest.kind !== 'ck-platform-pack' || manifest.schemaVersion !== 2
    || !SHA256.test(manifest.sha256)) {
    blockers.push({ field: 'platformRef', reason: 'shared Platform Manifest identity is invalid' });
    return blockers;
  }
  const { sha256: expected, ...body } = manifest;
  if (sha256(Buffer.from(canonicalJson(body))) !== expected) blockers.push({ field: 'platformRef.sha256', reason: 'shared Platform Manifest hash does not verify' });
  const loweringValid = validateRecipeLowering(manifest.recipeLowering);
  if (!loweringValid) {
    blockers.push({ field: 'recipeLowering', reason: 'shared Platform Manifest recipe lowering contract is invalid' });
  } else if (!hasBoundRecipes(manifest.recipes, manifest.recipeLowering)) {
    blockers.push({ field: 'recipeLowering.bindings', reason: 'shared Platform Manifest recipe bindings are missing or duplicated' });
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length !== 0) blockers.push({ field: 'platformManifest.tools', reason: 'shared source Manifest must have no target-bound tools' });
  if (!Array.isArray(manifest.boards)) {
    blockers.push({ field: 'platformManifest.boards', reason: 'shared Platform Manifest has no board list' });
  } else {
    const expectedBoards = targets.map((target) => target.descriptor.board).sort(compareUtf16);
    const actualBoards = manifest.boards.map((board) => board?.fqbn);
    if (new Set(expectedBoards).size !== expectedBoards.length) {
      blockers.push({ field: 'platformManifest.boards', reason: 'migration target FQBNs are duplicated' });
    } else if (!sameArray(actualBoards, expectedBoards)) {
      blockers.push({
        field: 'platformManifest.boards',
        reason: `shared Manifest boards must exactly cover the sorted target set [${expectedBoards.join(',')}]`,
      });
    }
  }
  return blockers;
}

/**
 * Merge target-scoped legacy Manifests only when every shared byte is proved
 * identical and every removed tool is bound to the target's Compiler Pack.
 */
export function mergeLegacyPlatformManifests(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw mergeFailure('platformManifest.boards', 'legacy Platform Manifest inputs must not be empty');
  }
  const seenFqbns = new Set();
  const boards = [];
  let reference;
  for (const input of inputs) {
    const fqbn = typeof input?.fqbn === 'string' ? input.fqbn : '';
    if (!fqbn) throw mergeFailure('platformManifest.boards', 'legacy Platform Manifest input FQBN is invalid');
    if (seenFqbns.has(fqbn)) {
      throw mergeFailure('platformManifest.boards', `legacy Platform Manifest target is duplicated: ${fqbn}`);
    }
    seenFqbns.add(fqbn);
    const manifest = input.manifest;
    validateLegacyManifest(manifest, fqbn);
    if (manifest.version !== input.sdkVersion) {
      throw mergeFailure('platformManifest.version', `${fqbn} legacy Manifest version does not match its SDK profile`);
    }
    validateCompilerToolBinding(manifest.tools, input.compilerPack, fqbn);
    if (reference) {
      for (const field of SHARED_PLATFORM_FIELDS) {
        if (canonicalJson(manifest[field]) !== canonicalJson(reference[field])) {
          throw mergeFailure(`platformManifest.${field}`, `${fqbn} legacy Manifest ${field} conflicts with the shared value`);
        }
      }
    } else {
      reference = manifest;
    }
    boards.push(manifest.boards[0]);
  }

  boards.sort((left, right) => compareUtf16(left.fqbn, right.fqbn));
  const withoutHash = canonicalClone({
    kind: reference.kind,
    schemaVersion: 2,
    id: reference.id,
    version: reference.version,
    vendor: reference.vendor,
    architecture: reference.architecture,
    platformProperties: reference.platformProperties,
    recipes: reference.recipes,
    boards,
    programmers: reference.programmers,
    tools: [],
    files: reference.files,
    recipeLowering: createRecipeLoweringContract(),
  });
  return { ...withoutHash, sha256: sha256(Buffer.from(canonicalJson(withoutHash))) };
}

function validateLegacyManifest(manifest, fqbn) {
  if (!isRecord(manifest) || !sameKeys(manifest, LEGACY_PLATFORM_MANIFEST_KEYS)) {
    throw mergeFailure('platformManifest', `${fqbn} legacy Manifest fields are invalid or unsupported`);
  }
  if (manifest.kind !== 'ck-platform-pack' || manifest.schemaVersion !== 1
    || !nonEmptyString(manifest.id) || !nonEmptyString(manifest.version)
    || !nonEmptyString(manifest.vendor) || !nonEmptyString(manifest.architecture)
    || !isRecord(manifest.platformProperties) || !Array.isArray(manifest.recipes)
    || !Array.isArray(manifest.programmers) || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.tools) || !Array.isArray(manifest.boards)
    || !SHA256.test(manifest.sha256)) {
    throw mergeFailure('platformManifest', `${fqbn} legacy Manifest structure is invalid`);
  }
  const { sha256: expected, ...body } = manifest;
  if (sha256(Buffer.from(canonicalJson(body))) !== expected) {
    throw mergeFailure('platformManifest.sha256', `${fqbn} legacy Manifest hash does not verify`);
  }
  if (manifest.boards.length !== 1 || !isRecord(manifest.boards[0])
    || manifest.boards[0].fqbn !== fqbn) {
    throw mergeFailure(
      'platformManifest.boards',
      `${fqbn} legacy Manifest must contain exactly its one target board`,
    );
  }
}

function validateCompilerToolBinding(tools, compilerPack, fqbn) {
  if (!Array.isArray(tools) || tools.length !== 1) {
    throw mergeFailure(
      'platformManifest.tools',
      `${fqbn} target-bound tool removal cannot be proved from exactly one legacy requirement`,
    );
  }
  if (!isRecord(compilerPack) || !sameKeys(compilerPack, ['id', 'sha256', 'version'])
    || !nonEmptyString(compilerPack.id) || !nonEmptyString(compilerPack.version)
    || !SHA256.test(compilerPack.sha256)) {
    throw mergeFailure('sdkVariant.compilerPack', `${fqbn} Compiler Pack binding is invalid`);
  }
  const tool = tools[0];
  if (!isRecord(tool) || !sameKeys(tool, ['id', 'sha256', 'version'])
    || tool.id !== compilerPack.id || tool.version !== compilerPack.version
    || tool.sha256 !== compilerPack.sha256) {
    throw mergeFailure(
      'sdkVariant.compilerPack',
      `${fqbn} legacy tool requirement does not exactly match the Compiler Pack binding`,
    );
  }
}

function analyzeTarget(target, shared, globalBlockers) {
  if (target.current && !target.legacySdkProfile && !target.legacyBoardProfile) {
    return analyzeCurrentTarget(target, globalBlockers);
  }
  const blockers = globalBlockers.map((value) => ({ ...value }));
  const evidence = [];
  const prove = (_field, _source, value) => value;
  const record = (condition, field, source) => { if (condition) evidence.push({ field, source }); };
  const legacyManifest = target.sdkProfile.platformManifest;
  if (shared) {
    if (shared.id !== legacyManifest?.id || shared.version !== target.sdkProfile.sdkVersion) blockers.push({ field: 'platformRef', reason: 'shared Manifest identity/version differs from legacy profile' });
    const board = shared.boards?.find((entry) => entry.fqbn === target.descriptor.board);
    if (board?.variant !== target.boardProfile.variant) blockers.push({ field: 'platformRef.fqbn', reason: 'shared Manifest board variant differs from legacy Board profile' });
  }
  const compiler = target.packs.compiler.manifest;
  if (typeof compiler.version !== 'string' || !compiler.version) blockers.push({ field: 'sdkVariant.compilerPack.version', reason: 'Compiler Pack manifest has no version' });
  const memoryCompile = oneMatch(target.boardProfile.overlay?.compile?.memory, /^-Isdk\/([^/]+)\/include$/);
  const memoryLink = oneMatch(target.boardProfile.overlay?.link?.memory, /^-Lsdk\/([^/]+)$/);
  if (!memoryCompile || memoryCompile !== memoryLink) blockers.push({ field: 'sdkVariant.memoryType', reason: 'legacy compile/link memory overlays do not prove one value' });
  const targetFlags = target.boardProfile.overlay?.compile?.target;
  if (!sameArray(targetFlags, target.boardProfile.overlay?.link?.target)) blockers.push({ field: 'execution.targetArguments', reason: 'legacy compile/link target overlays differ' });
  const compileTriple = oneMatch(target.sdkProfile.compile?.args, /^--target=(.+)$/);
  const linkTriple = oneMatch(target.sdkProfile.link?.args, /^--target=(.+)$/);
  if (!compileTriple || compileTriple !== linkTriple) blockers.push({ field: 'execution.targetTriple', reason: 'legacy compile/link commands do not prove one target triple' });
  const machine = compileTriple?.startsWith('xtensa-') ? 94 : compileTriple?.startsWith('riscv32-') ? 243 : undefined;
  if (!machine) blockers.push({ field: 'execution.elf.machine', reason: 'target triple has no supported ELF machine mapping' });
  const mabi = targetFlags?.find((flag) => flag.startsWith('-mabi='))?.slice(6) ?? '';
  const flashOffsets = deriveFlashOffsets(legacyManifest, target.descriptor.board);
  if (!flashOffsets) blockers.push({ field: 'flash.offsets', reason: 'legacy Platform Manifest does not prove all three upload offsets' });
  const sdkTarget = legacyManifest?.boards?.find((entry) => entry.fqbn === target.descriptor.board)?.properties?.['build.mcu'];
  if (typeof sdkTarget !== 'string' || !sdkTarget) blockers.push({ field: 'sdkVariant.sdkTarget', reason: 'legacy Platform Manifest board build.mcu is absent' });
  let migratedCompile;
  let asmFlagsBytes;
  try {
    asmFlagsBytes = deriveAsmFlagsArtifact(target, compileTriple);
    migratedCompile = shared === undefined
      ? undefined
      : migrateCompileLanguageFlags(
          target.sdkProfile.compile,
          shared.recipeLowering,
          ASM_FLAGS_ARTIFACT_ID,
          deriveMigrationRecipeCommands(shared, target),
        );
  } catch (error) {
    blockers.push({
      field: 'compile.languageFlags',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  record(Boolean(shared) && !globalBlockers.length, 'platformRef', 'verified shared Platform Manifest identity and board membership');
  record(typeof compiler.version === 'string' && Boolean(compiler.version), 'sdkVariant.compilerPack', 'runtime descriptor pin and Compiler Pack manifest version');
  record(Boolean(memoryCompile) && memoryCompile === memoryLink, 'sdkVariant.memoryType', 'matching legacy Board compile/link memory overlays');
  record(typeof sdkTarget === 'string' && Boolean(sdkTarget), 'sdkVariant.sdkTarget', 'legacy Platform Manifest board build.mcu');
  record(Boolean(compileTriple) && compileTriple === linkTriple, 'execution.targetTriple', 'matching legacy Platform compile/link --target arguments');
  record(sameArray(targetFlags, target.boardProfile.overlay?.link?.target), 'execution.targetArguments', 'matching legacy Board target overlays');
  record(Boolean(machine), 'execution.elf.machine', 'ELF ABI mapping for the proved target triple');
  record(Boolean(machine), 'execution.elf.floatAbi', 'legacy -mabi target overlay');
  record(Boolean(flashOffsets), 'flash.offsets', 'legacy Platform upload recipe and bootloader property');
  record(Boolean(migratedCompile), 'compile.languageFlags', 'shared Manifest recipes resolved through the CK recipe command lowerer');
  evidence.push(
    { field: 'recipeOrigins', source: 'legacy Platform Manifest recipe key contract' },
    { field: 'recipeLowering', source: 'shared Manifest recipe lowering contract hash' },
    { field: 'migration', source: 'validated legacy profile schema and artifact ID' },
  );

  let generated;
  if (!blockers.length) {
    const platformRef = prove('platformRef', 'shared Platform Manifest identity', { id: shared.id, version: shared.version, sha256: shared.sha256 });
    const platformBytes = Buffer.from(canonicalJson(shared));
    const { platformManifest: _legacyPlatformManifest, ...legacyPlatformProfile } = target.sdkProfile;
    const platformProfile = {
      ...legacyPlatformProfile, schema: 5,
      compile: migratedCompile,
      platformRef,
      platformManifestArtifact: { id: 'platform-manifest', sha256: sha256(platformBytes) },
      sdkVariant: {
        id: prove('sdkVariant.id', 'runtime descriptor SDK Pack pin', target.packs.sdk.pin.id),
        sdkTarget: prove('sdkVariant.sdkTarget', 'legacy Platform Manifest board build.mcu', sdkTarget),
        memoryType: prove('sdkVariant.memoryType', 'matching legacy Board compile/link memory overlays', memoryCompile),
        compilerPack: {
          id: prove('sdkVariant.compilerPack.id', 'runtime descriptor Compiler Pack pin', target.packs.compiler.pin.id),
          version: prove('sdkVariant.compilerPack.version', 'Compiler Pack manifest version', compiler.version),
          sha256: prove('sdkVariant.compilerPack.sha256', 'runtime descriptor Compiler Pack revision', target.packs.compiler.pin.revision),
        },
      },
      recipeOrigins: prove('recipeOrigins', 'Manifest recipe lowering bindings', {
        compile: shared.recipeLowering.bindings.compile.cxx,
        link: shared.recipeLowering.bindings.link,
      }),
      recipeLowering: prove('recipeLowering', 'shared Manifest recipe lowering contract', {
        status: 'manifest-defined',
        schemaVersion: shared.recipeLowering.schemaVersion,
        sha256: shared.recipeLowering.sha256,
      }),
      migration: { legacySchema: 4, legacyArtifact: 'profile' },
    };
    const boardProfile = {
      ...target.boardProfile, schema: 4,
      platformRef: { ...platformRef, fqbn: target.descriptor.board },
      execution: {
        targetTriple: prove('execution.targetTriple', 'matching legacy Platform compile/link --target arguments', compileTriple),
        targetArguments: prove('execution.targetArguments', 'legacy target triple plus matching Board target overlays', [`--target=${compileTriple}`, ...targetFlags]),
        elf: { machine: prove('execution.elf.machine', 'ELF ABI mapping for proved target triple', machine), floatAbi: prove('execution.elf.floatAbi', 'legacy -mabi target overlay', mabi.endsWith('d') ? 4 : mabi.endsWith('f') ? 2 : 0) },
      },
      flash: { ...target.boardProfile.flash, offsets: prove('flash.offsets', 'legacy Platform upload recipe/property addresses', flashOffsets) },
      migration: { legacySchema: 3, legacyArtifact: 'profile' },
    };
    generated = { platformProfile, boardProfile, platformBytes, asmFlagsBytes };
  }
  return {
    descriptor: target.descriptorName, board: target.descriptor.board,
    status: blockers.length ? 'blocked' : 'migratable', blockers, evidence,
    generated, source: target,
  };
}

function analyzeCurrentTarget(target, globalBlockers) {
  const blockers = globalBlockers.map((value) => ({ ...value }));
  let asmFlagsBytes;
  try {
    asmFlagsBytes = decodePackArtifact(
      target.packs.sdk.manifest,
      ASM_FLAGS_ARTIFACT_ID,
      target.packs.sdk.manifestPath,
    );
  } catch (error) {
    blockers.push({
      field: 'compile.languageFlags',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const evidence = blockers.length ? [] : [
    { field: 'platformRef', source: 'validated current Platform and Board profile bindings' },
    { field: 'recipeLowering', source: 'validated current Platform Manifest lowering contract' },
    { field: 'migration', source: 'active Packs already satisfy the current-only profile contract' },
  ];
  return {
    descriptor: target.descriptorName,
    board: target.descriptor.board,
    status: blockers.length ? 'blocked' : 'migratable',
    blockers,
    evidence,
    generated: blockers.length ? undefined : {
      platformProfile: target.current.platformProfile,
      boardProfile: target.current.boardProfile,
      platformBytes: target.current.platformBytes,
      asmFlagsBytes,
    },
    source: target,
  };
}

function deriveMigrationRecipeCommands(shared, target) {
  const command = target.sdkProfile.compile;
  const link = target.sdkProfile.link;
  if (!isRecord(command) || !nonEmptyString(command.source) || !nonEmptyString(command.object)
    || !isRecord(link) || !nonEmptyString(link.object)) {
    throw new Error('legacy Platform command placeholders are invalid');
  }
  const resolved = resolvePlatformManifest({
    manifest: shared,
    fqbn: target.descriptor.board,
    options: isRecord(target.boardProfile.options) ? target.boardProfile.options : {},
  });
  if (resolved.recipeLowering?.sha256 !== shared.recipeLowering.sha256) {
    throw new Error('resolved Platform recipe lowering contract does not match the shared Manifest');
  }
  return derivePlatformRecipeCommands({
    recipes: shared.recipes,
    recipeLowering: shared.recipeLowering,
    properties: {
      ...resolved.properties,
      'runtime.ide.version': '10607',
      'runtime.os': 'wasm',
      'build.fqbn': resolved.board.fqbn,
      'build.arch': shared.architecture.toUpperCase(),
      'build.path': '.',
      'build.project_name': 'firmware',
      'build.source.path': 'core',
      'compiler.path': '',
      'compiler.prefix': '',
      'compiler.sdk.path': 'sdk',
      source_file: command.source,
      object_file: command.object,
      object_files: link.object,
      archive_file_path: 'core.a',
      includes: '',
      'file_opts.path': '',
      'build.opt.path': '',
    },
  }).compile;
}

function migrateCompileLanguageFlags(command, lowering, asmArtifactId, derivedCompile) {
  if (!isRecord(command) || !Array.isArray(command.args) || !isRecord(lowering?.responseFiles)
    || !Array.isArray(command.artifactIds) || lowering.responseFiles.marker !== '@'
    || !isRecord(lowering.responseFiles.languageFiles) || !isRecord(derivedCompile)
    || !isRecord(derivedCompile.languageFlags) || !nonEmptyString(asmArtifactId)
    || command.artifactIds.includes(asmArtifactId)) {
    throw new Error('legacy Platform compile command or language response contract is invalid');
  }
  const names = lowering.responseFiles.languageFiles;
  if (![names.c, names.cxx, names.asm].every(nonEmptyString)) {
    throw new Error('Manifest language response filenames are invalid');
  }
  const cxxMatches = command.args.filter((argument) => (
    typeof argument === 'string'
    && argument.startsWith(lowering.responseFiles.marker)
    && (argument.slice(1) === names.cxx || argument.endsWith(`/${names.cxx}`))
  ));
  if (cxxMatches.length !== 1) {
    throw new Error('legacy Platform compile command does not prove one C++ response path');
  }
  const cxxArgument = cxxMatches[0];
  const cxxPath = cxxArgument.slice(lowering.responseFiles.marker.length);
  const root = cxxPath.slice(0, cxxPath.length - names.cxx.length);
  const languageFlags = Object.fromEntries(['c', 'cxx', 'asm'].map((language) => {
    const flags = derivedCompile.languageFlags[language];
    if (!Array.isArray(flags) || !flags.length || flags.some((flag) => !nonEmptyString(flag))) {
      throw new Error(`resolved Platform ${language} language flags are invalid`);
    }
    const expectedName = names[language];
    let responseCount = 0;
    const rebased = flags.map((flag) => {
      if (!flag.startsWith(lowering.responseFiles.marker)) return flag;
      const path = flag.slice(lowering.responseFiles.marker.length);
      if (path !== expectedName && !path.endsWith(`/${expectedName}`)) return flag;
      responseCount += 1;
      return `${lowering.responseFiles.marker}${root}${expectedName}`;
    });
    if (responseCount !== 1) {
      throw new Error(`resolved Platform ${language} flags do not prove one ${expectedName} response path`);
    }
    return [language, rebased];
  }));
  const structuralCompile = command.args
    .map((argument, index) => argument === '-c' ? index : -1)
    .filter((index) => index >= 0);
  const cxxIndex = command.args.indexOf(cxxArgument);
  if (structuralCompile.length !== 1 || structuralCompile[0] >= cxxIndex) {
    throw new Error('legacy Platform compile command has an invalid structural -c');
  }
  const compileIndex = structuralCompile[0];
  const languageStart = command.args.lastIndexOf('-MMD', compileIndex);
  if (languageStart < 0 || languageStart >= compileIndex) {
    throw new Error('legacy Platform compile command does not prove its C++ language flag prefix');
  }
  let languageEnd = cxxIndex + 1;
  while (languageEnd < command.args.length
    && isLegacyProfileLanguageTail(command.args[languageEnd])) languageEnd += 1;
  if (languageEnd === cxxIndex + 1) {
    throw new Error('legacy Platform compile command does not prove its C++ language flag tail');
  }
  return {
    ...command,
    args: [
      ...command.args.slice(0, languageStart),
      '-c',
      ...command.args.slice(languageEnd),
    ],
    artifactIds: [...command.artifactIds, asmArtifactId],
    languageFlags,
  };
}

function isLegacyProfileLanguageTail(argument) {
  return argument === '-w'
    || argument === '-Wall'
    || argument === '-Wextra'
    || argument === '-Os'
    || argument === '-Og'
    || argument === '-g3'
    || argument === '-Werror=return-type';
}

function deriveAsmFlagsArtifact(target, targetTriple) {
  const family = typeof targetTriple === 'string' ? targetTriple.split('-')[0] : '';
  const expected = ASM_FLAGS_SHA256[family];
  if (!expected) throw new Error('target triple does not identify a supported ASM flags family');
  const ids = target.sdkProfile.compile?.artifactIds;
  if (!Array.isArray(ids) || !ids.length) throw new Error('legacy Platform compile artifact list is invalid');
  const matches = [];
  for (const id of ids) {
    const artifact = target.packs.sdk.manifest.artifacts.find((candidate) => candidate?.id === id);
    if (!artifact || !Array.isArray(artifact.files)) continue;
    for (const file of artifact.files.filter((candidate) => candidate?.path === 'sdk/flags/c_flags')) {
      matches.push({ artifact, file });
    }
  }
  if (matches.length !== 1) {
    throw new Error('SDK compile artifacts do not prove one transformed C flags file');
  }
  const { artifact, file } = matches[0];
  if (!Number.isSafeInteger(file.offset) || file.offset < 0
    || !Number.isSafeInteger(file.length) || file.length <= 0 || !SHA256.test(file.sha256 ?? '')) {
    throw new Error('SDK transformed C flags file metadata is invalid');
  }
  const artifactBytes = decodePackArtifact(
    target.packs.sdk.manifest,
    artifact.id,
    target.packs.sdk.manifestPath,
  );
  const cFlags = artifactBytes.subarray(file.offset, file.offset + file.length);
  if (cFlags.length !== file.length || sha256(cFlags) !== file.sha256) {
    throw new Error('SDK transformed C flags file identity is invalid');
  }
  const tokens = cFlags.toString('utf8').trim().split(/\s+/).filter(Boolean);
  const asmFlags = `${tokens.filter((flag) => !C_ONLY_FLAGS.has(flag) && !flag.startsWith('-march='))
    .join(' ')}\n`;
  const body = Buffer.from(asmFlags, 'utf8');
  if (sha256(body) !== expected) {
    throw new Error('derived ASM flags do not match the pinned ESP32 3.3.7 compatibility identity');
  }
  return body;
}

function deriveFlashOffsets(manifest, fqbn) {
  const board = manifest?.boards?.find((entry) => entry.fqbn === fqbn);
  const bootloader = board?.properties?.['build.bootloader_addr'] ?? manifest?.platformProperties?.['build.bootloader_addr'];
  const recipe = manifest?.platformProperties?.['tools.esptool_py.upload.pattern_args'];
  if (!/^0x[0-9a-f]+$/i.test(bootloader ?? '') || typeof recipe !== 'string') return undefined;
  const partitions = recipe.match(/(0x[0-9a-f]+)\s+[^\s]*partitions\.bin/i)?.[1];
  const bootApp0 = recipe.match(/(0x[0-9a-f]+)\s+[^\s]*boot_app0\.bin/i)?.[1];
  return partitions && bootApp0 ? { bootloader, partitions, bootApp0 } : undefined;
}

function emitMigration(output, analyses, maxBytes) {
  if (existsSync(output)) throw new Error(`output directory already exists: ${output}`);
  preflightRepackBytes(analyses, maxBytes);
  mkdirSync(output, { recursive: true });
  const descriptors = [];
  for (const entry of analyses) {
    const target = entry.source;
    const pins = [];
    for (const role of ['compiler', 'sdk', 'board']) {
      const pack = target.packs[role];
      if (role === 'compiler') {
        pins.push({
          ...pack.pin,
          manifest: slash(relative(output, pack.manifestPath)),
        });
        continue;
      }
      const repacked = repackProfileRole(entry, role, maxBytes);
      const dir = join(output, 'packs', repacked.manifest.id, repacked.manifest.revision);
      const written = writeImmutablePack(dir, repacked);
      pins.push({
        role,
        id: repacked.manifest.id,
        revision: repacked.manifest.revision,
        manifest: slash(relative(output, written.manifestPath)),
      });
    }
    const descriptor = { ...target.descriptor, packs: pins };
    const name = `${target.descriptor.board.replaceAll(':', '-')}.json`;
    writeFileSync(join(output, name), `${JSON.stringify(descriptor, null, 2)}\n`);
    descriptors.push(name);
  }
  return { directory: output, descriptors };
}

function installMigration(workspace, analyses, maxBytes) {
  preflightRepackBytes(analyses, maxBytes);
  const descriptorUpdates = [];
  const packs = [];
  for (const entry of analyses) {
    const target = entry.source;
    const replacements = new Map();
    for (const role of ['sdk', 'board']) {
      const source = target.packs[role];
      const repacked = repackProfileRole(entry, role, maxBytes);
      const idRoot = profilePackIdRoot(source);
      const dir = join(idRoot, repacked.manifest.revision);
      assertInside(workspace, dir, `${entry.board} ${role} Pack install`);
      const written = writeImmutablePack(dir, repacked);
      replacements.set(role, {
        role,
        id: repacked.manifest.id,
        revision: repacked.manifest.revision,
        manifest: slash(relative(dirname(target.descriptorPath), written.manifestPath)),
      });
      packs.push({
        board: entry.board,
        role,
        id: repacked.manifest.id,
        revision: repacked.manifest.revision,
        path: slash(relative(workspace, written.manifestPath)),
        reused: written.reused,
      });
    }
    const descriptor = {
      ...target.descriptor,
      packs: target.descriptor.packs.map((pin) => replacements.get(pin.role) ?? pin),
    };
    descriptorUpdates.push({ target, descriptor });
  }

  // Every referenced immutable Pack exists and has been verified before any
  // production descriptor is switched to its new revisions.
  for (const { target, descriptor } of descriptorUpdates) {
    if (canonicalJson(readJson(target.descriptorPath)) !== canonicalJson(target.descriptor)) {
      throw new Error(`${target.descriptorName}: runtime descriptor changed during migration`);
    }
    writeFileSync(target.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  }
  return {
    descriptors: descriptorUpdates.map(({ target }) => target.descriptorName),
    packs,
  };
}

function profilePackIdRoot(pack) {
  const currentDir = dirname(pack.manifestPath);
  const idRoot = basename(currentDir) === pack.pin.revision ? dirname(currentDir) : currentDir;
  if (basename(idRoot) !== pack.pin.id) {
    throw new Error(`${pack.pin.role} Pack manifest is not inside its immutable ID directory`);
  }
  return idRoot;
}

function repackProfileRole(entry, role, maxBytes) {
  const target = entry.source;
  const pack = target.packs[role];
  const additions = role === 'sdk'
    ? [
        { id: 'platform-manifest', body: entry.generated.platformBytes, kind: 'json' },
        { id: 'profile-v5', body: Buffer.from(JSON.stringify(entry.generated.platformProfile)), kind: 'json' },
        {
          id: ASM_FLAGS_ARTIFACT_ID,
          body: entry.generated.asmFlagsBytes,
          kind: 'tree',
          files: [{ path: 'sdk/flags/S_flags', offset: 0, length: entry.generated.asmFlagsBytes.length }],
        },
      ]
    : [{ id: 'profile-v4', body: Buffer.from(JSON.stringify(entry.generated.boardProfile)), kind: 'json' }];
  const replacedIds = new Set([
    ...additions.map(({ id }) => id),
    'profile',
  ]);
  const artifacts = [];
  const chunks = new Map();
  const inheritedChunks = new Map();
  let bytes = 0;
  for (const artifact of pack.manifest.artifacts) {
    if (replacedIds.has(artifact.id)) continue;
    artifacts.push(artifact);
    if (!Array.isArray(artifact.chunks) || artifact.chunks.length === 0) {
      throw new Error(`${target.descriptor.board} ${role} Pack artifact chunks are invalid`);
    }
    for (const chunk of artifact.chunks) {
      const inherited = inheritedPackChunk(pack, chunk);
      const current = inheritedChunks.get(inherited.path);
      if (current && (current.size !== inherited.size || current.sha256 !== inherited.sha256
        || current.sourcePath !== inherited.sourcePath)) {
        throw new Error(`${target.descriptor.board} ${role} Pack chunk path is ambiguous: ${inherited.path}`);
      }
      inheritedChunks.set(inherited.path, inherited);
    }
  }
  for (const { id, body, kind, files } of additions) {
    bytes += body.length;
    if (bytes > maxBytes) throw new Error(`${target.descriptor.board} ${role} Pack exceeds safe repack limit ${maxBytes}`);
    artifacts.push(prepareArtifact(body, id, kind, chunks, files));
  }
  artifacts.sort((left, right) => compareUtf16(left.id, right.id));
  const normalizedArtifacts = artifacts.map(normalizePackArtifactShape);
  const base = {
    schema: pack.manifest.schema,
    id: pack.manifest.id,
    version: pack.manifest.version,
    artifacts: normalizedArtifacts,
  };
  if (base.schema === 2) {
    const normalized = validateBrowserToolchainPackManifest({
      ...base,
      revision: pack.manifest.revision,
    });
    const manifestBase = {
      schema: normalized.schema,
      id: normalized.id,
      version: normalized.version,
      artifacts: normalized.artifacts,
    };
    const revision = sha256(Buffer.from(browserToolchainPackRevisionInput(normalized)));
    return {
      manifest: { ...manifestBase, revision },
      chunks,
      inheritedChunks: [...inheritedChunks.values()],
    };
  }
  const revision = sha256(Buffer.from(JSON.stringify(base)));
  return { manifest: { ...base, revision }, chunks, inheritedChunks: [...inheritedChunks.values()] };
}

function normalizePackArtifactShape(artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    size: artifact.size,
    sha256: artifact.sha256,
    ...(artifact.files === undefined ? {} : {
      files: artifact.files.map((file) => ({
        path: file.path,
        offset: file.offset,
        length: file.length,
        sha256: file.sha256,
      })),
    }),
    chunks: artifact.chunks.map((chunk) => ({
      path: chunk.path,
      size: chunk.size,
      sha256: chunk.sha256,
      ...(chunk.compression === undefined ? {} : {
        compression: chunk.compression,
        compressedSize: chunk.compressedSize,
        compressedSha256: chunk.compressedSha256,
      }),
    })),
  };
}

function inheritedPackChunk(pack, chunk) {
  if (!isRecord(chunk) || !nonEmptyString(chunk.path)) {
    throw new Error(`${pack.pin.role} Pack chunk path is invalid`);
  }
  const path = chunk.path.replaceAll('\\', '/');
  const segments = path.split('/');
  if (path.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${pack.pin.role} Pack chunk path is invalid: ${path}`);
  }
  const compressed = chunk.compression !== undefined;
  const size = compressed ? chunk.compressedSize : chunk.size;
  const digest = compressed ? chunk.compressedSha256 : chunk.sha256;
  if (!Number.isSafeInteger(size) || size < 0 || !SHA256.test(digest ?? '')) {
    throw new Error(`${pack.pin.role} Pack chunk identity is invalid: ${path}`);
  }
  const sourcePath = resolve(dirname(pack.manifestPath), ...segments);
  assertInside(dirname(pack.manifestPath), sourcePath, `${pack.pin.role} Pack chunk`);
  return { path, sourcePath, size, sha256: digest };
}

function writeImmutablePack(dir, repacked) {
  const manifestPath = join(dir, 'toolchain.json');
  if (existsSync(dir)) {
    verifyImmutablePack(dir, repacked);
    return { manifestPath, reused: true };
  }
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(dir)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(join(temporary, 'chunks'), { recursive: true });
    for (const chunk of repacked.inheritedChunks) {
      const target = packChunkPath(temporary, chunk.path);
      mkdirSync(dirname(target), { recursive: true });
      try {
        linkSync(chunk.sourcePath, target);
      } catch {
        copyFileSync(chunk.sourcePath, target);
      }
      verifyFileIdentity(target, chunk.size, chunk.sha256);
    }
    for (const [digest, body] of repacked.chunks) {
      writeFileSync(join(temporary, 'chunks', `${digest}.chunk`), body, { flag: 'wx' });
    }
    writeFileSync(
      join(temporary, 'toolchain.json'),
      `${JSON.stringify(repacked.manifest, null, 2)}\n`,
      { flag: 'wx' },
    );
    try {
      renameSync(temporary, dir);
    } catch (error) {
      if (!existsSync(dir)) throw error;
      verifyImmutablePack(dir, repacked);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  verifyImmutablePack(dir, repacked);
  return { manifestPath, reused: false };
}

function verifyImmutablePack(dir, repacked) {
  const actual = readJson(join(dir, 'toolchain.json'));
  if (canonicalJson(actual) !== canonicalJson(repacked.manifest)) {
    throw new Error(`immutable Pack collision: ${dir}`);
  }
  for (const [digest, body] of repacked.chunks) {
    const path = join(dir, 'chunks', `${digest}.chunk`);
    const actualBody = readFileSync(path);
    if (!actualBody.equals(body) || sha256(actualBody) !== digest) {
      throw new Error(`immutable Pack chunk collision: ${path}`);
    }
  }
  for (const chunk of repacked.inheritedChunks) {
    const path = packChunkPath(dir, chunk.path);
    verifyFileIdentity(path, chunk.size, chunk.sha256);
  }
}

function packChunkPath(root, path) {
  const target = resolve(root, ...path.split('/'));
  assertInside(root, target, 'Pack chunk target');
  return target;
}

function verifyFileIdentity(path, expectedSize, expectedSha256) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size !== expectedSize) {
    throw new Error(`immutable Pack chunk size mismatch: ${path}`);
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    let position = 0;
    while (position < expectedSize) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (read <= 0) throw new Error(`immutable Pack chunk ended early: ${path}`);
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(descriptor);
  }
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error(`immutable Pack chunk checksum mismatch: ${path}`);
  }
}

function preflightRepackBytes(analyses, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('safe repack limit must be a non-negative safe integer');
  }
  if (!Array.isArray(analyses) || analyses.length === 0) {
    throw new TypeError('migration analyses must not be empty');
  }
  for (const entry of analyses) {
    const additions = {
      sdk: entry.generated.platformBytes.length
        + Buffer.byteLength(JSON.stringify(entry.generated.platformProfile))
        + entry.generated.asmFlagsBytes.length,
      board: Buffer.byteLength(JSON.stringify(entry.generated.boardProfile)),
    };
    for (const [role, bytes] of Object.entries(additions)) {
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
        throw new Error(`${entry.board} ${role} Pack exceeds safe repack limit ${maxBytes}`);
      }
    }
  }
}

function prepareArtifact(body, id, kind, chunks, files) {
  const digest = sha256(body);
  chunks.set(digest, body);
  return {
    id,
    kind,
    size: body.length,
    sha256: digest,
    chunks: [{ path: `chunks/${digest}.chunk`, size: body.length, sha256: digest }],
    ...(files === undefined ? {} : {
      files: files.map((file) => ({ ...file, sha256: sha256(body.subarray(file.offset, file.offset + file.length)) })),
    }),
  };
}

function validatePack(manifest, pin, role) {
  if (![1, 2].includes(manifest?.schema) || manifest.id !== pin.id || manifest.revision !== pin.revision || !Array.isArray(manifest.artifacts)) throw new Error(`${role} Pack does not match descriptor pin`);
  const revision = sha256(Buffer.from(JSON.stringify({ schema: manifest.schema, id: manifest.id, version: manifest.version, artifacts: manifest.artifacts })));
  if (revision !== manifest.revision) throw new Error(`${role} Pack revision is invalid`);
}

function decodeCurrentMigration(packs, descriptor) {
  const sdkIds = new Set(packs.sdk.manifest.artifacts.map((artifact) => artifact?.id));
  const boardIds = new Set(packs.board.manifest.artifacts.map((artifact) => artifact?.id));
  const presence = [
    sdkIds.has('profile-v5'),
    sdkIds.has('platform-manifest'),
    boardIds.has('profile-v4'),
  ];
  if (presence.every((value) => !value)) return undefined;
  if (!presence.every(Boolean)) throw new Error(`${descriptor.board}: current profile migration is incomplete`);

  const platformProfile = decodeProfile(packs.sdk, 'profile-v5', 5);
  const boardProfile = decodeProfile(packs.board, 'profile-v4', 4);
  const platformArtifact = packs.sdk.manifest.artifacts.find((artifact) => artifact.id === 'platform-manifest');
  const platformBytes = decodePackArtifact(
    packs.sdk.manifest,
    'platform-manifest',
    packs.sdk.manifestPath,
  );
  const platformManifest = JSON.parse(platformBytes.toString('utf8'));
  const ref = platformProfile.platformRef;
  const boardRef = boardProfile.platformRef;
  const compilerPack = platformProfile.sdkVariant?.compilerPack;
  if (platformProfile.platformManifestArtifact?.id !== 'platform-manifest'
    || platformProfile.platformManifestArtifact.sha256 !== platformArtifact?.sha256
    || sha256(platformBytes) !== platformArtifact?.sha256
    || ref?.id !== platformManifest.id
    || ref?.version !== platformManifest.version
    || ref?.sha256 !== platformManifest.sha256
    || boardRef?.id !== ref?.id
    || boardRef?.version !== ref?.version
    || boardRef?.sha256 !== ref?.sha256
    || boardRef?.fqbn !== descriptor.board
    || platformProfile.sdkVariant?.id !== packs.sdk.pin.id
    || compilerPack?.id !== packs.compiler.pin.id
    || compilerPack?.version !== packs.compiler.manifest.version
    || compilerPack?.sha256 !== packs.compiler.pin.revision) {
    throw new Error(`${descriptor.board}: current profile migration binding is invalid`);
  }
  const { sha256: manifestHash, ...manifestBody } = platformManifest;
  if (sha256(Buffer.from(canonicalJson(manifestBody))) !== manifestHash) {
    throw new Error(`${descriptor.board}: current Platform Manifest hash is invalid`);
  }
  return { platformProfile, boardProfile, platformManifest, platformBytes };
}
function decodeProfile(pack, id, schema) {
  const value = JSON.parse(decodePackArtifact(pack.manifest, id, pack.manifestPath));
  if (value?.schema !== schema) throw new Error(`${pack.pin.role} legacy profile schema is invalid`);
  return value;
}

function createRecipeLoweringContract() {
  const body = createEsp32RecipeLoweringInput();
  return { ...body, sha256: sha256(Buffer.from(canonicalJson(body))) };
}

function createLegacyRecipeLoweringContract() {
  const current = createEsp32RecipeLoweringInput();
  const body = {
    ...current,
    schemaVersion: 1,
    bindings: {
      compile: current.bindings.compile.cxx,
      archive: current.bindings.archive,
      link: current.bindings.link,
    },
  };
  return { ...body, sha256: sha256(Buffer.from(canonicalJson(body))) };
}

function upgradePlatformManifest(value) {
  if (!isRecord(value)) throw new Error('Platform Manifest is not an object');
  if (value.schemaVersion === 2) {
    const { sha256: expected, ...body } = value;
    if (!sameKeys(value, CURRENT_PLATFORM_MANIFEST_KEYS) || !SHA256.test(expected)
      || sha256(Buffer.from(canonicalJson(body))) !== expected) {
      throw new Error('current Platform Manifest hash is invalid');
    }
    if (validateRecipeLowering(value.recipeLowering)) return value;
    if (!validateLegacyRecipeLowering(value.recipeLowering)) {
      throw new Error('current Platform Manifest lowering contract is invalid');
    }
    const upgraded = { ...body, recipeLowering: createRecipeLoweringContract() };
    return { ...upgraded, sha256: sha256(Buffer.from(canonicalJson(upgraded))) };
  }
  if (value.schemaVersion !== 1) throw new Error(`unsupported Platform Manifest schema: ${String(value.schemaVersion)}`);
  if (!sameKeys(value, LEGACY_PLATFORM_MANIFEST_KEYS)
    || value.kind !== 'ck-platform-pack' || !SHA256.test(value.sha256)
    || !Array.isArray(value.boards) || !Array.isArray(value.tools)
    || !Array.isArray(value.recipes) || !Array.isArray(value.programmers)
    || !Array.isArray(value.files)) {
    throw new Error('legacy shared Platform Manifest structure is invalid');
  }
  const { sha256: legacyHash, ...legacyHashBody } = value;
  if (sha256(Buffer.from(canonicalJson(legacyHashBody))) !== legacyHash) {
    throw new Error('legacy shared Platform Manifest hash is invalid');
  }
  const { sha256: _oldHash, ...legacyBody } = value;
  const body = {
    ...legacyBody,
    schemaVersion: 2,
    recipeLowering: createRecipeLoweringContract(),
  };
  return { ...body, sha256: sha256(Buffer.from(canonicalJson(body))) };
}

function validateRecipeLowering(value) {
  if (!isRecord(value) || !sameKeys(value, [
    'schemaVersion', 'sha256', 'bindings', 'paths', 'responseFiles', 'compatibility', 'archive', 'publication',
  ]) || value.schemaVersion !== 2 || !SHA256.test(value.sha256)) return false;
  const { sha256: expected, ...body } = value;
  if (sha256(Buffer.from(canonicalJson(body))) !== expected) return false;
  const canonical = createRecipeLoweringContract();
  return canonicalJson(body) === canonicalJson(Object.fromEntries(
    Object.entries(canonical).filter(([key]) => key !== 'sha256'),
  ));
}

function hasBoundRecipes(recipes, lowering) {
  if (!Array.isArray(recipes)) return false;
  const ids = [
    lowering.bindings.compile.c,
    lowering.bindings.compile.cxx,
    lowering.bindings.compile.asm,
    lowering.bindings.archive,
    lowering.bindings.link,
  ];
  return ids.every((id) => typeof id === 'string'
    && recipes.filter((recipe) => recipe?.id === id).length === 1);
}

function validateLegacyRecipeLowering(value) {
  if (!isRecord(value) || !SHA256.test(value.sha256)) return false;
  const { sha256: expected, ...body } = value;
  const canonical = createLegacyRecipeLoweringContract();
  return sha256(Buffer.from(canonicalJson(body))) === expected
    && canonicalJson(body) === canonicalJson(Object.fromEntries(
      Object.entries(canonical).filter(([key]) => key !== 'sha256'),
    ));
}

function oneMatch(values, pattern) {
  if (!Array.isArray(values)) return undefined;
  const matches = values.map((value) => typeof value === 'string' ? value.match(pattern)?.[1] : undefined).filter(Boolean);
  return matches.length === 1 ? matches[0] : undefined;
}
function sameArray(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]); }
function compareUtf16(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function sameKeys(value, expected) {
  return sameArray(Object.keys(value).sort(compareUtf16), [...expected].sort(compareUtf16));
}
function canonicalClone(value) { return JSON.parse(canonicalJson(value)); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function slash(value) { return value.split(sep).join('/'); }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function assertInside(root, child, label) {
  const value = relative(resolve(root), resolve(child));
  if (!value || value === '..' || value.startsWith(`..${sep}`)) throw new Error(`${label} escapes workspace`);
}
function mergeFailure(field, message) {
  const error = new Error(message);
  error.field = field;
  return error;
}
function migrationError(report) { const error = new Error('migration is blocked; see error.report'); error.report = report; return error; }

function cliOptions(argv) {
  const options = { targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--target') options.targets.push(argv[++i]);
    else if (value === '--platform-manifest') options.platformManifest = argv[++i];
    else if (value === '--output') options.output = argv[++i];
    else if (value === '--install') options.install = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.targets.length) delete options.targets;
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(migrateCkPlatformProfiles(cliOptions(process.argv.slice(2))), null, 2)); }
  catch (error) {
    console.log(JSON.stringify(error.report ?? { kind: 'ck-profile-migration-error', message: error.message }, null, 2));
    process.exitCode = 1;
  }
}
