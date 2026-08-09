#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);

export const ESP_SR_AUDIT_PATHS = Object.freeze({
  sourceLock: 'packages/web/public/esp32/v5/xtensa/metadata/esp32s3/source-lock.json',
  provenanceLock: 'packages/web/public/esp32/v5/xtensa/metadata/esp32s3/provenance/source-lock.json',
  notice: 'packages/web/public/esp32/v5/xtensa/metadata/esp32s3/THIRD_PARTY_NOTICES.md',
  license: 'packages/web/public/esp32/v5/xtensa/metadata/esp32s3/licenses/esp-sr/LicenseRef-Espressif-MIT.txt',
  descriptor: 'packages/web/public/esp32/v5/xtensa/esp32s3.json',
  board: 'boards/esp32_esp32_esp32s3.json',
});

const EXPECTED_MODEL = Object.freeze({
  status: 'source-locked/packaged',
  target: 'ESP32-S3',
  partitionScheme: 'esp_sr_16',
  partitionSchemeEnabled: true,
  boardPackArtifact: true,
  arduinoEsp32: {
    version: '3.3.7',
    repository: 'https://github.com/espressif/arduino-esp32.git',
    revision: 'c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
  },
  asset: {
    url: 'https://github.com/espressif/arduino-esp32/releases/download/3.3.7/esp32s3-libs-3.3.7.zip',
    githubAssetId: 354476138,
    size: 64094029,
    sha256: '22a3f4ceb2bf503416aa27d72105cd6e9a51ef4c402415b50915d119d08209d4',
    internalPath: 'esp32s3-libs/esp_sr/srmodels.bin',
    internalSize: 2468362,
    internalSha256: '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879',
  },
  component: {
    name: 'espressif/esp-sr',
    version: '2.3.1',
    repository: 'https://github.com/espressif/esp-sr.git',
    revision: '98f7f642e12b2a3131e93455293a7c02e7e6433a',
    componentHash: '46b1f70f8b561714b958d1c455213cca07162755d1b8df53498081199f15136f',
    checksums: {
      url: 'https://components-file.espressif.com/components/espressif/esp-sr/2.3.1/CHECKSUMS.json',
      size: 97913,
      sha256: 'e37fdc70dc8995ac82076459461b236e825e4441df45922d17c98e915fa7fdee',
    },
  },
  license: {
    id: 'LicenseRef-Espressif-MIT',
    url: 'https://components-file.espressif.com/components/espressif/esp-sr/2.3.1/license.txt',
    path: 'licenses/esp-sr/LicenseRef-Espressif-MIT.txt',
    repositoryNormalization: 'single-terminal-lf',
    size: 1187,
    sha256: '7d916fb00bc0742c47cafb0d0144b67f826d76779730b1cb8796045ea6ba1b9a',
  },
});

const EXPECTED_BOARD_PACK = Object.freeze({
  id: 'arduino-esp32s3-board',
  version: '3.3.7',
  revision: 'ef3a97187d4e866863f82c2586319484733a67f1d4bdb5f34d45aa72ff2fe846',
  artifactId: 'srmodels',
  kind: 'bin',
  size: 2468362,
  sha256: '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879',
  profileArtifactId: 'profile-v4',
  model: Object.freeze({
    artifactId: 'srmodels',
    offset: '0xd10000',
    size: 2468362,
    capacity: 0x2f0000,
  }),
});

const NOTICE_MARKERS = Object.freeze([
  'Status: source-locked/packaged.',
  'Target: ESP32-S3 only.',
  EXPECTED_MODEL.arduinoEsp32.revision,
  EXPECTED_MODEL.asset.url,
  String(EXPECTED_MODEL.asset.githubAssetId),
  EXPECTED_MODEL.asset.sha256,
  EXPECTED_MODEL.asset.internalPath,
  EXPECTED_MODEL.asset.internalSha256,
  `ESP-SR ${EXPECTED_MODEL.component.version}`,
  EXPECTED_MODEL.component.revision,
  EXPECTED_MODEL.component.componentHash,
  EXPECTED_MODEL.component.checksums.url,
  EXPECTED_MODEL.component.checksums.sha256,
  EXPECTED_MODEL.license.id,
  EXPECTED_MODEL.license.path,
  EXPECTED_MODEL.license.sha256,
  'present in the Board Pack',
  'esp_sr_16 partition scheme is enabled for 16MB flash profiles',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function slash(path) {
  return path.split(sep).join('/');
}

function finding(code, file, message) {
  return Object.freeze({ code, file, message });
}

function parseJson(bytes, file, reject) {
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    reject('invalid-json', file, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function resolveInside(base, path, label) {
  const candidate = resolve(base, path);
  const local = relative(base, candidate);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`${label} escapes the ESP32 Xtensa publication`);
  }
  return candidate;
}

export function auditEsp32S3EspSrSourceLock({
  root = ROOT,
  overrides = {},
  readFile = readFileSync,
} = {}) {
  const workspace = resolve(root);
  const findings = [];
  const reject = (code, file, message) => findings.push(finding(code, file, message));
  const load = (path, code, label) => {
    try {
      let value;
      if (Object.hasOwn(overrides, path)) {
        value = overrides[path];
        if (value === null) throw new Error(`${label} is missing`);
      } else {
        value = readFile(resolve(workspace, path));
      }
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      if (!bytes.length) throw new Error(`${label} is empty`);
      return bytes;
    } catch (error) {
      reject(code, path, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  const loadPackArtifact = (packDirectory, artifact, code, label) => {
    if (!artifact || !Array.isArray(artifact.chunks) || artifact.chunks.length !== 1) {
      reject(code, slash(relative(workspace, packDirectory)), `${label} must contain exactly one chunk`);
      return undefined;
    }
    const chunk = artifact.chunks[0];
    if (typeof chunk?.path !== 'string') {
      reject(code, slash(relative(workspace, packDirectory)), `${label} chunk path is invalid`);
      return undefined;
    }
    let chunkPath;
    try {
      chunkPath = resolveInside(packDirectory, chunk.path, `${label} chunk`);
    } catch (error) {
      reject(code, slash(relative(workspace, packDirectory)), error instanceof Error ? error.message : String(error));
      return undefined;
    }
    const publishedPath = slash(relative(workspace, chunkPath));
    const stored = load(publishedPath, code, `${label} chunk`);
    if (!stored) return undefined;
    if (chunk.compression === 'gzip') {
      if (chunk.compressedSize !== stored.byteLength || chunk.compressedSha256 !== sha256(stored)) {
        reject(code, publishedPath, `${label} compressed chunk identity is invalid`);
        return undefined;
      }
    } else if (chunk.compression !== undefined) {
      reject(code, publishedPath, `${label} chunk compression is unsupported`);
      return undefined;
    }
    let bytes;
    try {
      bytes = chunk.compression === 'gzip' ? gunzipSync(stored) : stored;
    } catch (error) {
      reject(code, publishedPath, `${label} chunk cannot be decompressed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if (chunk.size !== bytes.byteLength
      || chunk.sha256 !== sha256(bytes)
      || artifact.size !== bytes.byteLength
      || artifact.sha256 !== sha256(bytes)) {
      reject(code, publishedPath, `${label} bytes do not match the Pack manifest`);
      return undefined;
    }
    return bytes;
  };

  const sourceBytes = load(ESP_SR_AUDIT_PATHS.sourceLock, 'required-source-lock', 'ESP32-S3 source lock');
  const provenanceBytes = load(
    ESP_SR_AUDIT_PATHS.provenanceLock,
    'required-provenance-lock',
    'ESP32-S3 provenance source lock',
  );
  const noticeBytes = load(ESP_SR_AUDIT_PATHS.notice, 'required-notice', 'ESP32-S3 third-party notice');
  const licenseBytes = load(ESP_SR_AUDIT_PATHS.license, 'required-license', 'ESP-SR license');
  const descriptorBytes = load(ESP_SR_AUDIT_PATHS.descriptor, 'required-descriptor', 'ESP32-S3 descriptor');
  const boardBytes = load(ESP_SR_AUDIT_PATHS.board, 'required-board-policy', 'ESP32-S3 board policy');

  const lock = parseJson(sourceBytes, ESP_SR_AUDIT_PATHS.sourceLock, reject);
  const descriptor = parseJson(descriptorBytes, ESP_SR_AUDIT_PATHS.descriptor, reject);
  const board = parseJson(boardBytes, ESP_SR_AUDIT_PATHS.board, reject);
  const model = lock?.sdk?.espSrModel;

  if (lock && (
    lock.schema !== 1
    || lock.status !== 'candidate'
    || lock.sdk?.arduinoEsp32Version !== EXPECTED_MODEL.arduinoEsp32.version
    || lock.sdk?.board !== 'esp32:esp32:esp32s3'
  )) {
    reject('source-lock-envelope', ESP_SR_AUDIT_PATHS.sourceLock, 'ESP32-S3 source-lock envelope is invalid');
  }
  if (lock && !isDeepStrictEqual(model, EXPECTED_MODEL)) {
    reject(
      'source-lock-identity',
      ESP_SR_AUDIT_PATHS.sourceLock,
      'ESP-SR source, asset, component, status, target, or license identity drifted',
    );
  }
  if (sourceBytes && provenanceBytes && !sourceBytes.equals(provenanceBytes)) {
    reject(
      'source-lock-publication-drift',
      ESP_SR_AUDIT_PATHS.provenanceLock,
      'published source-lock copies differ',
    );
  }

  if (noticeBytes) {
    const notice = noticeBytes.toString('utf8');
    for (const marker of NOTICE_MARKERS) {
      if (!notice.includes(marker)) {
        reject('notice-identity', ESP_SR_AUDIT_PATHS.notice, `notice is missing ${marker}`);
      }
    }
  }

  if (licenseBytes) {
    const terminalLf = licenseBytes.at(-1) === 0x0a;
    const upstreamBytes = terminalLf ? licenseBytes.subarray(0, -1) : licenseBytes;
    if (
      !terminalLf
      || licenseBytes.byteLength !== EXPECTED_MODEL.license.size + 1
      || upstreamBytes.byteLength !== EXPECTED_MODEL.license.size
      || sha256(upstreamBytes) !== EXPECTED_MODEL.license.sha256
    ) {
      reject(
        'license-identity',
        ESP_SR_AUDIT_PATHS.license,
        'ESP-SR license bytes do not match the locked official text plus one repository terminal LF',
      );
    }
  }

  let boardPack;
  let boardPackPath;
  let boardPin;
  if (descriptor) {
    const boardPins = Array.isArray(descriptor.packs)
      ? descriptor.packs.filter((pack) => pack?.role === 'board')
      : [];
    boardPin = boardPins[0];
    if (
      descriptor.schema !== 2
      || descriptor.board !== 'esp32:esp32:esp32s3'
      || boardPins.length !== 1
      || boardPin?.id !== EXPECTED_BOARD_PACK.id
      || boardPin?.revision !== EXPECTED_BOARD_PACK.revision
      || typeof boardPin?.manifest !== 'string'
    ) {
      reject('descriptor-policy', ESP_SR_AUDIT_PATHS.descriptor, 'ESP32-S3 Board Pack pin is invalid');
    } else {
      try {
        const xtensaRoot = resolve(workspace, 'packages/web/public/esp32/v5/xtensa');
        const descriptorPath = resolve(workspace, ESP_SR_AUDIT_PATHS.descriptor);
        const absolutePackPath = resolveInside(xtensaRoot, resolve(dirname(descriptorPath), boardPin.manifest), 'Board Pack');
        boardPackPath = slash(relative(workspace, absolutePackPath));
        boardPack = parseJson(
          load(boardPackPath, 'required-board-pack', 'ESP32-S3 Board Pack'),
          boardPackPath,
          reject,
        );
      } catch (error) {
        reject('descriptor-policy', ESP_SR_AUDIT_PATHS.descriptor, error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (boardPack) {
    const artifacts = Array.isArray(boardPack.artifacts) ? boardPack.artifacts : [];
    const revision = sha256(Buffer.from(JSON.stringify({
      schema: boardPack.schema,
      id: boardPack.id,
      version: boardPack.version,
      artifacts,
    })));
    if (
      boardPack.schema !== 2
      || boardPack.id !== EXPECTED_BOARD_PACK.id
      || boardPack.version !== EXPECTED_BOARD_PACK.version
      || boardPack.revision !== EXPECTED_BOARD_PACK.revision
      || boardPack.revision !== boardPin?.revision
      || revision !== boardPack.revision
      || !Array.isArray(boardPack.artifacts)
      || new Set(artifacts.map((artifact) => artifact?.id)).size !== artifacts.length
    ) {
      reject('board-pack-policy', boardPackPath, 'ESP32-S3 Board Pack manifest is invalid');
    }

    const modelArtifacts = artifacts.filter((artifact) => artifact?.id === EXPECTED_BOARD_PACK.artifactId);
    const modelArtifact = modelArtifacts[0];
    if (modelArtifacts.length !== 1
      || modelArtifact?.kind !== EXPECTED_BOARD_PACK.kind
      || modelArtifact?.size !== EXPECTED_BOARD_PACK.size
      || modelArtifact?.sha256 !== EXPECTED_BOARD_PACK.sha256) {
      reject('board-pack-model', boardPackPath, 'ESP32-S3 Board Pack srmodels artifact is invalid');
    } else {
      const packDirectory = dirname(resolve(workspace, boardPackPath));
      const modelBytes = loadPackArtifact(packDirectory, modelArtifact, 'board-pack-model', 'ESP-SR model');
      if (modelBytes && (modelBytes.byteLength !== EXPECTED_BOARD_PACK.size
        || sha256(modelBytes) !== EXPECTED_BOARD_PACK.sha256)) {
        reject('board-pack-model', boardPackPath, 'ESP-SR model bytes drifted from the source lock');
      }
    }

    const profiles = artifacts.filter((artifact) => artifact?.id === EXPECTED_BOARD_PACK.profileArtifactId);
    const profileArtifact = profiles[0];
    if (profiles.length !== 1 || profileArtifact?.kind !== 'json') {
      reject('board-pack-profile', boardPackPath, 'ESP32-S3 Board Profile artifact is invalid');
    } else {
      const packDirectory = dirname(resolve(workspace, boardPackPath));
      const profileBytes = loadPackArtifact(packDirectory, profileArtifact, 'board-pack-profile', 'ESP32-S3 Board Profile');
      const profile = parseJson(profileBytes, boardPackPath, reject);
      if (profile && (
        profile.schema !== 4
        || profile.board !== 'esp32:esp32:esp32s3'
        || !isDeepStrictEqual(profile.flash?.model, EXPECTED_BOARD_PACK.model)
      )) {
        reject('board-pack-profile', boardPackPath, 'ESP32-S3 Board Profile model layout is invalid');
      }
    }
  }

  if (board) {
    const partitionOption = Array.isArray(board.options)
      ? board.options.find((option) => option?.id === 'partition_scheme')
      : undefined;
    const espSrValues = Array.isArray(partitionOption?.values)
      ? partitionOption.values.filter((value) => value?.value === 'esp_sr_16')
      : [];
    const espSr = espSrValues[0];
    const effects = board.build?.optionEffects?.partition_scheme;
    if (
      board.fqbn !== 'esp32:esp32:esp32s3'
      || espSrValues.length !== 1
      || Object.hasOwn(espSr ?? {}, 'unsupported')
      || !isDeepStrictEqual(espSr?.requires, { flash_size: ['16MB'] })
      || !isDeepStrictEqual(effects?.esp_sr_16, {
        partitions: 'esp_sr_16',
        flashSize: '16MB',
        maxFlash: 3145728,
      })
    ) {
      reject(
        'partition-scheme-policy',
        ESP_SR_AUDIT_PATHS.board,
        'esp_sr_16 must be enabled only for 16MB flash with the locked build option effect',
      );
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    status: model?.status,
    target: model?.target,
    licenseSha256: model?.license?.sha256,
    boardPackArtifact: model?.boardPackArtifact,
    partitionSchemeEnabled: model?.partitionSchemeEnabled,
  });
}

function main() {
  const result = auditEsp32S3EspSrSourceLock();
  if (!result.ok) {
    for (const item of result.findings) {
      console.error(`[${item.code}] ${item.file}: ${item.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `ESP32-S3 ESP-SR source lock audit passed: ${result.status}; target=${result.target}; Board Pack artifact=true; esp_sr_16 enabled=true`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) main();
