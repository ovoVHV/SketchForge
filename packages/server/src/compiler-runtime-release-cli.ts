import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  canonicalCompilerRuntimeReleaseJson,
  createCompilerRuntimeRelease,
  parseCompilerRuntimeShard,
  readCompilerRuntimeRelease,
} from './compiler-runtime-release.js';

function flags(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--') || result.has(name)) {
      throw new Error('compiler runtime release CLI received invalid arguments');
    }
    result.set(name, value);
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createRelease(values: Map<string, string>): void {
  if ([...values.keys()].some((key) => !['--bundle', '--shards', '--output'].includes(key))) {
    throw new Error('create accepts only --bundle, --shards, and --output');
  }
  const shardDir = resolve(required(values, '--shards'));
  const shards = readdirSync(shardDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => parseCompilerRuntimeShard(
      JSON.parse(readFileSync(join(shardDir, entry.name), 'utf8')) as unknown,
    ));
  const release = createCompilerRuntimeRelease(required(values, '--bundle'), shards);
  const output = resolve(required(values, '--output'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, canonicalCompilerRuntimeReleaseJson(release), { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${release.releaseId}\n`);
}

function inspectRelease(values: Map<string, string>): void {
  if ([...values.keys()].some((key) => !['--manifest', '--bundle'].includes(key))) {
    throw new Error('inspect accepts only --manifest and --bundle');
  }
  const release = readCompilerRuntimeRelease(required(values, '--manifest'));
  if (release.compilerBundleId !== required(values, '--bundle')) {
    throw new Error('compiler runtime release bundle mismatch');
  }
  process.stdout.write(`release-id\t${release.releaseId}\n`);
  for (const runtime of release.runtimes) {
    process.stdout.write([
      runtime.pool,
      `${runtime.imageRepository}@${runtime.imageDigest}`,
      runtime.hostRuntimeIdentity,
    ].join('\t') + '\n');
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  const values = flags(args);
  if (command === 'create') createRelease(values);
  else if (command === 'inspect') inspectRelease(values);
  else throw new Error('expected create or inspect command');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
