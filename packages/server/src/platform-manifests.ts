import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  validatePlatformManifest,
  type CKPlatformManifest,
} from '@sketchforge/core';

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;

interface PlatformManifestRegistryEntry {
  fqbn: string;
  id: string;
  version: string;
  sha256: string;
  path: string;
}

interface PlatformManifestRegistry {
  kind: 'ck-platform-manifest-registry';
  schemaVersion: 1;
  entries: PlatformManifestRegistryEntry[];
}

export interface LoadPlatformManifestsOptions {
  repoRoot: string;
  releasePath?: string;
}

/** Load the same immutable Platform Manifests pinned by the browser release. */
export function loadPublishedPlatformManifests(
  options: LoadPlatformManifestsOptions,
): readonly CKPlatformManifest[] {
  const releasePath = resolve(
    options.releasePath
      ?? join(options.repoRoot, 'packages', 'web', 'public', 'esp32', 'v1', 'release.js'),
  );
  const releaseSource = readRequiredFile(releasePath, 'ESP32 browser release').toString('utf8');
  const pin = parsePlatformRegistryPin(releaseSource);
  const registryPath = resolvePublishedFile(dirname(releasePath), pin.path, 'Platform Manifest registry');
  const registryBytes = readRequiredFile(registryPath, 'Platform Manifest registry');
  if (sha256(registryBytes) !== pin.sha256) {
    throw new Error('Platform Manifest registry does not match the browser release pin');
  }

  const registry = parseRegistry(registryBytes);
  const manifests = new Map<string, CKPlatformManifest>();
  const seenFqbns = new Set<string>();
  for (const entry of registry.entries) {
    validateRegistryEntry(entry);
    if (seenFqbns.has(entry.fqbn)) {
      throw new Error(`duplicate Platform Manifest FQBN: ${entry.fqbn}`);
    }
    seenFqbns.add(entry.fqbn);

    const identity = `${entry.id}\0${entry.version}\0${entry.sha256}\0${entry.path}`;
    let manifest = manifests.get(identity);
    if (!manifest) {
      const manifestPath = resolvePublishedFile(
        dirname(registryPath),
        entry.path,
        `${entry.fqbn} Platform Manifest`,
      );
      let manifestValue: unknown;
      try {
        manifestValue = JSON.parse(
          readRequiredFile(manifestPath, `${entry.fqbn} Platform Manifest`).toString('utf8'),
        );
      } catch (error) {
        throw new Error(`${entry.fqbn} Platform Manifest JSON is invalid`, { cause: error });
      }
      manifest = validatePlatformManifest(manifestValue);
      if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.sha256 !== entry.sha256) {
        throw new Error(`${entry.fqbn} Platform Manifest identity does not match its registry entry`);
      }
      manifests.set(identity, manifest);
    }
    if (manifest.boards.filter((board) => board?.fqbn === entry.fqbn).length !== 1) {
      throw new Error(`${entry.fqbn} must occur exactly once in its Platform Manifest`);
    }
  }
  return Object.freeze([...manifests.values()]);
}

function parsePlatformRegistryPin(source: string): { path: string; sha256: string } {
  const blocks = [...source.matchAll(/\bplatforms\s*:\s*Object\.freeze\(\{([\s\S]*?)\}\)/g)];
  if (blocks.length !== 1) throw new Error(`expected one Platform Manifest release pin; found ${blocks.length}`);
  const block = blocks[0]![1]!;
  const paths = [...block.matchAll(/\bpath\s*:\s*(['"])([^'"]+)\1/g)];
  const hashes = [...block.matchAll(/\bsha256\s*:\s*(['"])([a-f0-9]{64})\1/g)];
  if (paths.length !== 1 || hashes.length !== 1) {
    throw new Error('Platform Manifest release pin must contain exactly one path and SHA-256');
  }
  return { path: paths[0]![2]!, sha256: hashes[0]![2]! };
}

function parseRegistry(bytes: Buffer): PlatformManifestRegistry {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Platform Manifest registry JSON is invalid', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Platform Manifest registry must be an object');
  }
  const registry = value as PlatformManifestRegistry;
  if (registry.kind !== 'ck-platform-manifest-registry' || registry.schemaVersion !== 1) {
    throw new TypeError('unsupported Platform Manifest registry');
  }
  if (!Array.isArray(registry.entries)) throw new TypeError('Platform Manifest registry entries must be an array');
  return registry;
}

function validateRegistryEntry(entry: PlatformManifestRegistryEntry): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('Platform Manifest registry entry must be an object');
  }
  if (typeof entry.fqbn !== 'string' || entry.fqbn.split(':').length !== 3) {
    throw new TypeError('Platform Manifest registry FQBN is invalid');
  }
  if (!IDENTIFIER.test(entry.id) || typeof entry.version !== 'string' || !entry.version.trim()) {
    throw new TypeError(`${entry.fqbn} Platform Manifest identity is invalid`);
  }
  if (!SHA256.test(entry.sha256)) throw new TypeError(`${entry.fqbn} Platform Manifest SHA-256 is invalid`);
  assertSafeRelativePath(entry.path, `${entry.fqbn} Platform Manifest path`);
  const expectedPath = `${entry.id}/${entry.sha256}/manifest.json`;
  if (entry.path !== expectedPath) {
    throw new TypeError(`${entry.fqbn} Platform Manifest path is not content-addressed`);
  }
}

function resolvePublishedFile(root: string, value: string, label: string): string {
  assertSafeRelativePath(value, `${label} path`);
  const candidate = resolve(root, ...value.split('/'));
  const rootPath = realpathSync(root);
  const candidatePath = realpathSync(candidate);
  const remainder = relative(rootPath, candidatePath);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} escapes its publication root`);
  }
  if (!statSync(candidatePath).isFile()) throw new Error(`${label} is not a file`);
  return candidatePath;
}

function assertSafeRelativePath(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError(`${label} must be a safe relative POSIX path`);
  }
}

function readRequiredFile(path: string, label: string): Buffer {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
  return readFileSync(path);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
