#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../packages/web/public/avr/v3/toolchain-pack.js';
import {
  validateEsp32CurrentFlashLayout,
  validateEsp32CurrentProfileShape,
} from '../packages/web/public/esp32/v2/c3-compiler.js';
import { decodePackArtifact } from './publish-ck-platform-manifests.mjs';
import { createEsp32RecipeLoweringInput } from './ck-esp32-recipe-lowering.mjs';
import { resolvePlatformManifest } from '../packages/core/dist/platform-pack/builder.js';
import { derivePlatformRecipeCommands } from '../packages/core/dist/platform-pack/recipe-command-lowering.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const SDK_TARGET_BY_BOARD = Object.freeze({
  'esp32:esp32:esp32': 'esp32',
  'esp32:esp32:esp32s2': 'esp32s2',
  'esp32:esp32:esp32s3': 'esp32s3',
  'esp32:esp32:esp32c3': 'esp32c3',
  'esp32:esp32:esp32c5': 'esp32c5',
  'esp32:esp32:esp32c6': 'esp32c6',
  'esp32:esp32:esp32h2': 'esp32h2',
  'esp32:esp32:esp32p4': 'esp32p4_es',
});
const DEFAULT_TARGETS = Object.freeze([
  'packages/web/public/esp32/v5/xtensa/esp32.json',
  'packages/web/public/esp32/v5/xtensa/esp32s2.json',
  'packages/web/public/esp32/v5/xtensa/esp32s3.json',
  'packages/web/public/esp32/v2/runtime/runtime.json',
  'packages/web/public/esp32/v2/runtime-c6/runtime.json',
]);

export function classifyProfileArtifacts(sdkArtifactIds, boardArtifactIds) {
  const sdk = new Set(sdkArtifactIds);
  const board = new Set(boardArtifactIds);
  const sdkProfileIds = sdkArtifactIds.filter(
    (id) => id === 'profile' || id === 'platform-manifest' || id.startsWith('profile-v'),
  );
  const boardProfileIds = boardArtifactIds.filter(
    (id) => id === 'profile' || id.startsWith('profile-v'),
  );
  const hasPlatformV5 = sdk.has('profile-v5');
  const hasPlatformManifest = sdk.has('platform-manifest');
  const hasBoardV4 = board.has('profile-v4');
  const hasCurrent = hasPlatformV5 || hasPlatformManifest || hasBoardV4;
  const hasLegacy = sdk.has('profile') || board.has('profile');
  const unexpectedSdk = sdkProfileIds.filter(
    (id) => !['profile', 'profile-v5', 'platform-manifest'].includes(id),
  );
  const unexpectedBoard = boardProfileIds.filter(
    (id) => !['profile', 'profile-v4'].includes(id),
  );

  if (unexpectedSdk.length || unexpectedBoard.length) {
    throw profilePolicyError(
      'unsupported',
      `unsupported profile artifacts are present (SDK: ${unexpectedSdk.join(', ') || 'none'}; Board: ${unexpectedBoard.join(', ') || 'none'})`,
    );
  }
  if (hasLegacy) {
    if (hasCurrent) {
      throw profilePolicyError(
        'mixed',
        'mixed legacy/current profile artifacts are noncompliant; active Packs must be current-only',
      );
    }
    throw profilePolicyError(
      'legacy-only',
      'legacy-only profile artifacts are noncompliant; migrate to SDK profile-v5 + platform-manifest and Board profile-v4',
    );
  }
  if (!hasPlatformV5 || !hasPlatformManifest || !hasBoardV4) {
    throw profilePolicyError(
      'incomplete-current',
      'current profile artifacts are incomplete; require SDK profile-v5 + platform-manifest and Board profile-v4',
    );
  }
  return 'current-only';
}

export function auditCkPlatformProfileMigration({ root = ROOT, targets = DEFAULT_TARGETS } = {}) {
  const workspace = resolve(root);
  const results = [];
  const issues = [];
  for (const descriptorName of targets) {
    const descriptorPath = resolve(workspace, descriptorName);
    let profileState = 'invalid';
    try {
      assertInside(workspace, descriptorPath, 'runtime descriptor');
      const descriptor = readJson(descriptorPath);
      if (descriptor?.schema !== 2 || typeof descriptor.board !== 'string' || !descriptor.board) {
        throw new Error('runtime descriptor identity is invalid');
      }
      const pins = exactPackRoles(descriptor.packs);
      const sdk = loadPack(descriptorPath, pins.sdk, workspace);
      const board = loadPack(descriptorPath, pins.board, workspace);
      const sdkArtifactIds = artifactIds(sdk.manifest);
      const boardArtifactIds = artifactIds(board.manifest);
      profileState = classifyProfileArtifacts(sdkArtifactIds, boardArtifactIds);
      const platformV5 = decodeJsonArtifact(sdk, 'profile-v5');
      const boardV4 = decodeJsonArtifact(board, 'profile-v4');
      const manifestArtifact = platformV5?.platformManifestArtifact;
      const packedManifest = sdk.manifest.artifacts.find(
        (artifact) => artifact?.id === manifestArtifact?.id,
      );
      if (manifestArtifact?.id !== 'platform-manifest'
        || Object.keys(manifestArtifact).length !== 2
        || !SHA256.test(manifestArtifact.sha256)
        || packedManifest?.kind !== 'json'
        || packedManifest.sha256 !== manifestArtifact.sha256) {
        throw new Error('profile-v5 Platform Manifest artifact binding is invalid');
      }
      const platformManifest = decodeJsonArtifact(sdk, manifestArtifact.id);
      const platformRef = validateCurrentProfiles({
        platformV5,
        boardV4,
        platformManifest,
        descriptor,
        pins,
        sdkManifest: sdk.manifest,
      });
      results.push({
        board: descriptor.board,
        descriptor: relative(workspace, descriptorPath).replaceAll('\\', '/'),
        descriptorRoles: ['compiler', 'sdk', 'board'],
        state: profileState,
        sdkPack: { id: pins.sdk.id, revision: pins.sdk.revision },
        boardPack: { id: pins.board.id, revision: pins.board.revision },
        artifacts: {
          sdk: sdkArtifactIds.filter((id) => id === 'profile' || id.startsWith('profile-v') || id === 'platform-manifest'),
          board: boardArtifactIds.filter((id) => id === 'profile' || id.startsWith('profile-v')),
        },
        platformRef,
      });
    } catch (error) {
      issues.push({
        descriptor: descriptorName.replaceAll('\\', '/'),
        state: error?.profileState ?? (profileState === 'current-only' ? 'invalid-current' : profileState),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const platformRefs = results.map((target) => target.platformRef);
  if (new Set(platformRefs.map((ref) => `${ref.id}\0${ref.version}\0${ref.sha256}`)).size > 1) {
    issues.push({
      descriptor: '*',
      state: 'invalid-current',
      message: 'current-only targets do not share one Platform Manifest identity',
    });
  }
  const currentOnly = results.filter((target) => target.state === 'current-only').length;
  const issueCount = (state) => issues.filter((issue) => issue.state === state).length;
  const state = issues.length ? 'invalid' : 'current-only';
  return Object.freeze({
    schema: 1,
    policy: 'current-only',
    state,
    productionPacksMigrated: state === 'current-only',
    counts: Object.freeze({
      descriptors: targets.length,
      currentOnly,
      legacyOnly: issueCount('legacy-only'),
      mixed: issueCount('mixed'),
      incompleteCurrent: issueCount('incomplete-current'),
      invalid: issues.length,
    }),
    targets: Object.freeze(results),
    issues: Object.freeze(issues),
  });
}

function exactPackRoles(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('runtime descriptor must contain exactly compiler, sdk, and board Packs');
  }
  const roles = new Map();
  for (const pin of value) {
    if (!pin || !['compiler', 'sdk', 'board'].includes(pin.role) || roles.has(pin.role)
      || typeof pin.id !== 'string' || !pin.id || !SHA256.test(pin.revision)
      || typeof pin.manifest !== 'string' || !pin.manifest) {
      throw new Error('runtime descriptor Pack pin is invalid');
    }
    roles.set(pin.role, pin);
  }
  if (roles.size !== 3) throw new Error('runtime descriptor Pack roles are incomplete');
  return Object.freeze({
    compiler: roles.get('compiler'), sdk: roles.get('sdk'), board: roles.get('board'),
  });
}

function loadPack(descriptorPath, pin, workspace) {
  const manifestPath = resolve(dirname(descriptorPath), ...pin.manifest.split('/'));
  assertInside(workspace, manifestPath, `${pin.role} Pack manifest`);
  const sourceManifest = readJson(manifestPath);
  let manifest;
  try {
    manifest = validateBrowserToolchainPackManifest(sourceManifest);
  } catch (error) {
    throw new Error(`${pin.role} Pack violates the Browser v3 contract: ${String(error?.message ?? error)}`);
  }
  if (manifest.schema !== 2 || manifest.id !== pin.id
    || manifest.revision !== pin.revision || !Array.isArray(manifest.artifacts)) {
    throw new Error(`${pin.role} Pack does not match its descriptor pin`);
  }
  const revision = sha256(Buffer.from(browserToolchainPackRevisionInput(sourceManifest), 'utf8'));
  if (revision !== manifest.revision || revision !== pin.revision) {
    throw new Error(`${pin.role} Pack normalized revision is invalid`);
  }
  return Object.freeze({ manifest, manifestPath });
}

function profilePolicyError(profileState, message) {
  const error = new Error(message);
  error.name = 'ProfileArtifactPolicyError';
  error.profileState = profileState;
  return error;
}

function artifactIds(manifest) {
  const ids = manifest.artifacts.map((artifact) => artifact?.id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Pack artifact IDs are invalid or duplicated');
  }
  return ids;
}

function decodeJsonArtifact(pack, id) {
  try {
    return JSON.parse(decodePackArtifact(pack.manifest, id, pack.manifestPath).toString('utf8'));
  } catch (error) {
    throw new Error(`${id} artifact is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateCurrentProfiles({ platformV5, boardV4, platformManifest, descriptor, pins, sdkManifest }) {
  validateEsp32CurrentProfileShape(platformV5, boardV4, descriptor.board);
  if (platformV5?.schema !== 5 || boardV4?.schema !== 4
    || Object.hasOwn(platformV5, 'platformManifest')
    || platformV5.migration?.legacySchema !== 4 || platformV5.migration?.legacyArtifact !== 'profile'
    || boardV4.migration?.legacySchema !== 3 || boardV4.migration?.legacyArtifact !== 'profile') {
    throw new Error('current profile migration metadata is invalid');
  }
  const ref = platformV5.platformRef;
  const boardRef = boardV4.platformRef;
  if (!ref || !SHA256.test(ref.sha256) || typeof ref.id !== 'string' || !ref.id
    || typeof ref.version !== 'string' || !ref.version
    || boardRef?.id !== ref.id || boardRef.version !== ref.version
    || boardRef.sha256 !== ref.sha256 || boardRef.fqbn !== descriptor.board) {
    throw new Error('current Platform and Board profile references do not match');
  }
  if (platformV5.sdkVersion !== ref.version || boardV4.sdkVersion !== ref.version) {
    throw new Error('current profile SDK versions do not match the Platform reference');
  }
  const manifest = platformManifest;
  if (manifest?.kind !== 'ck-platform-pack' || manifest.schemaVersion !== 2
    || manifest.id !== ref.id || manifest.version !== ref.version || manifest.sha256 !== ref.sha256
    || !Array.isArray(manifest.boards) || manifest.boards.length < 2
    || manifest.boards.filter((board) => board?.fqbn === descriptor.board).length !== 1
    || !Array.isArray(manifest.tools) || manifest.tools.length !== 0) {
    throw new Error('profile-v5 does not reference the complete shared Platform Manifest');
  }
  const { sha256: manifestSha256, ...manifestWithoutHash } = manifest;
  if (sha256(Buffer.from(canonicalJson(manifestWithoutHash), 'utf8')) !== manifestSha256) {
    throw new Error('profile-v5 Platform Manifest canonical hash is invalid');
  }
  const loweringContract = manifest.recipeLowering;
  if (!loweringContract || loweringContract.schemaVersion !== 2
    || !SHA256.test(loweringContract.sha256)) {
    throw new Error('profile-v5 Platform Manifest recipe lowering contract is invalid');
  }
  const { sha256: loweringSha256, ...loweringBody } = loweringContract;
  if (sha256(Buffer.from(canonicalJson(loweringBody), 'utf8')) !== loweringSha256
    || canonicalJson(loweringBody) !== canonicalJson(createEsp32RecipeLoweringInput())) {
    throw new Error('profile-v5 Platform Manifest recipe lowering contract hash is invalid');
  }
  const bindings = loweringContract.bindings;
  const recipeIds = [bindings.compile.c, bindings.compile.cxx, bindings.compile.asm, bindings.archive, bindings.link];
  if (!Array.isArray(manifest.recipes)
    || recipeIds.some((id) => manifest.recipes.filter((recipe) => recipe?.id === id).length !== 1)) {
    throw new Error('profile-v5 Platform Manifest recipe bindings are invalid');
  }
  const sdkVariant = platformV5.sdkVariant;
  const expectedSdkTarget = SDK_TARGET_BY_BOARD[descriptor.board];
  if (!expectedSdkTarget || sdkVariant?.id !== pins.sdk.id
    || sdkVariant.sdkTarget !== expectedSdkTarget
    || typeof sdkVariant.memoryType !== 'string' || !sdkVariant.memoryType
    || sdkVariant.compilerPack?.id !== pins.compiler.id
    || sdkVariant.compilerPack.sha256 !== pins.compiler.revision
    || typeof sdkVariant.compilerPack.version !== 'string' || !sdkVariant.compilerPack.version) {
    throw new Error('profile-v5 SDK/Compiler Pack binding is invalid');
  }
  if (platformV5.recipeOrigins?.compile !== loweringContract.bindings.compile.cxx
    || platformV5.recipeOrigins?.link !== loweringContract.bindings.link
    || platformV5.recipeLowering?.status !== 'manifest-defined'
    || platformV5.recipeLowering.schemaVersion !== loweringContract.schemaVersion
    || platformV5.recipeLowering.sha256 !== loweringContract.sha256) {
    throw new Error('profile-v5 recipe lowering evidence is invalid');
  }
  if (!validateCompileLanguageFlags(platformV5.compile, loweringContract.responseFiles)) {
    throw new Error('profile-v5 compile language flags are invalid');
  }
  if (!validateCompileLanguageSemantics(platformV5, boardV4, manifest)) {
    throw new Error('profile-v5 compile language flags differ from the resolved Platform recipes');
  }
  if (!validateCompileResponseArtifacts(platformV5.compile, sdkManifest, loweringContract.responseFiles)) {
    throw new Error('profile-v5 compile response artifacts are invalid');
  }
  const execution = boardV4.execution;
  if (typeof execution?.targetTriple !== 'string' || !execution.targetTriple
    || !Array.isArray(execution.targetArguments) || execution.targetArguments.length < 2
    || execution.targetArguments[0] !== `--target=${execution.targetTriple}`
    || !Number.isSafeInteger(execution.elf?.machine)
    || ![0, 2, 4].includes(execution.elf?.floatAbi)) {
    throw new Error('profile-v4 compiler execution metadata is invalid');
  }
  validateEsp32CurrentFlashLayout(boardV4, platformManifest, descriptor.board);
  return Object.freeze({ id: ref.id, version: ref.version, sha256: ref.sha256 });
}

function validateCompileResponseArtifacts(compile, sdkManifest, responseFiles) {
  if (!Array.isArray(compile?.artifactIds) || !Array.isArray(sdkManifest?.artifacts)) return false;
  const artifacts = compile.artifactIds.map((id) => sdkManifest.artifacts.find((artifact) => artifact?.id === id));
  if (artifacts.some((artifact) => !artifact || !Array.isArray(artifact.files))) return false;
  return Object.values(responseFiles.languageFiles).every((name) => {
    const path = `sdk/flags/${name}`;
    const matches = artifacts.flatMap((artifact) => artifact.files
      .filter((file) => file?.path === path)
      .map((file) => ({ artifact, file })));
    if (matches.length !== 1) return false;
    const { artifact, file } = matches[0];
    return Number.isSafeInteger(file.offset) && file.offset >= 0
      && Number.isSafeInteger(file.length) && file.length > 0
      && file.offset + file.length <= artifact.size && SHA256.test(file.sha256 ?? '');
  });
}

function validateCompileLanguageFlags(compile, responseFiles) {
  const flags = compile?.languageFlags;
  const names = responseFiles?.languageFiles;
  if (!Array.isArray(compile?.args) || !flags || typeof flags !== 'object' || Array.isArray(flags)
    || !names || typeof names !== 'object'
    || Object.keys(flags).sort().join('\0') !== 'asm\0c\0cxx' || responseFiles.marker !== '@') {
    return false;
  }
  const expected = { c: names.c, cxx: names.cxx, asm: names.asm };
  if (Object.values(expected).some((name) => typeof name !== 'string' || !name)) return false;
  const isResponse = (argument) => typeof argument === 'string' && argument.startsWith(responseFiles.marker)
    && Object.values(expected).some((name) => argument.slice(1) === name || argument.endsWith(`/${name}`));
  if (compile.args.some(isResponse)) return false;
  return Object.entries(expected).every(([language, filename]) => {
    const values = flags[language];
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value)) {
      return false;
    }
    const responses = values.filter(isResponse);
    return responses.length === 1
      && (responses[0].slice(1) === filename || responses[0].endsWith(`/${filename}`));
  });
}

function validateCompileLanguageSemantics(platformV5, boardV4, manifest) {
  try {
    const compile = platformV5.compile;
    const link = platformV5.link;
    if (!Array.isArray(compile?.args) || typeof compile.source !== 'string' || !compile.source
      || typeof compile.object !== 'string' || !compile.object
      || typeof link?.object !== 'string' || !link.object) return false;
    const resolved = resolvePlatformManifest({
      manifest,
      fqbn: boardV4.platformRef.fqbn,
      options: isRecord(boardV4.options) ? boardV4.options : {},
    });
    const expected = derivePlatformRecipeCommands({
      recipes: manifest.recipes,
      recipeLowering: manifest.recipeLowering,
      properties: {
        ...resolved.properties,
        'runtime.ide.version': '10607',
        'runtime.os': 'wasm',
        'build.fqbn': resolved.board.fqbn,
        'build.arch': manifest.architecture.toUpperCase(),
        'build.path': '.',
        'build.project_name': 'firmware',
        'build.source.path': 'core',
        'compiler.path': '',
        'compiler.prefix': '',
        'compiler.sdk.path': 'sdk',
        source_file: compile.source,
        object_file: compile.object,
        object_files: link.object,
        archive_file_path: 'core.a',
        includes: '',
        'file_opts.path': '',
        'build.opt.path': '',
      },
    }).compile.languageFlags;
    if (canonicalJson(compile.languageFlags) !== canonicalJson(expected)) return false;
    const languageOwned = new Set(Object.values(expected).flat());
    return compile.args.every((argument) => argument === '-c' || !languageOwned.has(argument));
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertInside(root, child, label) {
  const value = relative(resolve(root), resolve(child));
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditCkPlatformProfileMigration();
  console.log(JSON.stringify(report, null, 2));
  if (report.issues.length) process.exitCode = 1;
}
