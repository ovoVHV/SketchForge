import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = join(
  ROOT,
  'crates',
  'ck-build-core',
  'target',
  'release',
  `ck-build-core${process.platform === 'win32' ? '.exe' : ''}`,
);
const DEFAULT_OUTPUT = join(ROOT, 'packages', 'core', 'native');
const SHA256 = /^[a-f0-9]{64}$/;

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input ?? DEFAULT_INPUT);
const outputRoot = resolve(args.output ?? DEFAULT_OUTPUT);
const platform = args.platform ?? process.platform;
const arch = args.arch ?? process.arch;
const executableName = `ck-build-core${platform === 'win32' ? '.exe' : ''}`;
const relativePath = `${platform}-${arch}/${executableName}`;

validateToken(platform, 'platform');
validateToken(arch, 'arch');
validateRelativePath(relativePath, 'native artifact');

const inputStat = await stat(input);
if (!inputStat.isFile() || inputStat.size <= 0) {
  throw new Error(`native ck-build-core input is not a non-empty file: ${input}`);
}

const bytes = await readFile(input);
const record = {
  platform,
  arch,
  path: relativePath,
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const destination = join(outputRoot, ...relativePath.split('/'));
await mkdir(dirname(destination), { recursive: true });
await copyFile(input, destination);

const manifestPath = join(outputRoot, 'build-manifest.json');
const manifest = await readManifest(manifestPath);
const artifacts = manifest.artifacts
  .filter((candidate) => !(candidate.platform === platform && candidate.arch === arch))
  .concat(record)
  .sort((left, right) => left.path.localeCompare(right.path));
const normalized = {
  schemaVersion: 1,
  artifacts,
};
await writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');

console.log(`${relativePath} ${record.sha256}`);

async function readManifest(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
      throw new Error('unsupported native build manifest');
    }
    for (const artifact of value.artifacts) validateRecord(artifact);
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, artifacts: [] };
    throw new Error(`invalid native build manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateRecord(value) {
  if (!value || typeof value !== 'object'
    || typeof value.platform !== 'string'
    || typeof value.arch !== 'string'
    || typeof value.path !== 'string'
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !SHA256.test(value.sha256)) {
    throw new TypeError('native build manifest artifact is invalid');
  }
  validateToken(value.platform, 'platform');
  validateToken(value.arch, 'arch');
  validateRelativePath(value.path, 'native artifact');
}

function validateToken(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new TypeError(`${label} is invalid: ${value}`);
}

function validateRelativePath(value, label) {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`${label} path is unsafe: ${value}`);
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith('--')) throw new TypeError(`unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!['input', 'output', 'platform', 'arch'].includes(key)) {
      throw new TypeError(`unknown argument: ${value}`);
    }
    const next = values[++index];
    if (!next || next.startsWith('--')) throw new TypeError(`argument ${value} requires a value`);
    result[key] = next;
  }
  return result;
}
