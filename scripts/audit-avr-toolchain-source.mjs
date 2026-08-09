#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const SOURCE_STATE = 'packages/web/browser-avr/TOOLCHAIN_SOURCE.json';
const SOURCE_NOTICE = 'packages/web/browser-avr/TOOLCHAIN_SOURCE.md';
const PUBLISHED_NOTICE = 'packages/web/public/avr/v4/TOOLCHAIN_SOURCE.md';
const RELEASE_LAYOUT = 'packages/web/browser-toolchain/release-layout.json';
const BUILD_SCRIPT = 'scripts/build-browser-avr.mjs';
const BROWSER_ENTRY = 'packages/web/public/browser-avr.js';
const PACKAGE_KEY = 'node_modules/@horang-corp/avr-gcc-wasm';

function finding(code, file, message) {
  return Object.freeze({ code, file, message });
}

export async function auditAvrToolchainSource({ root = ROOT, overrides = {} } = {}) {
  const load = async (path) => Object.hasOwn(overrides, path)
    ? String(overrides[path])
    : readFile(resolve(root, path), 'utf8');
  const [
    stateText,
    releaseLayoutText,
    notice,
    publishedNotice,
    packageText,
    lockText,
    buildText,
    browserText,
  ] = await Promise.all([
    load(SOURCE_STATE),
    load(RELEASE_LAYOUT),
    load(SOURCE_NOTICE),
    load(PUBLISHED_NOTICE),
    load('package.json'),
    load('package-lock.json'),
    load(BUILD_SCRIPT),
    load(BROWSER_ENTRY),
  ]);
  const state = JSON.parse(stateText);
  const releaseLayout = JSON.parse(releaseLayoutText);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);
  const findings = [];
  const reject = (code, file, message) => findings.push(finding(code, file, message));

  if (state.schema !== 1) reject('source-state-schema', SOURCE_STATE, 'schema must be 1');
  if (!/^v[1-9][0-9]*$/.test(state.runtimeVersion ?? '')) {
    reject('source-runtime-version', SOURCE_STATE, 'runtimeVersion is invalid');
  }

  const layoutVersion = releaseLayout?.avr?.version;
  if (releaseLayout?.schema !== 1 || !/^v[1-9][0-9]*$/.test(layoutVersion ?? '')) {
    reject('source-release-layout', RELEASE_LAYOUT, 'schema or AVR runtime version is invalid');
  }
  if (!Array.isArray(releaseLayout?.avr?.sourceFiles)
    || !releaseLayout.avr.sourceFiles.includes('TOOLCHAIN_SOURCE.md')) {
    reject('source-publication-wiring', RELEASE_LAYOUT, 'AVR sourceFiles must publish TOOLCHAIN_SOURCE.md');
  }

  const buildWiring = inspectBuildWiring(buildText);
  if (!buildWiring.releaseLayoutFromExpectedPath || !buildWiring.runtimeVersionFromAvrLayout) {
    reject(
      'source-build-wiring',
      BUILD_SCRIPT,
      'runtimeVersion must come from releaseLayout.avr.version loaded from browser-toolchain/release-layout.json',
    );
  }

  const browserVersion = /\.\/avr\/(v\d+)\//.exec(browserText)?.[1];
  if (state.runtimeVersion !== layoutVersion || state.runtimeVersion !== browserVersion) {
    reject('source-runtime-version', SOURCE_STATE, `state=${state.runtimeVersion}, layout=${layoutVersion}, browser=${browserVersion}`);
  }

  const input = state.binaryInput ?? {};
  const dependencyVersion = packageJson.devDependencies?.[input.package];
  const locked = packageLock.packages?.[PACKAGE_KEY];
  if (input.package !== '@horang-corp/avr-gcc-wasm' || dependencyVersion !== input.version) {
    reject('source-package-drift', SOURCE_STATE, 'binary package or version does not match package.json');
  }
  if (locked?.version !== input.version || locked?.integrity !== input.npmIntegrity) {
    reject('source-package-drift', SOURCE_STATE, 'binary package version or integrity does not match package-lock.json');
  }
  if (!isSha512Integrity(input.npmIntegrity)) {
    reject('source-package-integrity', SOURCE_STATE, 'binary package npmIntegrity must be a canonical SHA-512 digest');
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.upstream?.repository ?? '')
    || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(input.upstream?.tag ?? '')
    || input.upstream?.tag !== `v${input.version}`
    || !/^[a-f0-9]{40}$/.test(input.upstream?.commit ?? '')) {
    reject('source-upstream-identity', SOURCE_STATE, 'upstream repository, tag, or commit is invalid');
  }
  for (const value of [
    `${input.package}@${input.version}`,
    input.upstream?.repository,
    input.upstream?.tag,
    input.upstream?.commit,
  ]) {
    if (!notice.includes(value ?? 'missing')) reject('source-notice-drift', SOURCE_NOTICE, `notice is missing ${value}`);
  }
  if (notice !== publishedNotice) reject('source-publication-drift', PUBLISHED_NOTICE, 'published source notice differs from the build input');

  const commercial = state.commercialRelease ?? {};
  if (typeof commercial.ready !== 'boolean') {
    reject('commercial-release-state', SOURCE_STATE, 'commercialRelease.ready must be boolean');
  }
  if (!commercial.ready) {
    if (commercial.status !== 'integration-only') {
      reject('commercial-release-state', SOURCE_STATE, 'an unready runtime must be marked integration-only');
    }
    if (!Array.isArray(commercial.requiredArtifacts) || commercial.requiredArtifacts.length < 6) {
      reject('commercial-release-state', SOURCE_STATE, 'the missing corresponding-source artifacts are incomplete');
    }
    if (typeof commercial.reason !== 'string' || commercial.reason.length < 80) {
      reject('commercial-release-state', SOURCE_STATE, 'the release blocker reason is missing');
    }
  } else {
    const manifest = commercial.correspondingSourceManifest;
    if (typeof manifest !== 'string' || !manifest.startsWith('packages/web/browser-avr/corresponding-source/')) {
      reject('commercial-release-proof', SOURCE_STATE, 'ready=true requires a repository-local correspondingSourceManifest');
    } else {
      try {
        const proof = JSON.parse(await load(manifest));
        if (proof.schema !== 1 || proof.reproducible !== true || !Array.isArray(proof.artifacts) || !proof.artifacts.length) {
          reject('commercial-release-proof', manifest, 'corresponding source proof is incomplete');
        }
      } catch (error) {
        reject('commercial-release-proof', manifest, error instanceof Error ? error.message : String(error));
      }
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    runtimeVersion: state.runtimeVersion,
    binaryInput: Object.freeze({
      package: input.package,
      version: input.version,
      integrity: input.npmIntegrity,
      commit: input.upstream?.commit,
    }),
    commercialReleaseReady: commercial.ready === true && findings.length === 0,
    blockers: Object.freeze(commercial.ready ? [] : [...new Set(commercial.requiredArtifacts ?? [])]),
  });
}

function inspectBuildWiring(sourceText) {
  const sourceFile = ts.createSourceFile(
    BUILD_SCRIPT,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const releaseLayout = findTopLevelConstInitializer(sourceFile, 'releaseLayout');
  const runtimeVersion = findTopLevelConstInitializer(sourceFile, 'runtimeVersion');
  return Object.freeze({
    releaseLayoutFromExpectedPath: isExpectedReleaseLayoutRead(releaseLayout),
    runtimeVersionFromAvrLayout:
      propertyAccessPath(runtimeVersion).join('.') === 'releaseLayout.avr.version',
  });
}

function findTopLevelConstInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function isExpectedReleaseLayoutRead(node) {
  if (!node
    || !ts.isCallExpression(node)
    || !ts.isIdentifier(node.expression)
    || node.expression.text !== 'readReleaseLayout'
    || node.arguments.length !== 1) return false;
  const path = node.arguments[0];
  return ts.isCallExpression(path)
    && ts.isIdentifier(path.expression)
    && path.expression.text === 'join'
    && path.arguments.length === 2
    && ts.isIdentifier(path.arguments[0])
    && path.arguments[0].text === 'toolchainSourceDir'
    && ts.isStringLiteral(path.arguments[1])
    && path.arguments[1].text === 'release-layout.json';
}

function propertyAccessPath(node) {
  if (!node) return [];
  const parts = [];
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text);
  return parts;
}

function isSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const digest = Buffer.from(encoded, 'base64');
  return digest.byteLength === 64 && digest.toString('base64') === encoded;
}

export function requireCommercialRelease(result) {
  if (!result.ok) throw new Error(`AVR source provenance audit failed: ${result.findings.map((item) => item.message).join('; ')}`);
  if (!result.commercialReleaseReady) {
    throw new Error(`AVR commercial release is blocked until complete corresponding source is reproducible: ${result.blockers.join(', ')}`);
  }
  return result;
}

function parseArgs(values) {
  const options = { requireCommercialRelease: false };
  for (const value of values) {
    if (value === '--require-commercial-release') options.requireCommercialRelease = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/audit-avr-toolchain-source.mjs [--require-commercial-release]');
    return;
  }
  const result = await auditAvrToolchainSource();
  if (!result.ok) {
    for (const item of result.findings) console.error(`[${item.code}] ${item.file}: ${item.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`AVR source provenance audit passed for ${result.binaryInput.package}@${result.binaryInput.version} (${result.runtimeVersion})`);
  if (options.requireCommercialRelease) {
    requireCommercialRelease(result);
    console.log('AVR commercial release corresponding-source gate passed');
  } else if (!result.commercialReleaseReady) {
    console.log(`Commercial release remains blocked: ${result.blockers.join(', ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
