import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import dockerIgnore from '@balena/dockerignore';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { describe, expect, it } from 'vitest';
import { auditCkActiveRelease } from '../../../scripts/audit-ck-active-release.mjs';
import {
  auditGatewayDockerContext,
  collectGatewayModuleClosure,
  createGatewayDockerignore,
  createGatewayStaticManifest,
  stageGatewayStaticFiles,
} from '../../../scripts/stage-gateway-public.mjs';
import {
  isRetiredStaticPath,
  registerRetiredStaticPathGuard,
  setStaticHeaders,
} from '../src/static-headers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface DockerInstruction {
  value: string;
  index: number;
}

interface DockerStage {
  name: string;
  instructions: DockerInstruction[];
}

interface CopyInstruction extends DockerInstruction {
  from?: string;
  sources: string[];
  destination: string;
}

interface BrowserReleaseLayout {
  schema: number;
  avr: {
    version: string;
    sourceFiles: string[];
    toolchainFiles: string[];
    toolFiles: string[];
  };
  esp32Shared: {
    version: string;
    files: string[];
  };
}

interface GatewayStaticManifest {
  schema: number;
  policy: string;
  release: {
    compilerArtifacts: number;
    compilerChunks: number;
  };
  counts: {
    sourceFiles: number;
    generatedAvrFiles: number;
    totalFiles: number;
  };
  sourceFiles: string[];
  generatedAvrFiles: string[];
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8').replaceAll('\r\n', '\n');
}

function parseDockerfile(source: string): DockerStage[] {
  const logicalLines: string[] = [];
  let current = '';

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!current && (!line || line.startsWith('#'))) continue;
    current = `${current} ${line}`.trim();
    if (current.endsWith('\\')) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    logicalLines.push(current);
    current = '';
  }
  if (current) throw new Error('unterminated Dockerfile continuation');

  const stages: DockerStage[] = [];
  for (const [index, value] of logicalLines.entries()) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?$/i.exec(value);
    if (from) {
      stages.push({ name: from[1]?.toLowerCase() ?? `stage-${stages.length}`, instructions: [] });
      continue;
    }
    const stage = stages.at(-1);
    if (!stage) throw new Error(`Dockerfile instruction precedes FROM: ${value}`);
    stage.instructions.push({ value, index });
  }
  return stages;
}

function parseCopy(instruction: DockerInstruction): CopyInstruction | null {
  if (!/^COPY\s+/i.test(instruction.value)) return null;
  const tokens = instruction.value.slice(5).trim().split(/\s+/);
  let from: string | undefined;
  while (tokens[0]?.startsWith('--')) {
    const option = tokens.shift();
    const match = /^--from=(.+)$/i.exec(option ?? '');
    if (match) from = match[1].toLowerCase();
  }
  if (tokens.length < 2) throw new Error(`unsupported COPY instruction: ${instruction.value}`);
  const destination = normalizePath(tokens.pop() ?? '');
  return {
    ...instruction,
    from,
    sources: tokens.map(normalizePath),
    destination,
  };
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized || '.';
}

function coversPath(source: string, target: string): boolean {
  const normalizedSource = normalizePath(source);
  const normalizedTarget = normalizePath(target);
  return normalizedSource === '.'
    || normalizedTarget === normalizedSource
    || normalizedTarget.startsWith(`${normalizedSource}/`);
}

function rootRelativeInputs(source: string): string[] {
  return [...source.matchAll(/(?:resolve|join)\(\s*root\s*,([^)]+)\)/g)].map((match) => {
    const segments = [...match[1].matchAll(/'([^']+)'/g)].map((segment) => segment[1]);
    if (!segments.length) throw new Error(`unsupported root-relative build input: ${match[0]}`);
    return segments.join('/');
  });
}

function isIgnored(path: string, matcher: ReturnType<typeof dockerIgnore>): boolean {
  return matcher.ignores(normalizePath(path).replace(/^\//, ''));
}

function walkFiles(root: string, prefix = ''): Array<{ path: string; size: number }> {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkFiles(root, path);
    if (!entry.isFile()) throw new Error(`unexpected public filesystem entry: ${path}`);
    return [{ path, size: lstatSync(join(root, ...path.split('/'))).size }];
  });
}

function simulatedGatewayAvrFiles(layout: BrowserReleaseLayout): Set<string> {
  const avrRoot = `avr/${layout.avr.version}`;
  const sharedRoot = `avr/${layout.esp32Shared.version}`;
  return new Set([
    ...layout.avr.sourceFiles.map((file) => `${avrRoot}/${file}`),
    ...layout.avr.toolchainFiles.map((file) => `${avrRoot}/${file}`),
    ...layout.avr.toolFiles.map((file) => `${avrRoot}/tools/${file}`),
    `${avrRoot}/preprocess.js`,
    `${avrRoot}/THIRD_PARTY_NOTICES.md`,
    `${avrRoot}/WASM_SHA256SUMS`,
    `${avrRoot}/toolchain.json`,
    `${avrRoot}/platform.json`,
    `${avrRoot}/board.json`,
    `${avrRoot}/release.js`,
    `${avrRoot}/assets/manifest.json`,
    ...layout.esp32Shared.files.map((file) => `${sharedRoot}/${file}`),
  ]);
}

describe('gateway static release Docker contract', () => {
  const dockerfile = readRepoFile('docker/Dockerfile.gateway');
  const baseDockerignore = readRepoFile('.dockerignore');
  const gatewayDockerignoreSource = readRepoFile('docker/Dockerfile.gateway.dockerignore');
  const dockerignore = dockerIgnore({ ignorecase: false }).add(gatewayDockerignoreSource);
  const checkedAllowlist = JSON.parse(
    readRepoFile('docker/gateway-static-allowlist.json'),
  ) as GatewayStaticManifest;
  const buildScript = readRepoFile('scripts/build-browser-avr.mjs');
  const stagingScript = readRepoFile('scripts/stage-gateway-public.mjs');
  const releaseLayout = JSON.parse(
    readRepoFile('packages/web/browser-toolchain/release-layout.json'),
  ) as BrowserReleaseLayout;
  const stages = parseDockerfile(dockerfile);
  const buildStage = stages.find((stage) => stage.name === 'build');
  const finalStage = stages.at(-1);

  if (!buildStage || !finalStage) throw new Error('gateway Dockerfile is missing build or final stage');

  const buildCopies = buildStage.instructions.map(parseCopy).filter((copy) => copy !== null);
  const finalCopies = finalStage.instructions.map(parseCopy).filter((copy) => copy !== null);

  it('copies every Browser runtime rebuild input into the builder before rebuilding', () => {
    const buildRun = buildStage.instructions.find((instruction) => (
      /^RUN\s+/i.test(instruction.value) && instruction.value.includes('npm run build:browser-avr')
    ));
    expect(buildRun, 'builder must run the pinned Browser AVR rebuild').toBeDefined();
    expect(buildRun?.value).toContain('npm run build:browser-avr -- --gateway-release');
    expect(buildRun?.value).toContain(
      'node scripts/stage-gateway-public.mjs --stage packages/web/gateway-public',
    );

    const explicitToolchainCopy = buildCopies.find((copy) => (
      copy.from === undefined
      && copy.sources.length === 1
      && copy.sources[0] === 'packages/web/browser-toolchain'
      && copy.destination === 'packages/web/browser-toolchain'
    ));
    expect(explicitToolchainCopy, 'browser-toolchain must be an explicit builder input').toBeDefined();

    const requiredContextInputs = [
      'package.json',
      'package-lock.json',
      'scripts/build-browser-avr.mjs',
      ...rootRelativeInputs(buildScript),
    ];
    expect(new Set(rootRelativeInputs(buildScript))).toEqual(new Set([
      'packages/web/browser-avr',
      'packages/web/browser-toolchain',
      'packages/web/public',
      'packages/core/src/preprocess/index.ts',
    ]));

    for (const input of requiredContextInputs) {
      const copy = buildCopies.find((candidate) => (
        candidate.from === undefined && candidate.sources.some((source) => coversPath(source, input))
      ));
      expect(copy, `builder is missing context input ${input}`).toBeDefined();
      expect(copy?.index, `${input} must be copied before the rebuild`).toBeLessThan(buildRun?.index ?? -1);
      expect(isIgnored(input, dockerignore), `${input} must be available in the Docker context`).toBe(false);
    }

    expect(buildScript).toContain("require.resolve('@horang-corp/avr-gcc-wasm/package.json')");
    expect(stagingScript).toContain("auditCkActiveRelease({ root: workspace })");
    for (const input of [
      'docker/gateway-static-allowlist.json',
      'scripts/audit-ck-active-release.mjs',
      'scripts/stage-gateway-public.mjs',
    ]) {
      const copy = buildCopies.find((candidate) => (
        candidate.from === undefined && candidate.sources.some((source) => coversPath(source, input))
      ));
      expect(copy, `builder is missing Gateway staging input ${input}`).toBeDefined();
      expect(copy?.index, `${input} must be copied before the rebuild`).toBeLessThan(buildRun?.index ?? -1);
      expect(isIgnored(input, dockerignore), `${input} must be available in the Gateway context`).toBe(false);
    }
    const install = buildStage.instructions.find((instruction) => instruction.value === 'RUN npm ci --ignore-scripts');
    expect(install?.index, 'npm dependencies must be installed before the rebuild')
      .toBeLessThan(buildRun?.index ?? -1);
  });

  it('excludes every checked-in AVR release from the Docker build context', () => {
    for (const path of [
      'packages/web/public/avr',
      'packages/web/public/avr/v2/index.js',
      'packages/web/public/avr/v4/index.js',
    ]) {
      expect(isIgnored(path, dockerignore), `${path} must be excluded by .dockerignore`).toBe(true);
    }

    expect(isIgnored('packages/web/browser-avr/index.js', dockerignore)).toBe(false);
    expect(isIgnored('packages/web/browser-toolchain/toolchain-pack.js', dockerignore)).toBe(false);
    expect(isIgnored('packages/web/browser-toolchain/verified-emscripten.js', dockerignore)).toBe(false);
    expect(isIgnored('packages/web/browser-toolchain/release-layout.json', dockerignore)).toBe(false);

    const directLegacyCopies = stages.flatMap((stage) => stage.instructions)
      .map(parseCopy)
      .filter((copy) => copy !== null && copy.from === undefined)
      .flatMap((copy) => copy.sources)
      .filter((source) => normalizePath(source).startsWith('packages/web/public/avr'));
    expect(directLegacyCopies).toEqual([]);
  });

  it('publishes the final public tree only from the allowlisted staging output', () => {
    const publicCopies = finalCopies.filter((copy) => (
      copy.destination === 'packages/web/public'
      || copy.destination.startsWith('packages/web/public/')
    ));
    expect(publicCopies).toEqual([
      expect.objectContaining({
        from: 'build',
        sources: ['/app/packages/web/gateway-public'],
        destination: 'packages/web/public',
      }),
    ]);

    const contextPublicSources = finalCopies
      .filter((copy) => copy.from === undefined)
      .flatMap((copy) => copy.sources)
      .filter((source) => coversPath(source, 'packages/web/public'));
    expect(contextPublicSources).toEqual([]);

    const publicSeed = buildCopies.filter((copy) => copy.destination === 'packages/web/public');
    expect(publicSeed).toEqual([
      expect.objectContaining({
        from: undefined,
        sources: ['packages/web/public'],
      }),
    ]);

    expect(releaseLayout).toMatchObject({
      schema: 1,
      avr: { version: 'v4' },
      esp32Shared: {
        version: 'v3',
        files: ['preprocess.js', 'toolchain-pack.js'],
      },
    });
    expect(buildScript).toMatch(/const runtimeRoot = resolve\(publicDir, 'avr'\);/);
    expect(buildScript).toContain("argumentsList[0] === '--gateway-release'");
    expect(buildScript).toContain('rmSync(runtimeRoot, { recursive: true, force: true });');
    expect(buildScript).toContain('if (gatewayRelease) assertGatewayRuntimeLayout();');
  });

  it('keeps the generated Gateway allowlist and Docker context filter current', async () => {
    const generated = await createGatewayStaticManifest({ root: repoRoot }) as GatewayStaticManifest;
    expect(checkedAllowlist).toEqual(generated);
    expect(gatewayDockerignoreSource).toBe(createGatewayDockerignore({
      root: repoRoot,
      manifest: generated,
      baseDockerignore,
    }));
    expect(generated.counts.totalFiles).toBe(
      generated.counts.sourceFiles + generated.counts.generatedAvrFiles,
    );
    expect(generated.sourceFiles.every((file) => !file.startsWith('avr/'))).toBe(true);
    expect(generated.generatedAvrFiles.every((file) => file.startsWith('avr/'))).toBe(true);
  });

  it('excludes the full public-tree difference using Docker-compatible matching', () => {
    const publicRoot = join(repoRoot, 'packages', 'web', 'public');
    const allFiles = walkFiles(publicRoot);
    const sourceFiles = new Set(checkedAllowlist.sourceFiles);
    const excluded = allFiles.filter((file) => !sourceFiles.has(file.path));
    expect(allFiles.length - excluded.length).toBe(checkedAllowlist.counts.sourceFiles);

    const evidence = auditGatewayDockerContext({
      root: repoRoot,
      manifest: checkedAllowlist,
      dockerignoreSource: gatewayDockerignoreSource,
    });
    expect(evidence).toMatchObject({
      schema: 1,
      policy: 'gateway-docker-context-full-public-tree',
      publicFiles: allFiles.length,
      includedFiles: checkedAllowlist.counts.sourceFiles,
      excludedFiles: excluded.length,
      excludedBytes: excluded.reduce((total, file) => total + file.size, 0),
    });
    expect(evidence.publicFiles).toBe(evidence.includedFiles + evidence.excludedFiles);
    expect(evidence.publicBytes).toBe(evidence.includedBytes + evidence.excludedBytes);

    for (const imaginary of [
      'esp32/v1/libraries-catalog.previous-sentinel/stale.bin',
      'esp32/v1/libraries-v9-staging/stale.bin',
      'esp32/v5/xtensa-candidate-future/clang/bundle.js',
    ]) {
      expect(sourceFiles.has(imaginary), imaginary).toBe(false);
      expect(isIgnored(`packages/web/public/${imaginary}`, dockerignore), imaginary).toBe(true);
    }
  }, 60_000);

  it('retains all 10 active compiler artifacts and transport chunks', async () => {
    const report = await auditCkActiveRelease({ root: repoRoot });
    expect(report.state).toBe('closed');
    expect(checkedAllowlist.release.compilerArtifacts).toBe(10);
    expect(checkedAllowlist.release.compilerChunks).toBe(10);
    const sourceFiles = new Set(checkedAllowlist.sourceFiles);
    const compilerManifests = new Set(
      report.targets.map((target: any) => target.packs.compiler.manifest),
    );
    let artifacts = 0;
    let chunks = 0;
    for (const manifestPath of compilerManifests) {
      const manifest = JSON.parse(readRepoFile(`packages/web/public/${manifestPath}`));
      expect(sourceFiles.has(manifestPath), manifestPath).toBe(true);
      expect(isIgnored(`packages/web/public/${manifestPath}`, dockerignore), manifestPath).toBe(false);
      artifacts += manifest.artifacts.length;
      for (const artifact of manifest.artifacts) {
        chunks += artifact.chunks.length;
        for (const chunk of artifact.chunks) {
          const chunkPath = posix.normalize(posix.join(posix.dirname(manifestPath), chunk.path));
          expect(sourceFiles.has(chunkPath), chunkPath).toBe(true);
          expect(isIgnored(`packages/web/public/${chunkPath}`, dockerignore), chunkPath).toBe(false);
        }
      }
    }
    expect(artifacts).toBe(10);
    expect(chunks).toBe(10);
  });

  it('copies only manifest-listed files into Gateway static staging', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'arduinofast-gateway-static-'));
    const source = join(temporary, 'source');
    const output = join(temporary, 'output');
    try {
      mkdirSync(join(source, 'esp32', 'v4'), { recursive: true });
      writeFileSync(join(source, 'index.html'), 'active');
      writeFileSync(join(source, 'esp32', 'v4', 'sentinel.bin'), 'stale');
      const result = stageGatewayStaticFiles({ publicRoot: source, outputRoot: output, files: ['index.html'] });
      expect(result.files).toBe(1);
      expect(readFileSync(join(output, 'index.html'), 'utf8')).toBe('active');
      expect(existsSync(join(output, 'esp32', 'v4', 'sentinel.bin'))).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('simulates a gateway output containing full v4 and only the two ESP32 v3 modules', () => {
    const checkedInAvrFiles = [
      'packages/web/public/avr/v2/index.js',
      'packages/web/public/avr/v3/worker.js',
      'packages/web/public/avr/v3/toolchain-pack.js',
      'packages/web/public/avr/v4/index.js',
    ];
    const contextSeed = checkedInAvrFiles.filter((path) => !isIgnored(path, dockerignore));
    expect(contextSeed).toEqual([]);

    const outputs = simulatedGatewayAvrFiles(releaseLayout);
    const versionRoots = new Set([...outputs].map((path) => path.split('/').slice(0, 2).join('/')));
    expect([...versionRoots].sort()).toEqual(['avr/v3', 'avr/v4']);
    expect([...outputs].filter((path) => path.startsWith('avr/v2/'))).toEqual([]);
    expect([...outputs].filter((path) => path.startsWith('avr/v3/')).sort()).toEqual([
      'avr/v3/preprocess.js',
      'avr/v3/toolchain-pack.js',
    ]);
    for (const required of [
      'avr/v4/index.js',
      'avr/v4/worker.js',
      'avr/v4/preprocess.js',
      'avr/v4/toolchain-pack.js',
      'avr/v4/tools/cc1plus.wasm',
      'avr/v4/assets/manifest.json',
      'avr/v4/release.js',
    ]) expect(outputs.has(required), required).toBe(true);
  });

  it('closes the first screen, dynamic Worker URLs, and static module URLs through the AST', () => {
    const publicRoot = join(repoRoot, 'packages', 'web', 'public');
    const closure = collectGatewayModuleClosure({ publicRoot, entries: ['app.js'] });
    expect(closure.has('avr/v3/toolchain-pack.js')).toBe(true);
    const workers = [
      'esp32/v2/esp32-worker.js',
      'esp32/v2/s2-worker.js',
      'esp32/v2/s3-worker.js',
      'esp32/v2/c3-worker.js',
      'esp32/v2/c6-worker.js',
    ];
    for (const worker of workers) {
      expect(closure.has(worker), worker).toBe(true);
    }
    expect(closure.has('esp32/v2/clang/bundle.js')).toBe(true);
    expect(closure.has('esp32/v5/xtensa/clang/bundle.js')).toBe(true);
    expect(closure.has('ck-build-core-wasm/ck_build_core_bg.wasm')).toBe(true);
    expect([...closure].filter((path) => path.startsWith('avr/v3/')).sort()).toEqual([
      'avr/v3/preprocess.js',
      'avr/v3/toolchain-pack.js',
    ]);
  });

  it('binds dynamic Worker and import sites to source-checked declarations', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'arduinofast-gateway-modules-'));
    const publicRoot = join(temporary, 'public');
    try {
      mkdirSync(publicRoot, { recursive: true });
      writeFileSync(join(publicRoot, 'alpha-worker.js'), 'export const worker = "alpha";');
      writeFileSync(join(publicRoot, 'beta-worker.js'), 'export const worker = "beta";');
      writeFileSync(join(publicRoot, 'helper.js'), 'export const helper = true;');
      writeFileSync(join(publicRoot, 'bundle.js'), `
        import { helper } from './helper.js';
        export const bundle = helper;
      `);
      writeFileSync(join(publicRoot, 'runtime.js'), `
        const launchers = {
          alpha: { workerPath: './alpha-worker.js' },
          beta: { workerPath: './beta-worker.js' },
        };
        const { workerPath } = launchers.alpha;
        new WorkerClass(new URL(workerPath, import.meta.url));
      `);
      const workerPolicy = {
        'runtime.js': [{
          kind: 'worker-url',
          expression: 'workerPath',
          valuesFromProperty: 'workerPath',
        }],
      };
      const workerClosure = collectGatewayModuleClosure({
        publicRoot,
        entries: ['runtime.js'],
        dynamicLocalLoaders: workerPolicy,
        packBackedModuleUrls: {},
      });
      expect([...workerClosure].sort()).toEqual([
        'alpha-worker.js',
        'beta-worker.js',
        'runtime.js',
      ]);

      writeFileSync(join(publicRoot, 'loader.js'), `
        // import('./comment-only.js')
        const bundleUrl = new URL('./bundle.js', import.meta.url);
        export const load = (url) => import(url);
        export { bundleUrl };
      `);
      const importPolicy = {
        'loader.js': [{
          kind: 'dynamic-import',
          expression: 'url',
          staticUrl: './bundle.js',
        }],
      };
      const importClosure = collectGatewayModuleClosure({
        publicRoot,
        entries: ['loader.js'],
        dynamicLocalLoaders: importPolicy,
        packBackedModuleUrls: {},
      });
      expect([...importClosure].sort()).toEqual(['bundle.js', 'helper.js', 'loader.js']);

      writeFileSync(join(publicRoot, 'renamed-bundle.js'), 'export const renamed = true;');
      writeFileSync(join(publicRoot, 'loader.js'), `
        const bundleUrl = new URL('./renamed-bundle.js', import.meta.url);
        export const load = (url) => import(url);
        export { bundleUrl };
      `);
      expect(() => collectGatewayModuleClosure({
        publicRoot,
        entries: ['loader.js'],
        dynamicLocalLoaders: importPolicy,
        packBackedModuleUrls: {},
      })).toThrow(/no matching static URL/u);

      writeFileSync(join(publicRoot, 'loader.js'), `
        const bundleUrl = new URL('./bundle.js', import.meta.url);
        export const load = (moduleUrl) => import(moduleUrl);
        export { bundleUrl };
      `);
      expect(() => collectGatewayModuleClosure({
        publicRoot,
        entries: ['loader.js'],
        dynamicLocalLoaders: importPolicy,
        packBackedModuleUrls: {},
      })).toThrow(/undeclared or ambiguous dynamic-import/u);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('rejects repository, public, and staging roots that are links or junctions', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'arduinofast-gateway-links-'));
    const repositoryLink = join(temporary, 'repository-link');
    const source = join(temporary, 'source');
    const publicLink = join(temporary, 'public-link');
    const outputTarget = join(temporary, 'output-target');
    const outputLink = join(temporary, 'output-link');
    const links: string[] = [];
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      mkdirSync(source);
      mkdirSync(outputTarget);
      writeFileSync(join(source, 'index.html'), 'active');
      writeFileSync(join(outputTarget, 'sentinel.txt'), 'keep');
      symlinkSync(repoRoot, repositoryLink, linkType);
      links.push(repositoryLink);
      symlinkSync(source, publicLink, linkType);
      links.push(publicLink);
      symlinkSync(outputTarget, outputLink, linkType);
      links.push(outputLink);

      await expect(createGatewayStaticManifest({ root: repositoryLink }))
        .rejects.toThrow(/repository root.*symbolic link or junction/u);
      expect(() => stageGatewayStaticFiles({
        publicRoot: publicLink,
        outputRoot: join(temporary, 'output'),
        files: ['index.html'],
      })).toThrow(/public root.*symbolic link or junction/u);
      expect(() => stageGatewayStaticFiles({
        publicRoot: source,
        outputRoot: outputLink,
        files: ['index.html'],
      })).toThrow(/staging root.*symbolic link or junction/u);
      expect(readFileSync(join(outputTarget, 'sentinel.txt'), 'utf8')).toBe('keep');
    } finally {
      for (const link of links.reverse()) {
        if (existsSync(link)) unlinkSync(link);
      }
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe('retired static route contract', () => {
  it('matches only the retired AVR v2 path boundary after URL normalization', () => {
    for (const requestTarget of [
      '/avr/v2',
      '/avr/v2/',
      '/avr/v2/index.js?cache=1',
      '/%61vr/%76%32/index.js',
      '/AVR//V2%5Ctools%5Cavr-gcc.wasm',
      '/avr/current/%2e%2e/v2/index.js',
      '/avr/v2%2Fworker.js',
    ]) {
      expect(isRetiredStaticPath(requestTarget), requestTarget).toBe(true);
    }

    for (const requestTarget of [
      '/avr/v20',
      '/avr/v20/index.js',
      '/avr/v2x/index.js',
      '/avr/v3/toolchain-pack.js',
      '/avr/v4/worker.js',
      '/search?next=/avr/v2/index.js',
      '/avr/%zz/index.js',
    ]) {
      expect(isRetiredStaticPath(requestTarget), requestTarget).toBe(false);
    }
  });

  it('returns uncached 404 responses before static files can serve retired assets', async () => {
    const app = Fastify();
    const publicRoot = join(repoRoot, 'packages', 'web', 'public');
    registerRetiredStaticPathGuard(app);
    app.get('/avr/v20/probe', async () => ({ ok: true }));
    await app.register(fastifyStatic, { root: publicRoot, setHeaders: setStaticHeaders(publicRoot) });

    try {
      for (const request of [
        { method: 'GET' as const, url: '/avr/v2' },
        { method: 'GET' as const, url: '/avr/v2/index.js?cache=1' },
        { method: 'GET' as const, url: '/%61vr/%76%32/index.js' },
        { method: 'GET' as const, url: '/AVR//V2%5Cindex.js' },
        { method: 'HEAD' as const, url: '/avr/v2/worker.js' },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode, request.url).toBe(404);
        expect(response.headers['cache-control'], request.url).toBe('no-store');
        expect(response.headers['cache-control'], request.url).not.toContain('immutable');
      }

      const versionBoundary = await app.inject({ method: 'GET', url: '/avr/v20/probe' });
      expect(versionBoundary.statusCode).toBe(200);

      for (const url of ['/avr/v3/toolchain-pack.js', '/avr/v4/worker.js']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
        expect(response.headers['cache-control'], url).toBe('public, max-age=31536000, immutable');
      }
    } finally {
      await app.close();
    }
  });

  it('never marks retired AVR v2 files immutable', () => {
    const headers = new Map<string, string>();
    const publicRoot = join(repoRoot, 'packages', 'web', 'public');
    const setHeaders = setStaticHeaders(publicRoot);
    const reply = {
      header(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    };

    setHeaders(reply as never, join(publicRoot, 'avr', 'v2', 'index.js'));
    expect(headers.size).toBe(0);

    setHeaders(reply as never, join(publicRoot, 'avr', 'v3', 'toolchain-pack.js'));
    expect(headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('registers the guard before static middleware in both server entrypoints', () => {
    for (const path of ['packages/server/src/gateway.ts', 'packages/server/src/index.ts']) {
      const source = readRepoFile(path);
      const guard = source.indexOf('registerRetiredStaticPathGuard(app);');
      const staticMiddleware = source.indexOf('app.register(fastifyStatic');
      expect(guard, `${path} must register the retired path guard`).toBeGreaterThanOrEqual(0);
      expect(staticMiddleware, `${path} must register static middleware`).toBeGreaterThanOrEqual(0);
      expect(guard, `${path} must guard retired paths before static middleware`).toBeLessThan(staticMiddleware);
    }
  });
});
