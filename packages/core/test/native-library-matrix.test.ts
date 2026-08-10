import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createNativeLibraryPackClosureEvidence,
  createNativeMatrixPlan,
  createNativeToolchainClosure,
  createNativeVerifierRequest,
  assertNativeLibraryLocalFileUrl,
  createNativeExecutionEnvironment,
  createNativeExecutionEnvironmentEvidence,
  nativeMatrixOptions,
  nativeLibraryMatrixJobFingerprint,
  nativeVerifierArguments,
  readCompilerRuntimeReleaseIdentity,
  resolveNativePythonInterpreter,
  readCommittedPlannerPublicationIdentity,
  readPlannerPublicationIdentity,
  runNativeVerifier,
  selectReusableNativeResults,
} from '../../../scripts/verify-ck-native-library-matrix.mjs';
import {
  createNativeExecutionIdentity,
  loadNativeLibraryPackSnapshot,
} from '../../../scripts/verify-ck-native-library-pack.js';
import { browserToolchainPackRevisionInput } from '../../web/public/avr/v3/toolchain-pack.js';
import { validateEsp32BrowserLibraryRegistry } from '../../web/public/esp32/v1/library-registry.js';
import type { ToolchainConfig } from '../src/index.js';

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compilerRuntimeRelease(seed: string) {
  const pools = ['avr', 'esp32-xtensa', 'esp32-riscv'];
  const runtimes = pools.map((pool, index) => {
    const imageDigest = `sha256:${String((Number(seed) + index) % 10).repeat(64)}`;
    const hostPayload = {
      schema: 1,
      kind: 'sketchforge-host-runtime',
      mode: 'oci-image',
      pool,
      platform: 'linux/amd64',
      imageDigest,
    };
    return {
      pool,
      mode: 'oci-image',
      platform: 'linux/amd64',
      imageRepository: `ghcr.io/sketchforge/worker-${pool}`,
      imageDigest,
      hostRuntimeIdentity: `sha256:${sha256(JSON.stringify(hostPayload))}`,
    };
  });
  const payload = {
    schema: 1,
    kind: 'sketchforge-compiler-runtime-release',
    trust: 'accepted',
    compilerBundleId: 'matrix-test-bundle',
    runtimes,
  };
  return {
    ...payload,
    releaseId: `sha256:${sha256(JSON.stringify(payload))}`,
  };
}

interface FakeNativeToolchain {
  config: ToolchainConfig;
  python: string;
  gcc: string;
  helper: string;
  alternateHelper: string;
  outsideHelper: string;
  externalSpecs: string;
  sysrootFile: string;
  runQuery: (command: string, arguments_: readonly string[]) => string | Buffer;
  setQuery: (argument: string, value: string | Buffer) => void;
}

function fakeNativeToolchain(root: string): FakeNativeToolchain {
  const bin = join(root, 'bin');
  const lib = join(root, 'lib');
  const libexec = join(root, 'libexec', 'gcc', 'riscv32-esp-elf', '14.2.0');
  const sysroot = join(root, 'riscv32-esp-elf');
  const targetBin = join(sysroot, 'bin');
  const runtime = join(lib, 'gcc', 'riscv32-esp-elf', '14.2.0');
  mkdirSync(bin, { recursive: true });
  mkdirSync(libexec, { recursive: true });
  mkdirSync(targetBin, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(sysroot, 'include'), { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const tool of ['gcc', 'g++', 'gcc-ar', 'objcopy']) {
    writeFileSync(join(bin, `riscv32-esp-elf-${tool}${suffix}`), `fake-${tool}-v1`);
  }
  const helperPaths: Record<string, string> = {
    cc1: join(libexec, `cc1${suffix}`),
    cc1plus: join(libexec, `cc1plus${suffix}`),
    collect2: join(libexec, `collect2${suffix}`),
    as: join(targetBin, `as${suffix}`),
    ld: join(targetBin, `ld${suffix}`),
    ar: join(targetBin, `ar${suffix}`),
    'lto-wrapper': join(libexec, `lto-wrapper${suffix}`),
    lto1: join(libexec, `lto1${suffix}`),
  };
  for (const [role, path] of Object.entries(helperPaths)) writeFileSync(path, `fake-${role}-v1`);
  const alternateHelper = join(libexec, `cc1-alternate${suffix}`);
  writeFileSync(alternateHelper, 'fake-cc1-v1');
  const untrackedHelperDir = join(root, 'custom-helper-home');
  mkdirSync(untrackedHelperDir, { recursive: true });
  const outsideHelper = join(untrackedHelperDir, `cc1${suffix}`);
  writeFileSync(outsideHelper, 'fake-cc1-v1');
  const libgcc = join(runtime, 'libgcc.a');
  const externalSpecs = join(lib, 'specs');
  const sysrootFile = join(sysroot, 'include', 'stdint.h');
  const python = join(root, 'python3');
  writeFileSync(libgcc, 'fake-libgcc-v1');
  writeFileSync(externalSpecs, '*external_specs:\nvalue\n');
  writeFileSync(join(lib, 'libtoolchain-runtime.bin'), 'fake-runtime-v1');
  writeFileSync(sysrootFile, 'fake-sysroot-v1');
  writeFileSync(python, 'fake-python3-v1');
  const queryResults = new Map<string, string | Buffer>([
    ...Object.entries(helperPaths).map(([name, path]) => [`-print-prog-name=${name}`, `${path}\n`] as const),
    ['-print-libgcc-file-name', `${libgcc}\n`],
    ['-print-file-name=specs', 'specs\n'],
    ['-print-sysroot', `${sysroot}\n`],
    ['-dumpspecs', '*fake_specs:\n%{v:fake-v1}\n'],
  ]);
  const runQuery = (command: string, arguments_: readonly string[]) => {
    expect(command.startsWith(bin)).toBe(true);
    const result = arguments_.length === 1 ? queryResults.get(arguments_[0]!) : undefined;
    if (result === undefined) throw new Error(`unexpected fake GCC query: ${arguments_.join(' ')}`);
    return result;
  };
  return {
    config: {
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
      esp32: {
        riscvBinDir: bin,
        riscvRootDir: root,
        coreDir: join(root, 'core'),
        variantsDir: join(root, 'variants'),
        platformDir: join(root, 'platform'),
        esptool: join(root, `esptool${suffix}`),
        sdkRootFor: () => null,
      },
    },
    python,
    gcc: join(bin, `riscv32-esp-elf-gcc${suffix}`),
    helper: helperPaths.cc1,
    alternateHelper,
    outsideHelper,
    externalSpecs,
    sysrootFile,
    runQuery,
    setQuery: (argument, value) => queryResults.set(argument, value),
  };
}

function executionIdentityRequest(targetPacks: {
  targets: readonly {
    target: string;
    board: string;
    packs: readonly { role: string; id: string; revision: string; version: string; schema: number }[];
  }[];
}, python?: string) {
  const pythonInterpreter = python === undefined ? undefined : {
    command: python,
    commandSha256: sha256(readFileSync(python)),
    authorizedDirectory: dirname(python),
  };
  return {
    schema: 3,
    hostPlatform: 'linux',
    ...(pythonInterpreter === undefined ? {} : { pythonInterpreter }),
    targets: targetPacks.targets.map((target) => ({
      target: target.target,
      board: target.board,
      packs: target.packs.map(({ role, id, revision, version, schema }) => ({
        role, id, revision, version, schema,
      })),
    })),
  };
}

function writeFakePlannerPublications(root: string, wasm: string): void {
  const files = [
    { path: 'ck_build_core.js', bytes: Buffer.byteLength('fake-bindings'), sha256: sha256('fake-bindings') },
    { path: 'ck_build_core_bg.wasm', bytes: Buffer.byteLength(wasm), sha256: sha256(wasm) },
  ];
  const manifest = {
    schemaVersion: 1,
    rustToolchain: 'test-rust',
    target: 'wasm32-unknown-unknown',
    wasmBindgen: 'test-bindgen',
    files,
  };
  for (const directory of [
    'crates/ck-build-core/dist/web',
    'packages/core/wasm',
    'packages/web/public/ck-build-core-wasm',
  ]) {
    const publication = join(root, directory);
    mkdirSync(publication, { recursive: true });
    writeFileSync(join(publication, 'ck_build_core.js'), 'fake-bindings');
    writeFileSync(join(publication, 'ck_build_core_bg.wasm'), wasm);
    writeFileSync(join(publication, 'build-manifest.json'), JSON.stringify(manifest));
  }
}

function writeFakeLibraryPack(
  catalogRoot: string,
  name: string,
  version: string,
  header: string,
) {
  const slug = name.toLowerCase();
  const directory = join(catalogRoot, slug, version);
  const chunks = join(directory, 'chunks');
  mkdirSync(chunks, { recursive: true });
  const source = Buffer.from(JSON.stringify({ name, version, files: [{ path: `src/${header}`, content: '#pragma once\n' }] }));
  const sourceSha256 = sha256(source);
  const chunkName = `sources-${sourceSha256.slice(0, 16)}.bin`;
  const chunkPath = join(chunks, chunkName);
  writeFileSync(chunkPath, source);
  const manifest = {
    schema: 1,
    id: `fake-lib-${slug}`,
    version,
    revision: '0'.repeat(64),
    artifacts: [{
      id: 'sources',
      kind: 'library-source-json',
      size: source.byteLength,
      sha256: sourceSha256,
      chunks: [{
        path: `chunks/${chunkName}`,
        size: source.byteLength,
        sha256: sourceSha256,
      }],
    }],
  };
  manifest.revision = sha256(browserToolchainPackRevisionInput(manifest));
  const manifestPath = join(directory, 'toolchain.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    manifest,
    manifestPath,
    chunkPath,
    registryPack: {
      id: manifest.id,
      revision: manifest.revision,
      manifest: `${slug}/${version}/toolchain.json`,
      artifact: 'sources',
    },
  };
}

function writeFakeLibraryCatalog(root: string) {
  const catalogRoot = join(root, 'catalog');
  mkdirSync(catalogRoot, { recursive: true });
  const dependency = writeFakeLibraryPack(catalogRoot, 'Dependency', '1.0.0', 'Dependency.h');
  const selected = writeFakeLibraryPack(catalogRoot, 'Root', '1.0.0', 'Root.h');
  const unrelated = writeFakeLibraryPack(catalogRoot, 'Unrelated', '1.0.0', 'Unrelated.h');
  const rawRegistry = {
    schema: 2,
    libraries: [
      {
        name: 'Dependency',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          architectures: ['esp32'],
          publicHeaders: ['Dependency.h'],
          depends: [],
          pack: dependency.registryPack,
        }],
      },
      {
        name: 'Root',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          architectures: ['esp32'],
          publicHeaders: ['Root.h'],
          depends: [{ name: 'Dependency', version: '1.0.0' }],
          pack: selected.registryPack,
        }],
      },
      {
        name: 'Unrelated',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          architectures: ['esp32'],
          publicHeaders: ['Unrelated.h'],
          depends: [],
          pack: unrelated.registryPack,
        }],
      },
    ],
  };
  const registryPath = join(catalogRoot, 'registry.json');
  writeFileSync(registryPath, JSON.stringify(rawRegistry));
  rmSync(unrelated.chunkPath);
  const registry = validateEsp32BrowserLibraryRegistry(rawRegistry, pathToFileURL(registryPath));
  const job = {
    library: 'Root',
    version: '1.0.0',
    target: 'c3',
    board: 'esp32:esp32:esp32c3',
    header: 'Root.h',
    manifest: selected.manifestPath,
    packId: selected.manifest.id,
    packRevision: selected.manifest.revision,
    platformVersion: '3.3.7',
    fixture: { projectFiles: [], macros: {} },
    policy: null,
  };
  return { registry, job, dependency, selected };
}

function reusableNativeMatrixReport(context: Awaited<ReturnType<typeof createNativeMatrixPlan>>) {
  return {
    schema: 2,
    verificationSchema: 7,
    fingerprintScope: 'execution',
    fingerprint: context.fingerprint,
    evidence: context.evidence,
    compilerRuntime: context.compilerRuntime,
    libraryPacks: context.libraryPacks.evidence,
    integrity: {
      stable: true,
      startFingerprint: context.fingerprint,
      endFingerprint: context.fingerprint,
      startLibraryPackSetSha256: context.libraryPacks.evidence.sha256,
      endLibraryPackSetSha256: context.libraryPacks.evidence.sha256,
    },
    results: [{ key: 'cached', status: 'success' }],
  };
}

describe('CK native library matrix runner', () => {
  it('uses a separate native report scope and preserves matrix filters', () => {
    const options = nativeMatrixOptions([
      '--target', 'c3',
      '--library', 'AccelStepper',
      '--headers', 'primary',
      '--max-jobs', '2',
    ]);
    expect(options.targets).toEqual(['c3']);
    expect(options.libraries).toEqual(['AccelStepper']);
    expect(options.maxJobs).toBe(2);
    expect(options.report).toContain('ck-native-library-matrix.json');
  });

  it('plans from the committed WASM before the three-copy publication exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-planner-contract-'));
    try {
      writeFakePlannerPublications(root, 'fake-wasm');
      rmSync(join(root, 'crates', 'ck-build-core', 'dist'), { recursive: true, force: true });

      const committed = await readCommittedPlannerPublicationIdentity(root);
      expect(committed.publications).toEqual([
        expect.objectContaining({ id: 'core-wasm', manifest: 'packages/core/wasm/build-manifest.json' }),
      ]);
      await expect(readPlannerPublicationIdentity(root)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards fixture files and macros through the versioned request envelope', () => {
    const job = {
      library: 'Example',
      version: '1.0.0',
      manifest: 'packs/example/toolchain.json',
      packId: 'library:example',
      packRevision: 'a'.repeat(64),
      header: 'Example.h',
      target: 'c3',
      fixture: {
        projectFiles: [{ name: 'lv_conf.h', content: '#define LV_COLOR_DEPTH 16\n' }],
        macros: { LV_KCONFIG_IGNORE: true, LV_CONF_PATH: '"lv_conf.h"' },
      },
    };
    const snapshotRoot = join(tmpdir(), 'ck-native-request-snapshot');
    const request = createNativeVerifierRequest(job, {
      libraryPackSnapshot: {
        root: snapshotRoot,
        descriptor: join(snapshotRoot, 'snapshots', 'b'.repeat(64), 'snapshot.json'),
        closureSha256: 'b'.repeat(64),
        rootIdentity: {
          library: 'Example',
          version: '1.0.0',
          packId: 'library:example',
          revision: 'a'.repeat(64),
          artifact: 'sources',
        },
      },
    });
    expect(request).toMatchObject({
      schema: 2,
      snapshot: {
        root: snapshotRoot,
        closureSha256: 'b'.repeat(64),
      },
      expectedRoot: {
        library: 'Example',
        version: '1.0.0',
        packId: 'library:example',
        revision: 'a'.repeat(64),
        artifact: 'sources',
      },
      header: 'Example.h',
      target: 'c3',
      projectFiles: [{ name: 'lv_conf.h', content: '#define LV_COLOR_DEPTH 16\n' }],
      macros: { LV_KCONFIG_IGNORE: true, LV_CONF_PATH: '"lv_conf.h"' },
    });
    expect(nativeVerifierArguments('request.json')).toEqual([
      expect.stringContaining('verify-ck-native-library-pack.ts'),
      '--request-file',
      'request.json',
    ]);
  });

  it('creates a deterministic Registry-backed plan without compiling', async () => {
    const options = nativeMatrixOptions([
      '--target', 'c3',
      '--library', 'AccelStepper',
      '--max-jobs', '1',
    ]);
    let queried = false;
    let fingerprintedPack = false;
    const context = await createNativeMatrixPlan(options, {
      nativeClosureOptions: {
        runQuery: () => {
          queried = true;
          throw new Error('plan-only must not query native tools');
        },
      },
      libraryPackFingerprintOptions: {
        fingerprintPack: async () => {
          fingerprintedPack = true;
          throw new Error('plan-only must not read Library Pack payloads');
        },
      },
    });
    expect(context.plan.unsharded).toBe(1);
    expect(context.plan.jobs).toHaveLength(1);
    expect(context.plan.jobs[0]).toMatchObject({
      library: 'AccelStepper',
      version: '1.64.0',
      target: 'c3',
      header: 'AccelStepper.h',
    });
    expect(context.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(context.fingerprintScope).toBe('planning');
    expect(context.evidence.nativeTools).toMatchObject({ status: 'not-probed', reason: 'plan-only' });
    expect(context.libraryPacks.evidence).toMatchObject({ status: 'not-probed', reason: 'plan-only' });
    expect(context.compilerRuntime).toMatchObject({
      trust: 'unverified-local',
      runtimeIdentity: 'unverified-local',
    });
    expect(queried).toBe(false);
    expect(fingerprintedPack).toBe(false);
  });

  it('binds resume to a canonical compiler runtime release and rejects a forged releaseId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-runtime-release-'));
    try {
      const path = join(root, 'compiler-runtime-release.json');
      const firstRelease = compilerRuntimeRelease('1');
      writeFileSync(path, `${JSON.stringify(firstRelease, null, 2)}\n`);
      const first = await readCompilerRuntimeReleaseIdentity(path);
      expect(first).toMatchObject({
        trust: 'accepted',
        runtimeIdentity: firstRelease.releaseId,
        manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        hostExecution: {
          runtimeIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });

      const secondRelease = compilerRuntimeRelease('4');
      writeFileSync(path, `${JSON.stringify(secondRelease, null, 2)}\n`);
      const second = await readCompilerRuntimeReleaseIdentity(path);
      expect(second.runtimeIdentity).not.toBe(first.runtimeIdentity);
      expect(second.sha256).not.toBe(first.sha256);
      const matrixOptions = nativeMatrixOptions([
        '--plan',
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const firstPlan = await createNativeMatrixPlan(matrixOptions, { compilerRuntimeIdentity: first });
      const secondPlan = await createNativeMatrixPlan(matrixOptions, { compilerRuntimeIdentity: second });
      expect(firstPlan.evidence.compilerRuntime).toEqual(first);
      expect(secondPlan.fingerprint).not.toBe(firstPlan.fingerprint);
      expect(nativeLibraryMatrixJobFingerprint(
        secondPlan.fingerprint,
        secondPlan.plan.jobs[0],
        'a'.repeat(64),
      )).not.toBe(nativeLibraryMatrixJobFingerprint(
        firstPlan.fingerprint,
        firstPlan.plan.jobs[0],
        'a'.repeat(64),
      ));

      const baseContext = {
        fingerprintScope: 'execution',
        fingerprint: first.sha256,
        compilerRuntime: first,
        evidence: {
          sha256: first.sha256,
          compilerRuntime: first,
          planner: { artifactSetSha256: '1'.repeat(64) },
          targetPacks: { sha256: '2'.repeat(64) },
          nativeTools: { sha256: '3'.repeat(64) },
        },
        libraryPacks: { evidence: { schema: 2, status: 'verified', sha256: '4'.repeat(64) } },
      };
      const previous = {
        schema: 2,
        verificationSchema: 7,
        fingerprintScope: 'execution',
        fingerprint: baseContext.fingerprint,
        compilerRuntime: first,
        evidence: baseContext.evidence,
        libraryPacks: baseContext.libraryPacks.evidence,
        integrity: {
          stable: true,
          startFingerprint: baseContext.fingerprint,
          endFingerprint: baseContext.fingerprint,
          startLibraryPackSetSha256: baseContext.libraryPacks.evidence.sha256,
          endLibraryPackSetSha256: baseContext.libraryPacks.evidence.sha256,
        },
        results: [{ key: 'cached', status: 'success' }],
      };
      expect(selectReusableNativeResults(previous, baseContext)).toHaveLength(1);
      expect(selectReusableNativeResults(previous, {
        ...baseContext,
        fingerprint: second.sha256,
        compilerRuntime: second,
        evidence: { ...baseContext.evidence, sha256: second.sha256, compilerRuntime: second },
      })).toEqual([]);

      writeFileSync(path, `${JSON.stringify({
        ...secondRelease,
        releaseId: `sha256:${'f'.repeat(64)}`,
      }, null, 2)}\n`);
      await expect(readCompilerRuntimeReleaseIdentity(path)).rejects.toThrow(/release id mismatch/);
      await expect(readCompilerRuntimeReleaseIdentity(undefined, { requireAccepted: true }))
        .rejects.toThrow(/requires --runtime-release-manifest/);
      await expect(runNativeVerifier({ library: 'Root', version: '1.0.0', header: 'Root.h', target: 'c3' }, {
        compilerRuntime: {
          trust: 'unverified-local',
          runtimeIdentity: 'unverified-local',
        },
      })).rejects.toThrow(/requires accepted SHA-256 runtime identities/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('content-addresses each selected job recursive local Library Pack closure', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'ck-native-library-packs-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'ck-native-library-packs-b-'));
    try {
      const firstCatalog = writeFakeLibraryCatalog(firstRoot);
      const secondCatalog = writeFakeLibraryCatalog(secondRoot);
      const first = await createNativeLibraryPackClosureEvidence(
        firstCatalog.registry,
        [firstCatalog.job],
        {
          concurrency: 2,
          allowedRoot: firstRoot,
          snapshotRoot: join(firstRoot, 'snapshots'),
        },
      );
      const relocated = await createNativeLibraryPackClosureEvidence(
        secondCatalog.registry,
        [secondCatalog.job],
        {
          concurrency: 2,
          allowedRoot: secondRoot,
          snapshotRoot: join(secondRoot, 'snapshots'),
        },
      );
      expect(first.evidence).toMatchObject({
        status: 'verified',
        jobCount: 1,
        packCount: 2,
      });
      expect(first.jobs[0]).toMatchObject({ packCount: 2 });
      expect(first.packs).toHaveLength(2);
      expect(first.packs.every((pack) => (
        pack.manifest.sha256 === sha256(readFileSync(
          pack.id === firstCatalog.dependency.manifest.id
            ? firstCatalog.dependency.manifestPath
            : firstCatalog.selected.manifestPath,
        ))
        && pack.artifact.sha256 === pack.artifact.chunks[0]?.decodedSha256
      ))).toBe(true);
      expect(relocated.evidence.sha256).toBe(first.evidence.sha256);
      expect(relocated.jobs[0]?.sha256).toBe(first.jobs[0]?.sha256);
      expect(JSON.stringify(first)).not.toContain(firstRoot);

      const globalFingerprint = 'a'.repeat(64);
      const originalJobFingerprint = nativeLibraryMatrixJobFingerprint(
        globalFingerprint,
        firstCatalog.job,
        first.jobs[0]!.sha256,
      );
      const dependencyManifest = JSON.parse(readFileSync(firstCatalog.dependency.manifestPath, 'utf8'));
      writeFileSync(firstCatalog.dependency.manifestPath, `${JSON.stringify(dependencyManifest, null, 2)}\n`);
      const manifestChanged = await createNativeLibraryPackClosureEvidence(
        firstCatalog.registry,
        [firstCatalog.job],
        {
          allowedRoot: firstRoot,
          snapshotRoot: join(firstRoot, 'changed-snapshots'),
        },
      );
      expect(manifestChanged.jobs[0]?.sha256).not.toBe(first.jobs[0]?.sha256);
      expect(nativeLibraryMatrixJobFingerprint(
        globalFingerprint,
        firstCatalog.job,
        manifestChanged.jobs[0]!.sha256,
      )).not.toBe(originalJobFingerprint);

      writeFileSync(
        firstCatalog.dependency.chunkPath,
        Buffer.alloc(readFileSync(firstCatalog.dependency.chunkPath).byteLength, 0x78),
      );
      await expect(createNativeLibraryPackClosureEvidence(
        firstCatalog.registry,
        [firstCatalog.job],
        {
          allowedRoot: firstRoot,
          snapshotRoot: join(firstRoot, 'invalid-snapshots'),
        },
      )).rejects.toThrow(/chunk checksum mismatch/);
      await expect(createNativeLibraryPackClosureEvidence(
        secondCatalog.registry,
        [secondCatalog.job],
        {
          concurrency: 5,
          allowedRoot: secondRoot,
          snapshotRoot: join(secondRoot, 'snapshots'),
        },
      )).rejects.toThrow(/concurrency must be 1\.\.4/);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('executes from the immutable snapshot across a source swap and restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-library-snapshot-'));
    try {
      const catalog = writeFakeLibraryCatalog(root);
      const closure = await createNativeLibraryPackClosureEvidence(
        catalog.registry,
        [catalog.job],
        {
          allowedRoot: root,
          snapshotRoot: join(root, 'snapshots'),
        },
      );
      const jobClosure = closure.jobs[0]!;
      const snapshot = closure.snapshots.get(jobClosure.sha256)!;
      const request = createNativeVerifierRequest(catalog.job, { libraryPackSnapshot: snapshot });
      const originalManifest = readFileSync(catalog.selected.manifestPath);
      const originalChunk = readFileSync(catalog.selected.chunkPath);

      writeFileSync(catalog.selected.manifestPath, '{"temporary":"replacement"}');
      writeFileSync(catalog.selected.chunkPath, 'temporary replacement');
      const loaded = await loadNativeLibraryPackSnapshot(request, {
        expectedClosureSha256: jobClosure.sha256,
        expectedSnapshotRoot: snapshot.root,
      });
      writeFileSync(catalog.selected.manifestPath, originalManifest);
      writeFileSync(catalog.selected.chunkPath, originalChunk);

      expect(loaded.closureSha256).toBe(jobClosure.sha256);
      expect(loaded.rootIdentity).toEqual({
        library: 'Root',
        version: '1.0.0',
        packId: catalog.selected.manifest.id,
        revision: catalog.selected.manifest.revision,
        artifact: 'sources',
      });
      expect(loaded.source).toMatchObject({ name: 'Root', version: '1.0.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a request whose expected root identity differs from its snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-library-root-identity-'));
    try {
      const catalog = writeFakeLibraryCatalog(root);
      const closure = await createNativeLibraryPackClosureEvidence(
        catalog.registry,
        [catalog.job],
        {
          allowedRoot: root,
          snapshotRoot: join(root, 'snapshots'),
        },
      );
      const jobClosure = closure.jobs[0]!;
      const snapshot = closure.snapshots.get(jobClosure.sha256)!;
      const request = createNativeVerifierRequest(catalog.job, { libraryPackSnapshot: snapshot });

      for (const expectedRoot of [
        { ...request.expectedRoot, library: 'DifferentRoot' },
        { ...request.expectedRoot, version: '9.9.9' },
        { ...request.expectedRoot, packId: 'fake-lib-different' },
        { ...request.expectedRoot, revision: 'f'.repeat(64) },
        { ...request.expectedRoot, artifact: 'different-sources' },
      ]) {
        await expect(loadNativeLibraryPackSnapshot({ ...request, expectedRoot }, {
          expectedClosureSha256: jobClosure.sha256,
          expectedSnapshotRoot: snapshot.root,
        })).rejects.toThrow(/root identity mismatch/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on UNC authority, linked paths, and paths outside the allowed root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-library-local-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'ck-native-library-outside-'));
    try {
      const outsideFile = join(outside, 'toolchain.json');
      writeFileSync(outsideFile, '{}');
      await expect(assertNativeLibraryLocalFileUrl(
        new URL('file://matrix-share/catalog/toolchain.json'),
        root,
        'test manifest',
      )).rejects.toThrow(/authority/);
      await expect(assertNativeLibraryLocalFileUrl(
        pathToFileURL(outsideFile),
        root,
        'test manifest',
      )).rejects.toThrow(/outside allowed root/);

      const linkedDirectory = join(root, 'linked');
      try {
        symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        await expect(assertNativeLibraryLocalFileUrl(
          pathToFileURL(join(linkedDirectory, 'toolchain.json')),
          root,
          'test manifest',
        )).rejects.toThrow(/symbolic link|junction|reparse|canonical/);
      } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('uses one deny-by-default GCC environment policy for queries and verifier children', () => {
    const toolDirectory = join(tmpdir(), 'ck-native-authorized-bin');
    const source = {
      ARDUINO15_DIR: join(tmpdir(), 'arduino-data'),
      SystemRoot: 'C:\\Windows',
      CPATH: 'host-cpath-a',
      CPLUS_INCLUDE_PATH: 'host-cxx-path',
      C_INCLUDE_PATH: 'host-c-path',
      OBJC_INCLUDE_PATH: 'host-objc-path',
      LIBRARY_PATH: 'host-library-path',
      COMPILER_PATH: 'host-compiler-path',
      GCC_EXEC_PREFIX: 'host-gcc-prefix',
      GCC_FAKE_CONTROL: 'host-gcc-control',
      COLLECT_GCC_OPTIONS: 'host-collect-options',
      NODE_OPTIONS: '--require=host-hook',
      PYTHONPATH: 'host-python-path',
      CK_NATIVE_PYTHON: 'host-python-command',
      PATH: 'host-path',
    };
    const environment = createNativeExecutionEnvironment(source, { toolDirectories: [toolDirectory] });
    for (const name of [
      'CPATH',
      'CPLUS_INCLUDE_PATH',
      'C_INCLUDE_PATH',
      'OBJC_INCLUDE_PATH',
      'LIBRARY_PATH',
      'COMPILER_PATH',
      'GCC_EXEC_PREFIX',
      'GCC_FAKE_CONTROL',
      'COLLECT_GCC_OPTIONS',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'CK_NATIVE_PYTHON',
    ]) expect(environment[name]).toBeUndefined();
    expect(environment).toMatchObject({
      ARDUINO15_DIR: source.ARDUINO15_DIR,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
    });
    expect(environment.PATH).toContain(toolDirectory);
    expect(environment.PATH).not.toContain('host-path');

    const first = createNativeExecutionEnvironmentEvidence(source);
    const dangerousChanged = createNativeExecutionEnvironmentEvidence({
      ...source,
      CPATH: 'host-cpath-b',
      GCC_FAKE_CONTROL: 'changed',
      NODE_OPTIONS: '--require=other-hook',
    });
    const allowedChanged = createNativeExecutionEnvironmentEvidence({
      ...source,
      ARDUINO15_DIR: join(tmpdir(), 'other-arduino-data'),
    });
    expect(dangerousChanged).toEqual(first);
    expect(allowedChanged.sha256).not.toBe(first.sha256);
    expect(first).toMatchObject({
      schema: 2,
      policy: 'ck-native-gcc-python-hermetic-environment-v2',
      default: 'deny',
      fixed: {
        PATH: 'authorized-tool-directories-plus-windows-system32',
        TEMP: 'workspace:var/tmp',
      },
    });
  });

  it('resolves an absolute Python interpreter before PATH is sanitized', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-python-resolve-'));
    try {
      const bin = join(root, 'bin');
      const python = join(bin, 'python3');
      mkdirSync(bin, { recursive: true });
      writeFileSync(python, 'fake-python-resolver-v1');
      const resolved = await resolveNativePythonInterpreter({ PATH: bin }, 'linux');
      expect(resolved).toEqual({
        command: python,
        commandSha256: sha256('fake-python-resolver-v1'),
        authorizedDirectory: bin,
      });
      await expect(resolveNativePythonInterpreter({ CK_NATIVE_PYTHON: 'python3', PATH: bin }, 'linux'))
        .rejects.toThrow(/absolute path/);
      await expect(resolveNativePythonInterpreter({ PATH: join(root, 'missing') }, 'linux'))
        .rejects.toThrow(/requires an explicit python3 interpreter/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not bind blocked GCC search variables into the Matrix fingerprint', async () => {
    const options = nativeMatrixOptions([
      '--target', 'c3',
      '--library', 'AccelStepper',
      '--max-jobs', '1',
    ]);
    const previous = process.env.CPATH;
    try {
      process.env.CPATH = 'C:\\ck-native-cpath-a';
      const first = await createNativeMatrixPlan(options);
      process.env.CPATH = 'C:\\ck-native-cpath-b';
      const second = await createNativeMatrixPlan(options);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.evidence.executionEnvironment.sha256).toBe(first.evidence.executionEnvironment.sha256);
    } finally {
      if (previous === undefined) delete process.env.CPATH;
      else process.env.CPATH = previous;
    }
  });

  it('does not inherit Browser-only FastLED, NeoGPS, or LVGL policy exclusions', async () => {
    const options = nativeMatrixOptions([
      '--target', 'c3',
      '--library', 'FastLED',
      '--library', 'NeoGPS',
      '--library', 'lvgl',
    ]);
    const context = await createNativeMatrixPlan(options);
    expect(context.plan.unsharded).toBe(4);
    expect(context.plan.jobs).toHaveLength(4);
    expect(context.plan.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ library: 'FastLED', version: '3.10.5', policy: null }),
      expect.objectContaining({ library: 'NeoGPS', version: '4.2.9', policy: null }),
      expect.objectContaining({ library: 'lvgl', version: '9.5.0', policy: null }),
    ]));
    expect(context.plan.jobs.every((job) => job.policy === null)).toBe(true);
  });

  it('invalidates resume when a fake native compiler binary changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-matrix-identity-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const toolchain = fakeNativeToolchain(root);
      const { config, gcc } = toolchain;
      const request = executionIdentityRequest(planning.evidence.targetPacks, toolchain.python);
      const firstIdentity = createNativeExecutionIdentity(request, config);
      const first = await createNativeMatrixPlan(options, {
        nativeExecutionIdentity: firstIdentity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      });
      expect(first.fingerprintScope).toBe('execution');
      expect(first.evidence.nativeTools.targets[0]?.tools).toHaveLength(4);
      expect(first.evidence.nativeTools.targets[0]?.closure.helpers).toHaveLength(8);
      const previous = reusableNativeMatrixReport(first);
      expect(selectReusableNativeResults(previous, first)).toHaveLength(1);
      expect(selectReusableNativeResults({ ...previous, verificationSchema: 3 }, first)).toEqual([]);
      expect(selectReusableNativeResults({ ...previous, integrity: undefined }, first)).toEqual([]);
      expect(selectReusableNativeResults({
        ...previous,
        integrity: { ...previous.integrity, stable: false },
      }, first)).toEqual([]);
      expect(selectReusableNativeResults({
        ...previous,
        integrity: { ...previous.integrity, endFingerprint: sha256('mismatch') },
      }, first)).toEqual([]);

      writeFileSync(gcc, 'fake-gcc-v2');
      const secondIdentity = createNativeExecutionIdentity(request, config);
      const second = await createNativeMatrixPlan(options, {
        nativeExecutionIdentity: secondIdentity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      });
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(second.evidence.nativeTools.sha256).not.toBe(first.evidence.nativeTools.sha256);
      expect(selectReusableNativeResults(previous, second)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates resume when the explicitly bound Python interpreter changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-matrix-python-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const toolchain = fakeNativeToolchain(root);
      const firstRequest = executionIdentityRequest(planning.evidence.targetPacks, toolchain.python);
      const firstIdentity = createNativeExecutionIdentity(firstRequest, toolchain.config);
      const first = await createNativeMatrixPlan(options, {
        nativeExecutionIdentity: firstIdentity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      });
      const previous = reusableNativeMatrixReport(first);

      writeFileSync(toolchain.python, 'fake-python3-v2');
      const secondRequest = executionIdentityRequest(planning.evidence.targetPacks, toolchain.python);
      const secondIdentity = createNativeExecutionIdentity(secondRequest, toolchain.config);
      const second = await createNativeMatrixPlan(options, {
        nativeExecutionIdentity: secondIdentity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      });
      expect(second.evidence.nativeTools.targets[0]?.pythonInterpreter.sha256)
        .not.toBe(first.evidence.nativeTools.targets[0]?.pythonInterpreter.sha256);
      expect(second.evidence.nativeTools.sha256).not.toBe(first.evidence.nativeTools.sha256);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(selectReusableNativeResults(previous, second)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects target Python bindings that drift from the signed identity document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-matrix-python-binding-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const toolchain = fakeNativeToolchain(root);
      const identity = createNativeExecutionIdentity(
        executionIdentityRequest(planning.evidence.targetPacks, toolchain.python),
        toolchain.config,
      );
      const target = identity.targets[0]!;
      const alternatePython = join(root, 'python3-alternate');
      writeFileSync(alternatePython, 'fake-python3-alternate');
      const drifted = {
        ...identity,
        targets: [{
          ...target,
          pythonInterpreter: {
            command: alternatePython,
            commandSha256: sha256(readFileSync(alternatePython)),
            authorizedDirectory: dirname(alternatePython),
          },
        }],
      };
      await expect(createNativeMatrixPlan(options, {
        nativeExecutionIdentity: drifted,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      })).rejects.toThrow('Python binding mismatch');

      const invalidShape = {
        ...identity,
        targets: [{ ...target, mode: 'unrecognized-native-identity-mode' }],
      };
      await expect(createNativeMatrixPlan(options, {
        nativeExecutionIdentity: invalidShape,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      })).rejects.toThrow('mismatched target');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates resume when a helper, builtin specs, or sysroot content changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-matrix-closure-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const toolchain = fakeNativeToolchain(root);
      const request = executionIdentityRequest(planning.evidence.targetPacks, toolchain.python);
      const identity = createNativeExecutionIdentity(request, toolchain.config);
      const plan = () => createNativeMatrixPlan(options, {
        nativeExecutionIdentity: identity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      });
      const first = await plan();
      const previous = reusableNativeMatrixReport(first);

      writeFileSync(toolchain.helper, 'fake-cc1-v2');
      const helperChanged = await plan();
      expect(helperChanged.fingerprint).not.toBe(first.fingerprint);
      expect(selectReusableNativeResults(previous, helperChanged)).toEqual([]);

      toolchain.setQuery('-dumpspecs', '*fake_specs:\n%{v:fake-v2}\n');
      const specsChanged = await plan();
      expect(specsChanged.fingerprint).not.toBe(helperChanged.fingerprint);
      expect(selectReusableNativeResults(previous, specsChanged)).toEqual([]);

      writeFileSync(toolchain.sysrootFile, 'fake-sysroot-v2');
      const sysrootChanged = await plan();
      expect(sysrootChanged.fingerprint).not.toBe(specsChanged.fingerprint);
      expect(selectReusableNativeResults(previous, sysrootChanged)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds GCC query results to controlled tree locators and rejects untracked subtrees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-matrix-locators-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const toolchain = fakeNativeToolchain(root);
      const identity = createNativeExecutionIdentity(
        executionIdentityRequest(planning.evidence.targetPacks, toolchain.python),
        toolchain.config,
      );
      const target = identity.targets[0]!;
      const first = await createNativeToolchainClosure(target, { runQuery: toolchain.runQuery });
      const firstHelper = first.helpers.find((helper: { role: string }) => helper.role === 'helper:cc1')!;
      expect(firstHelper).toMatchObject({
        treeRole: 'tree:libexec',
        bytes: Buffer.byteLength('fake-cc1-v1'),
        sha256: sha256('fake-cc1-v1'),
      });
      expect(firstHelper.path).toContain('cc1');
      expect(first.runtimeFiles[0]).toMatchObject({
        role: 'runtime:libgcc',
        treeRole: 'tree:lib',
      });
      toolchain.setQuery('-print-file-name=specs', `${toolchain.externalSpecs}\n`);
      const withExternalSpecs = await createNativeToolchainClosure(target, { runQuery: toolchain.runQuery });
      expect(withExternalSpecs.specs.externalDefault).toMatchObject({
        status: 'present',
        treeRole: 'tree:lib',
        path: 'specs',
      });

      toolchain.setQuery('-print-prog-name=cc1', `${toolchain.alternateHelper}\n`);
      const moved = await createNativeToolchainClosure(target, { runQuery: toolchain.runQuery });
      const movedHelper = moved.helpers.find((helper: { role: string }) => helper.role === 'helper:cc1')!;
      expect(movedHelper.sha256).toBe(firstHelper.sha256);
      expect(movedHelper.path).not.toBe(firstHelper.path);
      expect(moved.sha256).not.toBe(first.sha256);

      toolchain.setQuery('-print-prog-name=cc1', `${toolchain.outsideHelper}\n`);
      await expect(createNativeToolchainClosure(target, {
        runQuery: toolchain.runQuery,
      })).rejects.toThrow('outside controlled closure trees');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps execution fingerprints independent of absolute installation paths', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'ck-native-path-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'ck-native-path-b-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const firstToolchain = fakeNativeToolchain(firstRoot);
      const secondToolchain = fakeNativeToolchain(secondRoot);
      const request = executionIdentityRequest(planning.evidence.targetPacks, firstToolchain.python);
      const firstIdentity = createNativeExecutionIdentity(request, firstToolchain.config);
      const secondIdentity = createNativeExecutionIdentity(request, secondToolchain.config);
      expect(firstIdentity.sha256).not.toBe(secondIdentity.sha256);

      const first = await createNativeMatrixPlan(options, {
        nativeExecutionIdentity: firstIdentity,
        nativeClosureOptions: { runQuery: firstToolchain.runQuery },
      });
      const second = await createNativeMatrixPlan(options, {
        nativeExecutionIdentity: secondIdentity,
        nativeClosureOptions: { runQuery: secondToolchain.runQuery },
      });
      expect(second.evidence.nativeTools.sha256).toBe(first.evidence.nativeTools.sha256);
      expect(second.fingerprint).toBe(first.fingerprint);
      const serialized = JSON.stringify(first.evidence.nativeTools);
      expect(serialized).not.toContain(firstRoot);
      expect(serialized).not.toContain('command');
      expect(first.nativeExecutionAuthorization.targets[0]?.sha256).toBe(firstIdentity.targets[0]?.sha256);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on missing or ambiguous GCC closure queries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-query-fail-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      const planning = await createNativeMatrixPlan(options);
      const toolchain = fakeNativeToolchain(root);
      const identity = createNativeExecutionIdentity(
        executionIdentityRequest(planning.evidence.targetPacks, toolchain.python),
        toolchain.config,
      );
      toolchain.setQuery('-print-prog-name=cc1', 'cc1\nsecond-result\n');
      await expect(createNativeMatrixPlan(options, {
        nativeExecutionIdentity: identity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      })).rejects.toThrow('missing or ambiguous output');

      toolchain.setQuery('-print-prog-name=cc1', join(root, 'missing-cc1'));
      await expect(createNativeMatrixPlan(options, {
        nativeExecutionIdentity: identity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      })).rejects.toThrow();

      toolchain.setQuery('-print-prog-name=cc1', `${toolchain.helper}\n`);
      toolchain.setQuery('-print-prog-name=cc1plus', `${toolchain.helper}\n`);
      await expect(createNativeMatrixPlan(options, {
        nativeExecutionIdentity: identity,
        nativeClosureOptions: { runQuery: toolchain.runQuery },
      })).rejects.toThrow('helper resolution is ambiguous');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces bounded file and byte traversal for closure trees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-limit-'));
    try {
      const toolchain = fakeNativeToolchain(root);
      const planning = await createNativeMatrixPlan(nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]));
      const identity = createNativeExecutionIdentity(
        executionIdentityRequest(planning.evidence.targetPacks, toolchain.python),
        toolchain.config,
      );
      const target = identity.targets[0]!;

      await expect(createNativeToolchainClosure(target, {
        runQuery: toolchain.runQuery,
        limits: { maxTreeFiles: 1 },
      })).rejects.toThrow('tree file limit');
      await expect(createNativeToolchainClosure(target, {
        runQuery: toolchain.runQuery,
        limits: { maxTotalBytes: 8 },
      })).rejects.toThrow('total byte limit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds fingerprints to validated Rust/WASM planner publication bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-planner-identity-'));
    try {
      const options = nativeMatrixOptions([
        '--target', 'c3',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]);
      writeFakePlannerPublications(root, 'fake-wasm-v1');
      const firstPlanner = await readPlannerPublicationIdentity(root);
      const first = await createNativeMatrixPlan(options, { plannerIdentity: firstPlanner });

      writeFileSync(
        join(root, 'packages/web/public/ck-build-core-wasm/ck_build_core_bg.wasm'),
        'tampered-without-manifest-update',
      );
      await expect(readPlannerPublicationIdentity(root)).rejects.toThrow('file identity mismatch');

      writeFakePlannerPublications(root, 'fake-wasm-v2');
      const secondPlanner = await readPlannerPublicationIdentity(root);
      const second = await createNativeMatrixPlan(options, { plannerIdentity: secondPlanner });
      expect(secondPlanner.artifactSetSha256).not.toBe(firstPlanner.artifactSetSha256);
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.CK_NATIVE_REAL_CLOSURE_PROBE === '1')(
    'probes the installed five-target execution closure without compiling',
    async () => {
      const context = await createNativeMatrixPlan(nativeMatrixOptions([
        '--target', 'all',
        '--library', 'AccelStepper',
        '--max-jobs', '1',
      ]), { requireNativeTools: true });
      expect(context.fingerprintScope).toBe('execution');
      expect(context.evidence.nativeTools.targets).toHaveLength(5);
      expect(JSON.stringify(context.evidence.nativeTools)).not.toContain('command');
      for (const target of context.evidence.nativeTools.targets) {
        expect(target.tools).toHaveLength(4);
        expect(target.closure.helpers).toHaveLength(8);
        expect(target.closure.trees.map((tree: { role: string }) => tree.role)).toEqual([
          'tree:bin',
          'tree:lib',
          'tree:libexec',
          'tree:sysroot',
        ]);
      }
      console.log(JSON.stringify({
        identitySha256: context.evidence.nativeTools.sha256,
        targets: context.evidence.nativeTools.targets.map((target) => ({
          target: target.target,
          closureSha256: target.closure.sha256,
          trees: target.closure.trees,
        })),
      }, null, 2));
    },
    600_000,
  );
});
