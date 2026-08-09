#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../packages/web/public/avr/v3/toolchain-pack.js';
import {
  assertEsp32CurrentOnlyProfileArtifacts,
  validateEsp32CurrentFlashLayout,
  validateEsp32CurrentProfileShape,
} from '../packages/web/public/esp32/v2/c3-compiler.js';
import { createEsp32RecipeLoweringInput } from './ck-esp32-recipe-lowering.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..');
const PUBLIC_ROOT = join(WORKSPACE, 'packages', 'web', 'public');
const PUBLIC_ESP32 = join(PUBLIC_ROOT, 'esp32');
const DEFAULT_OUTPUT = join(PUBLIC_ESP32, 'v1', 'platform-manifests');
const DEFAULT_RELEASE = join(PUBLIC_ESP32, 'v1', 'release.js');
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const FQBN = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;
const TARGETS = Object.freeze([
  ['packages/web/public/esp32/v5/xtensa/esp32.json', 'esp32:esp32:esp32', 'esp32'],
  ['packages/web/public/esp32/v5/xtensa/esp32s2.json', 'esp32:esp32:esp32s2', 'esp32s2'],
  ['packages/web/public/esp32/v5/xtensa/esp32s3.json', 'esp32:esp32:esp32s3', 'esp32s3'],
  ['packages/web/public/esp32/v2/runtime/runtime.json', 'esp32:esp32:esp32c3', 'esp32c3'],
  ['packages/web/public/esp32/v2/runtime-c6/runtime.json', 'esp32:esp32:esp32c6', 'esp32c6'],
].map(([descriptor, board, sdkTarget]) => Object.freeze({
  descriptor: join(WORKSPACE, descriptor), board, sdkTarget,
})));

export function publishCkPlatformManifests({
  targets = TARGETS,
  output = DEFAULT_OUTPUT,
  release = DEFAULT_RELEASE,
  updateReleasePin = resolve(output) === resolve(DEFAULT_OUTPUT),
} = {}) {
  const outputRoot = resolve(output);
  mkdirSync(outputRoot, { recursive: true });
  const entries = targets
    .map((target) => loadPlatformManifest(target))
    .sort((left, right) => compareText(left.fqbn, right.fqbn));
  const seenBoards = new Set();
  for (const entry of entries) {
    if (seenBoards.has(entry.fqbn)) throw new Error(`duplicate Platform Manifest board: ${entry.fqbn}`);
    seenBoards.add(entry.fqbn);
    const destination = join(outputRoot, entry.id, entry.sha256, 'manifest.json');
    assertInside(outputRoot, destination, 'Platform Manifest destination');
    const body = Buffer.from(`${canonicalJson(entry.manifest)}\n`, 'utf8');
    publishImmutableFile(destination, body);
    entry.path = relative(outputRoot, destination).split(sep).join('/');
  }
  const registry = {
    kind: 'ck-platform-manifest-registry',
    schemaVersion: 1,
    entries: entries.map(({ manifest: _manifest, ...entry }) => entry),
  };
  const registryBody = Buffer.from(`${canonicalJson(registry)}\n`, 'utf8');
  const registryPath = join(outputRoot, 'registry.json');
  writeFileSync(registryPath, registryBody);
  const registrySha256 = sha256(registryBody);
  const descriptorPins = targets.map((target) => {
    const descriptor = resolve(target.descriptor);
    assertInside(PUBLIC_ROOT, descriptor, 'runtime descriptor release pin');
    return Object.freeze({
      fqbn: target.board,
      path: `./${relative(PUBLIC_ROOT, descriptor).split(sep).join('/')}`,
      sha256: sha256(readFileSync(descriptor)),
    });
  });
  if (updateReleasePin) updateEsp32ReleasePins({ release, registrySha256, descriptorPins });
  return Object.freeze({
    output: outputRoot,
    registry: registryPath,
    registrySha256,
    entries: Object.freeze(registry.entries),
    descriptorPins: Object.freeze(descriptorPins),
  });
}

export function decodePackArtifact(manifest, artifactId, manifestPath) {
  const artifact = manifest?.artifacts?.find((candidate) => candidate.id === artifactId);
  if (!artifact || !Array.isArray(artifact.chunks) || !artifact.chunks.length
    || !Number.isSafeInteger(artifact.size) || !SHA256.test(artifact.sha256)) {
    throw new Error(`Pack artifact is invalid: ${artifactId}`);
  }
  const root = dirname(resolve(manifestPath));
  const chunks = artifact.chunks.map((chunk) => {
    if (typeof chunk.path !== 'string' || chunk.path.includes('..') || chunk.path.startsWith('/')) {
      throw new Error(`Pack chunk path is invalid: ${String(chunk.path)}`);
    }
    const path = resolve(root, ...chunk.path.split('/'));
    assertInside(root, path, 'Pack chunk');
    const transport = readFileSync(path);
    const transportSize = chunk.compressedSize ?? chunk.size;
    const transportSha256 = chunk.compressedSha256 ?? chunk.sha256;
    if (transport.byteLength !== transportSize || sha256(transport) !== transportSha256) {
      throw new Error(`Pack chunk transport integrity mismatch: ${chunk.path}`);
    }
    const body = chunk.compression === 'gzip' ? gunzipSync(transport) : transport;
    if (body.byteLength !== chunk.size || sha256(body) !== chunk.sha256) {
      throw new Error(`Pack chunk decoded integrity mismatch: ${chunk.path}`);
    }
    return body;
  });
  const body = Buffer.concat(chunks);
  if (body.byteLength !== artifact.size || sha256(body) !== artifact.sha256) {
    throw new Error(`Pack artifact integrity mismatch: ${artifactId}`);
  }
  return body;
}

export function updatePlatformRegistryPin({ release = DEFAULT_RELEASE, registrySha256 }) {
  return updateEsp32ReleasePins({ release, registrySha256 });
}

export function updateEsp32ReleasePins({
  release = DEFAULT_RELEASE,
  registrySha256,
  descriptorPins = [],
} = {}) {
  if (!SHA256.test(registrySha256)) throw new TypeError('Platform Manifest registry hash is invalid');
  if (!Array.isArray(descriptorPins)) throw new TypeError('runtime descriptor pins must be an array');
  let updated = readFileSync(release, 'utf8');
  let count = 0;
  updated = updated.replace(
    /(platforms:\s*Object\.freeze\(\{[\s\S]*?sha256:\s*')[a-f0-9]{64}(')/,
    (_match, prefix, suffix) => {
      count += 1;
      return `${prefix}${registrySha256}${suffix}`;
    },
  );
  if (count !== 1) throw new Error(`expected one Platform Manifest registry pin; found ${count}`);

  const boards = new Set();
  for (const pin of descriptorPins) {
    if (!pin || !FQBN.test(pin.fqbn) || !SHA256.test(pin.sha256)
      || typeof pin.path !== 'string' || !pin.path.startsWith('./')) {
      throw new TypeError('runtime descriptor release pin is invalid');
    }
    if (boards.has(pin.fqbn)) throw new Error(`duplicate runtime descriptor release pin: ${pin.fqbn}`);
    boards.add(pin.fqbn);
    const board = escapeRegExp(pin.fqbn);
    const pattern = new RegExp(
      `('${board}':\\s*Object\\.freeze\\(\\{[\\s\\S]*?path:\\s*')([^']+)('[\\s\\S]*?sha256:\\s*')[a-f0-9]{64}(')`,
    );
    let matches = 0;
    updated = updated.replace(pattern, (_match, prefix, currentPath, middle, suffix) => {
      matches += 1;
      if (currentPath !== pin.path) {
        throw new Error(`${pin.fqbn} runtime descriptor path changed: ${currentPath}`);
      }
      return `${prefix}${currentPath}${middle}${pin.sha256}${suffix}`;
    });
    if (matches !== 1) throw new Error(`expected one runtime descriptor pin for ${pin.fqbn}; found ${matches}`);
  }
  writeFileSync(release, updated, 'utf8');
  return Object.freeze({ registrySha256, descriptorPins: Object.freeze([...descriptorPins]) });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPlatformManifest(target) {
  const descriptorPath = resolve(target.descriptor);
  assertInside(PUBLIC_ESP32, descriptorPath, 'runtime descriptor');
  const descriptor = readJson(descriptorPath);
  if (descriptor.board !== target.board || !Array.isArray(descriptor.packs)) {
    throw new Error(`runtime descriptor board mismatch: ${target.board}`);
  }
  const sdkPin = requirePackPin(descriptor, 'sdk', target.board);
  const compilerPin = requirePackPin(descriptor, 'compiler', target.board);
  const boardPin = requirePackPin(descriptor, 'board', target.board);
  const sdkManifestPath = resolve(dirname(descriptorPath), ...sdkPin.manifest.split('/'));
  assertInside(PUBLIC_ESP32, sdkManifestPath, `${target.board} SDK Pack`);
  const sdkManifest = validatePackManifest(
    readJson(sdkManifestPath),
    sdkPin,
    target.board,
    'SDK',
    [2],
  );
  const compilerManifestPath = resolve(
    dirname(descriptorPath),
    ...compilerPin.manifest.split('/'),
  );
  assertInside(PUBLIC_ESP32, compilerManifestPath, `${target.board} Compiler Pack`);
  const compilerManifest = validatePackManifest(
    readJson(compilerManifestPath),
    compilerPin,
    target.board,
    'Compiler',
    [1, 2],
  );
  const boardManifestPath = resolve(dirname(descriptorPath), ...boardPin.manifest.split('/'));
  assertInside(PUBLIC_ESP32, boardManifestPath, `${target.board} Board Pack`);
  const boardManifest = validatePackManifest(
    readJson(boardManifestPath),
    boardPin,
    target.board,
    'Board',
    [2],
  );
  assertEsp32CurrentOnlyProfileArtifacts(sdkManifest, boardManifest, target.board);

  const profile = decodeJsonPackArtifact(sdkManifest, 'profile-v5', sdkManifestPath, target.board);
  if (profile?.schema !== 5) {
    throw new Error(`${target.board} Platform execution profile schema must be 5`);
  }
  const requirement = {
    id: compilerPin.id,
    version: compilerManifest.version,
    sha256: compilerPin.revision,
  };
  const manifest = decodeCurrentPlatformManifest(profile, sdkManifest, sdkManifestPath, target.board);
  validatePlatformManifest(manifest, target.board);
  if (manifest.tools.length !== 0) {
    throw new Error(`${target.board} Platform Manifest must be tool-neutral`);
  }
  validateToolRequirement(requirement, target.board);
  validateExecutionProfileBinding(
    profile,
    manifest,
    requirement,
    sdkPin,
    target.sdkTarget,
    target.board,
  );
  if (sdkManifest.version !== manifest.version) {
    throw new Error(`${target.board} SDK Pack version does not match Platform Manifest`);
  }
  if (!validateCompileResponseArtifacts(profile.compile, sdkManifest, manifest.recipeLowering.responseFiles)) {
    throw new Error(`${target.board} Platform execution profile response artifacts are invalid`);
  }
  const boardProfile = decodeJsonPackArtifact(
    boardManifest,
    'profile-v4',
    boardManifestPath,
    target.board,
  );
  validateEsp32CurrentProfileShape(profile, boardProfile, target.board);
  validateBoardProfileBinding({
    profile: boardProfile,
    boardManifest,
    boardManifestPath,
    manifest,
    platformProfile: profile,
    boardPin,
    board: target.board,
  });
  return {
    fqbn: target.board,
    id: manifest.id,
    version: manifest.version,
    sha256: manifest.sha256,
    sdkPack: { id: sdkPin.id, revision: sdkPin.revision },
    manifest,
  };
}

export function decodeCurrentPlatformManifest(profile, sdkManifest, sdkManifestPath, board) {
  const reference = profile?.platformManifestArtifact;
  if (reference?.id !== 'platform-manifest' || !SHA256.test(reference.sha256)) {
    throw new Error(`${board} Platform Manifest artifact reference is invalid`);
  }
  const artifacts = sdkManifest.artifacts.filter((candidate) => candidate?.id === reference.id);
  if (artifacts.length !== 1 || artifacts[0].kind !== 'json'
    || artifacts[0].sha256 !== reference.sha256) {
    throw new Error(`${board} Platform Manifest artifact binding is invalid`);
  }
  try {
    return JSON.parse(decodePackArtifact(
      sdkManifest,
      reference.id,
      sdkManifestPath,
    ).toString('utf8'));
  } catch (error) {
    throw new Error(`${board} Platform Manifest artifact is invalid: ${String(error?.message ?? error)}`);
  }
}

export function validateExecutionProfileBinding(
  profile,
  manifest,
  requirement,
  sdkPin,
  expectedSdkTarget,
  board = 'Platform',
) {
  if (profile?.schema !== 5 || profile?.platformRef?.id !== manifest.id
    || profile.platformRef.version !== manifest.version
    || profile.platformRef.sha256 !== manifest.sha256
    || profile.platformManifestArtifact?.id !== 'platform-manifest'
    || !SHA256.test(profile.platformManifestArtifact.sha256)) {
    throw new Error(`${board} Platform execution profile identity is invalid`);
  }
  if (profile.sdkVersion !== manifest.version) {
    throw new Error(`${board} Platform execution profile version is invalid`);
  }
  const variant = profile.sdkVariant;
  if (!variant || variant.id !== sdkPin.id || variant.sdkTarget !== expectedSdkTarget
    || typeof variant.memoryType !== 'string' || !variant.memoryType
    || !variant.compilerPack
    || variant.compilerPack.id !== requirement.id
    || variant.compilerPack.version !== requirement.version
    || variant.compilerPack.sha256 !== requirement.sha256) {
    throw new Error(`${board} Platform execution profile Pack binding is invalid`);
  }
  const lowering = profile.recipeLowering;
  if (profile.recipeOrigins?.compile !== manifest.recipeLowering.bindings.compile.cxx
    || profile.recipeOrigins?.link !== manifest.recipeLowering.bindings.link
    || lowering?.status !== 'manifest-defined'
    || lowering.schemaVersion !== manifest.recipeLowering.schemaVersion
    || lowering.sha256 !== manifest.recipeLowering.sha256) {
    throw new Error(`${board} Platform execution profile recipe lowering binding is invalid`);
  }
  if (!validateCompileLanguageFlags(profile.compile, manifest.recipeLowering.responseFiles)) {
    throw new Error(`${board} Platform execution profile language flags are invalid`);
  }
  return profile;
}

function validateBoardProfileBinding({
  profile,
  boardManifest,
  boardManifestPath,
  manifest,
  platformProfile,
  boardPin,
  board,
}) {
  const manifestBoards = manifest.boards.filter((candidate) => candidate?.fqbn === board);
  const manifestBoard = manifestBoards[0];
  if (profile?.schema !== 4 || !IDENTIFIER.test(profile.id) || profile.board !== board
    || profile.sdkVersion !== manifest.version || boardManifest.version !== manifest.version
    || profile.variant !== manifestBoard?.variant
    || profile.platformRef?.id !== manifest.id
    || profile.platformRef.version !== manifest.version
    || profile.platformRef.sha256 !== manifest.sha256
    || profile.platformRef.fqbn !== board) {
    throw new Error(`${board} Board execution profile identity is invalid`);
  }
  if (!Array.isArray(profile.artifactIds) || !profile.artifactIds.length
    || new Set(profile.artifactIds).size !== profile.artifactIds.length
    || profile.artifactIds.some((id) => (
      typeof id !== 'string'
      || boardManifest.artifacts.filter((artifact) => artifact?.id === id).length !== 1
    ))) {
    throw new Error(`${board} Board execution profile artifacts are invalid`);
  }

  const execution = validateCompilerExecution(profile.execution, board);
  const targetFlags = execution.targetArguments.slice(1);
  if (!sameStringArray(profile.overlay?.compile?.target, targetFlags)
    || !sameStringArray(profile.overlay?.link?.target, targetFlags)) {
    throw new Error(`${board} Board execution profile target overlay is invalid`);
  }
  const targetArgument = execution.targetArguments[0];
  for (const [phase, command] of [['compile', platformProfile.compile], ['link', platformProfile.link]]) {
    if (!Array.isArray(command?.args)
      || command.args.filter((argument) => argument === targetArgument).length !== 1
      || command.args.some((argument) => argument.startsWith('--target=') && argument !== targetArgument)) {
      throw new Error(`${board} Board execution profile does not match Platform ${phase} target`);
    }
  }

  const flash = profile.flash;
  const flashIds = [flash?.bootloader, flash?.partitions, flash?.bootApp0];
  if (flashIds.some((id) => typeof id !== 'string' || !id)
    || new Set(flashIds).size !== flashIds.length) {
    throw new Error(`${board} Board execution profile flash artifacts are invalid`);
  }
  for (const artifactId of flashIds) {
    const matches = boardManifest.artifacts.filter((artifact) => artifact?.id === artifactId);
    if (matches.length !== 1 || matches[0].kind !== 'bin') {
      throw new Error(`${board} Board execution profile flash artifact is invalid: ${artifactId}`);
    }
    decodePackArtifact(boardManifest, artifactId, boardManifestPath);
  }
  validateEsp32CurrentFlashLayout(profile, manifest, board);
  if (boardPin.id !== boardManifest.id) {
    throw new Error(`${board} Board Pack identity is invalid`);
  }
  return profile;
}

function validateCompilerExecution(value, board) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !IDENTIFIER.test(value.targetTriple)
    || !Array.isArray(value.targetArguments)
    || value.targetArguments.length < 2 || value.targetArguments.length > 8
    || value.targetArguments[0] !== `--target=${value.targetTriple}`
    || value.targetArguments.some((argument) => (
      typeof argument !== 'string'
      || !/^-(?:-target=|mcpu=|march=|mabi=)[A-Za-z0-9._+-]+$/.test(argument)
    ))
    || new Set(value.targetArguments).size !== value.targetArguments.length) {
    throw new Error(`${board} Board execution profile compiler target is invalid`);
  }
  const expectedMachine = value.targetTriple.startsWith('riscv32-')
    ? 243
    : value.targetTriple.startsWith('xtensa-') ? 94 : 0;
  const targetFlags = value.targetArguments.slice(1);
  const riscvTarget = expectedMachine === 243
    && targetFlags.filter((argument) => argument.startsWith('-march=')).length === 1
    && targetFlags.filter((argument) => argument.startsWith('-mabi=')).length === 1
    && !targetFlags.some((argument) => argument.startsWith('-mcpu='));
  const xtensaTarget = expectedMachine === 94
    && targetFlags.filter((argument) => argument.startsWith('-mcpu=')).length === 1
    && !targetFlags.some((argument) => argument.startsWith('-march=') || argument.startsWith('-mabi='));
  const mabi = targetFlags.find((argument) => argument.startsWith('-mabi='))?.slice(6) ?? '';
  const expectedFloatAbi = mabi.endsWith('d') ? 0x4 : mabi.endsWith('f') ? 0x2 : 0;
  if ((!riscvTarget && !xtensaTarget) || value.elf?.machine !== expectedMachine
    || value.elf.floatAbi !== expectedFloatAbi) {
    throw new Error(`${board} Board execution profile compiler ELF target is invalid`);
  }
  return value;
}

function requirePackPin(descriptor, role, board) {
  const matches = descriptor.packs.filter((pack) => pack?.role === role);
  const pin = matches[0];
  const label = `${role[0].toUpperCase()}${role.slice(1)}`;
  if (matches.length !== 1 || !IDENTIFIER.test(pin?.id) || !SHA256.test(pin?.revision)
    || typeof pin?.manifest !== 'string' || !pin.manifest) {
    throw new Error(`${board} ${label} Pack pin is invalid`);
  }
  return pin;
}

function decodeJsonPackArtifact(manifest, artifactId, manifestPath, board) {
  const artifacts = manifest.artifacts.filter((artifact) => artifact?.id === artifactId);
  if (artifacts.length !== 1 || artifacts[0].kind !== 'json') {
    throw new Error(`${board} Pack must contain exactly one ${artifactId} artifact`);
  }
  try {
    return JSON.parse(decodePackArtifact(manifest, artifactId, manifestPath).toString('utf8'));
  } catch (error) {
    throw new Error(`${board} ${artifactId} artifact is invalid: ${String(error?.message ?? error)}`);
  }
}

function sameStringArray(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validatePackManifest(manifest, pin, board, role, schemas) {
  let normalized = manifest;
  if (role === 'SDK' || role === 'Board') {
    try {
      normalized = validateBrowserToolchainPackManifest(manifest);
    } catch (error) {
      throw new Error(`${board} ${role} Pack violates the Browser v3 contract: ${String(error?.message ?? error)}`);
    }
  }
  if (!schemas.includes(normalized?.schema) || normalized.id !== pin.id || normalized.revision !== pin.revision
    || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)
    || !Array.isArray(normalized.artifacts)) {
    throw new Error(`${board} ${role} Pack does not match its descriptor`);
  }
  const revisionInput = role === 'SDK' || role === 'Board'
    ? browserToolchainPackRevisionInput(manifest)
    : JSON.stringify({
        schema: normalized.schema,
        id: normalized.id,
        version: normalized.version,
        artifacts: normalized.artifacts,
      });
  const revision = sha256(Buffer.from(revisionInput, 'utf8'));
  if (revision !== normalized.revision || revision !== pin.revision) {
    throw new Error(`${board} ${role} Pack normalized revision mismatch`);
  }
  return normalized;
}

function validatePlatformManifest(manifest, board) {
  if (!manifest || manifest.kind !== 'ck-platform-pack' || manifest.schemaVersion !== 2
    || !IDENTIFIER.test(manifest.id) || typeof manifest.version !== 'string'
    || !VERSION.test(manifest.version) || !SHA256.test(manifest.sha256)
    || !Array.isArray(manifest.boards) || !Array.isArray(manifest.tools)
    || !validateRecipeLowering(manifest.recipeLowering)) {
    throw new Error(`${board} Platform Manifest is invalid`);
  }
  const bindings = manifest.recipeLowering.bindings;
  const recipeIds = [bindings.compile.c, bindings.compile.cxx, bindings.compile.asm, bindings.archive, bindings.link];
  if (!Array.isArray(manifest.recipes)
    || recipeIds.some((id) => manifest.recipes.filter((recipe) => recipe?.id === id).length !== 1)) {
    throw new Error(`${board} Platform Manifest recipe bindings are invalid`);
  }
  manifest.tools.forEach((tool) => validateToolRequirement(tool, board));
  const { sha256: expected, ...withoutHash } = manifest;
  if (sha256(Buffer.from(canonicalJson(withoutHash), 'utf8')) !== expected) {
    throw new Error(`${board} Platform Manifest hash mismatch`);
  }
  const matches = manifest.boards.filter((candidate) => candidate?.fqbn === board);
  if (matches.length !== 1) throw new Error(`${board} Platform Manifest board is missing`);
}

function validateRecipeLowering(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 2 || !SHA256.test(value.sha256)) return false;
  const { sha256: expected, ...body } = value;
  if (sha256(Buffer.from(canonicalJson(body), 'utf8')) !== expected) return false;
  return canonicalJson(body) === canonicalJson(createEsp32RecipeLoweringInput());
}

function validateCompileLanguageFlags(compile, responseFiles) {
  const flags = compile?.languageFlags;
  const names = responseFiles?.languageFiles;
  if (!compile || !Array.isArray(compile.args) || !flags || typeof flags !== 'object'
    || Array.isArray(flags) || !names || typeof names !== 'object'
    || Object.keys(flags).sort().join('\0') !== 'asm\0c\0cxx') return false;
  const marker = responseFiles.marker;
  const languageNames = { c: names.c, cxx: names.cxx, asm: names.asm };
  if (marker !== '@' || Object.values(languageNames).some((name) => typeof name !== 'string' || !name)) {
    return false;
  }
  const isLanguageResponse = (argument) => typeof argument === 'string' && argument.startsWith(marker)
    && Object.values(languageNames).some((name) => argument.slice(marker.length) === name || argument.endsWith(`/${name}`));
  if (compile.args.some(isLanguageResponse)) return false;
  return Object.entries(languageNames).every(([language, expected]) => {
    const values = flags[language];
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value)) {
      return false;
    }
    const responses = values.filter(isLanguageResponse);
    return responses.length === 1
      && (responses[0].slice(marker.length) === expected || responses[0].endsWith(`/${expected}`));
  });
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

function validateToolRequirement(tool, board) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)
    || !IDENTIFIER.test(tool.id) || typeof tool.version !== 'string'
    || !VERSION.test(tool.version) || !SHA256.test(tool.sha256)) {
    throw new Error(`${board} Platform tool requirement is invalid`);
  }
  return { id: tool.id, version: tool.version, sha256: tool.sha256 };
}

function publishImmutableFile(path, body) {
  if (existsSync(path)) {
    const current = readFileSync(path);
    if (!current.equals(body)) throw new Error(`immutable Platform Manifest address contains different bytes: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('canonical JSON value is invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`JSON file is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertInside(root, child, label) {
  const value = relative(resolve(root), resolve(child));
  if (!value || value === '..' || value.startsWith(`..${sep}`)) throw new Error(`${label} escapes ${root}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = publishCkPlatformManifests();
    console.log(`Published ${result.entries.length} CK Platform Manifests`);
    console.log(`${relative(WORKSPACE, result.registry)} sha256=${result.registrySha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
