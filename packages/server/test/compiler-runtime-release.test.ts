import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalCompilerRuntimeReleaseJson,
  compilerRuntimeEvidenceFromEnvironment,
  compilerHostRuntimeIdentities,
  createCompilerRuntimeRelease,
  createUnverifiedLocalRuntimeConfiguration,
  loadCompilerRuntimeConfiguration,
  parseCompilerRuntimeRelease,
  parseCompilerRuntimeReleaseJson,
  normalizeCompilerRuntimeEvidence,
  workerHostRuntimeIdentity,
  type CompilerRuntimeShard,
} from '../src/compiler-runtime-release.js';
import { WORKER_POOLS } from '../src/worker-pools.js';

const temporaryRoots: string[] = [];

function shards(seed = '1'): CompilerRuntimeShard[] {
  return WORKER_POOLS.map((pool, index) => ({
    schema: 1,
    pool,
    platform: 'linux/amd64',
    imageRepository: `ghcr.io/arduinofast/worker-${pool}`,
    imageDigest: `sha256:${String((Number(seed) + index) % 10).repeat(64)}`,
  }));
}

function writeRelease(seed = '1') {
  const root = mkdtempSync(join(tmpdir(), 'af-runtime-release-'));
  temporaryRoots.push(root);
  const release = createCompilerRuntimeRelease('bundle-v1', shards(seed));
  const path = join(root, 'compiler-runtime-release.json');
  writeFileSync(path, canonicalCompilerRuntimeReleaseJson(release), 'utf8');
  return { release, path };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('compiler runtime release', () => {
  it('derives deterministic per-pool identities and one canonical release SHA', () => {
    const first = createCompilerRuntimeRelease('bundle-v1', shards());
    const reordered = createCompilerRuntimeRelease('bundle-v1', shards().reverse());

    expect(first).toEqual(reordered);
    expect(first.releaseId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.runtimes.map((runtime) => runtime.pool)).toEqual(WORKER_POOLS);
    expect(new Set(first.runtimes.map((runtime) => runtime.hostRuntimeIdentity)).size).toBe(3);
    expect(first.runtimes.every((runtime) => Object.isFrozen(runtime))).toBe(true);
    expect(Object.isFrozen(first.runtimes)).toBe(true);
    expect(parseCompilerRuntimeReleaseJson(canonicalCompilerRuntimeReleaseJson(first)))
      .toEqual(first);
  });

  it('changes the release namespace when any image digest or bundle changes', () => {
    const baseline = createCompilerRuntimeRelease('bundle-v1', shards('1'));
    const imageChanged = createCompilerRuntimeRelease('bundle-v1', shards('4'));
    const bundleChanged = createCompilerRuntimeRelease('bundle-v2', shards('1'));

    expect(imageChanged.releaseId).not.toBe(baseline.releaseId);
    expect(bundleChanged.releaseId).not.toBe(baseline.releaseId);
    expect(imageChanged.runtimes[0]?.hostRuntimeIdentity)
      .not.toBe(baseline.runtimes[0]?.hostRuntimeIdentity);
  });

  it('rejects missing pools, duplicate pools, mutable tags, and forged identities', () => {
    expect(() => createCompilerRuntimeRelease('bundle-v1', shards().slice(0, 2)))
      .toThrow(/exactly 3/);
    expect(() => createCompilerRuntimeRelease('bundle-v1', [
      shards()[0]!,
      shards()[0]!,
      shards()[2]!,
    ])).toThrow(/duplicate/);
    expect(() => createCompilerRuntimeRelease('bundle-v1', [
      { ...shards()[0]!, imageRepository: 'ghcr.io/example/worker:latest' },
      ...shards().slice(1),
    ])).toThrow(/OCI repository/);

    const release = createCompilerRuntimeRelease('bundle-v1', shards());
    const forged = JSON.parse(canonicalCompilerRuntimeReleaseJson(release)) as {
      runtimes: Array<{ hostRuntimeIdentity: string }>;
    };
    forged.runtimes[0]!.hostRuntimeIdentity = `sha256:${'f'.repeat(64)}`;
    expect(() => parseCompilerRuntimeRelease(forged)).toThrow(/identity mismatch/);
  });

  it('rejects unknown fields, stale release IDs, and non-canonical JSON', () => {
    const release = createCompilerRuntimeRelease('bundle-v1', shards());
    expect(() => parseCompilerRuntimeRelease({ ...release, extra: true }))
      .toThrow(/exact schema/);
    expect(() => parseCompilerRuntimeRelease({
      ...release,
      releaseId: `sha256:${'0'.repeat(64)}`,
    })).toThrow(/release id mismatch/);
    expect(() => parseCompilerRuntimeReleaseJson(JSON.stringify(release)))
      .toThrow(/not canonical/);
  });

  it('loads an accepted production release only when bundle and env identity match', () => {
    const { release, path } = writeRelease();
    const env = {
      NODE_ENV: 'production',
      AF_COMPILER_RUNTIME_RELEASE_PATH: path,
      AF_COMPILE_RELEASE_ID: release.releaseId,
    };
    const configuration = loadCompilerRuntimeConfiguration(env, 'bundle-v1');

    expect(configuration.trust).toBe('accepted');
    expect(configuration.releaseId).toBe(release.releaseId);
    expect(compilerHostRuntimeIdentities(configuration)).toEqual(Object.fromEntries(
      release.runtimes.map((runtime) => [runtime.pool, runtime.hostRuntimeIdentity]),
    ));
    expect(() => workerHostRuntimeIdentity(configuration, 'avr', env)).toThrow(/does not match/);
    expect(workerHostRuntimeIdentity(configuration, 'avr', {
      ...env,
      AF_HOST_RUNTIME_IDENTITY: release.runtimes[0]!.hostRuntimeIdentity,
    })).toBe(release.runtimes[0]!.hostRuntimeIdentity);
    expect(() => loadCompilerRuntimeConfiguration(env, 'bundle-v2')).toThrow(/bundle/);
    expect(() => loadCompilerRuntimeConfiguration({
      ...env,
      AF_COMPILE_RELEASE_ID: `sha256:${'0'.repeat(64)}`,
    }, 'bundle-v1')).toThrow(/AF_COMPILE_RELEASE_ID/);
  });

  it('keeps development explicitly unverified and refuses accepted impersonation', () => {
    const configuration = loadCompilerRuntimeConfiguration({}, 'development', false);
    expect(configuration).toEqual(createUnverifiedLocalRuntimeConfiguration('development'));
    expect(configuration.trust).toBe('unverified-local');
    expect(workerHostRuntimeIdentity(configuration, 'esp32-riscv', {}))
      .toBe('unverified-local');
    expect(() => workerHostRuntimeIdentity(configuration, 'avr', {
      AF_HOST_RUNTIME_IDENTITY: `sha256:${'a'.repeat(64)}`,
    })).toThrow(/cannot advertise/);
    expect(() => loadCompilerRuntimeConfiguration({ NODE_ENV: 'production' }, 'bundle-v1'))
      .toThrow(/required in production/);
    expect(() => loadCompilerRuntimeConfiguration({
      AF_COMPILE_RELEASE_ID: `sha256:${'a'.repeat(64)}`,
    }, 'bundle-v1', false)).toThrow(/requires a compiler runtime release manifest/);
  });

  it('derives prebuild evidence from the same manifest and rejects pool digest drift', () => {
    const { release, path } = writeRelease();
    const avr = release.runtimes[0]!;
    const env = {
      NODE_ENV: 'production',
      AF_COMPILER_RUNTIME_RELEASE_PATH: path,
      AF_COMPILE_RELEASE_ID: release.releaseId,
      AF_WORKER_POOL: 'avr',
      AF_HOST_RUNTIME_IDENTITY: avr.hostRuntimeIdentity,
      AF_WORKER_IMAGE_DIGEST: avr.imageDigest,
    };
    const evidence = compilerRuntimeEvidenceFromEnvironment(env, 'bundle-v1');
    expect(evidence).toEqual({
      compileReleaseId: release.releaseId,
      pool: 'avr',
      hostRuntimeIdentity: avr.hostRuntimeIdentity,
      imageDigest: avr.imageDigest,
    });
    expect(normalizeCompilerRuntimeEvidence([evidence, evidence])).toEqual([evidence]);
    expect(() => compilerRuntimeEvidenceFromEnvironment({
      ...env,
      AF_WORKER_IMAGE_DIGEST: release.runtimes[1]!.imageDigest,
    }, 'bundle-v1')).toThrow(/does not match accepted runtime pool/);
    expect(() => normalizeCompilerRuntimeEvidence([
      evidence,
      {
        ...evidence,
        imageDigest: release.runtimes[1]!.imageDigest,
        hostRuntimeIdentity: release.runtimes[1]!.hostRuntimeIdentity,
      },
    ])).toThrow(/identity does not match|evidence drift/);
  });
});
