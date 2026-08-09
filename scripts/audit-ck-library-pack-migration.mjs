import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { browserToolchainPackRevisionInput } from '../packages/web/public/avr/v4/toolchain-pack.js';
import { validateEsp32BrowserLibraryRegistry } from '../packages/web/public/esp32/v1/library-registry.js';

const ROOT = resolve(import.meta.dirname, '..');
const LEGACY_ROOT = resolve(ROOT, 'packages/web/public/esp32/v1/libraries');
const REGISTRY_PATH = resolve(ROOT, 'packages/web/public/esp32/v1/libraries-catalog/registry.json');
const LEGACY_ALIASES = Object.freeze({
  'esp32-spi': 'spi',
  'esp32-wire': 'wire',
});

const registryBytes = await readFile(REGISTRY_PATH);
const registry = validateEsp32BrowserLibraryRegistry(
  JSON.parse(registryBytes.toString('utf8')),
  pathToFileURL(REGISTRY_PATH),
);
const byManifestPrefix = new Map();
for (const library of registry.libraries) {
  for (const version of library.versions) {
    const manifest = version.pack.manifest.replaceAll('\\', '/');
    byManifestPrefix.set(`${manifest.split('/').slice(0, 2).join('/')}\0${version.version}`, {
      library,
      version,
    });
  }
}

const legacyDirectories = (await readdir(LEGACY_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort(compareText);
const migrated = [];
const missing = [];

for (const legacyName of legacyDirectories) {
  const catalogName = LEGACY_ALIASES[legacyName] ?? legacyName;
  const legacyPath = join(LEGACY_ROOT, legacyName);
  const versions = (await readdir(legacyPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);
  for (const version of versions) {
    const key = `${catalogName}/${version}\0${version}`;
    const match = byManifestPrefix.get(key);
    if (!match) {
      missing.push({ legacyName, catalogName, version, reason: 'catalog-version-missing' });
      continue;
    }
    try {
      const manifestPath = resolve(dirname(REGISTRY_PATH), ...match.version.pack.manifest.split('/'));
      const manifestValue = JSON.parse((await readFile(manifestPath)).toString('utf8'));
      if (manifestValue.id !== match.version.pack.id
        || manifestValue.revision !== match.version.pack.revision) {
        throw new Error('manifest identity does not match registry');
      }
      if (sha256(Buffer.from(browserToolchainPackRevisionInput(manifestValue))) !== manifestValue.revision) {
        throw new Error('manifest revision is not content-addressed');
      }
      if (!manifestValue.artifacts?.some((artifact) => artifact.id === match.version.pack.artifact)) {
        throw new Error('source artifact is missing');
      }
      migrated.push({
        legacyName,
        catalogName,
        library: match.library.name,
        version,
        packId: match.version.pack.id,
        revision: match.version.pack.revision,
      });
    } catch (error) {
      missing.push({
        legacyName,
        catalogName,
        version,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const report = {
  schema: 1,
  legacySourcePacks: legacyDirectories.length,
  expectedVersions: migrated.length + missing.length,
  migrated: migrated.length,
  missing,
  aliases: LEGACY_ALIASES,
  registry: {
    path: REGISTRY_PATH,
    sha256: sha256(registryBytes),
  },
};
console.log(JSON.stringify(report, null, 2));
if (missing.length) process.exitCode = 1;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
