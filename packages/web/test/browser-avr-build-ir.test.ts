import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateBuildIR } from '../public/ck-rust-build-core.js';
import {
  createAvrBrowserBuildIR,
  createAvrBrowserPackProvider,
  loadAvrBrowserBuildPlanning,
  packedAssetPath,
} from '../public/avr/v4/build-ir.js';

const runtimeBase = new URL('../public/avr/v4/', import.meta.url);
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('assets/manifest.json', runtimeBase)), 'utf8'));
const roles = ['toolchain', 'platform', 'board'] as const;
const packManifests = Object.fromEntries(roles.map((role) => [
  role,
  JSON.parse(readFileSync(fileURLToPath(new URL(manifest.packs[role].manifest, runtimeBase)), 'utf8')),
]));
const assetArtifacts = Object.fromEntries(roles.map((role) => [
  role,
  packManifests[role].artifacts.find((artifact: any) => artifact.id === manifest.packs[role].artifactId),
]));

function request(content = 'void setup() {}\nvoid loop() {}') {
  return {
    board: 'arduino:avr:uno',
    files: [{ name: 'main.ino', content }],
    options: { optimize: 'fast' },
  };
}

function planning(overrides: Record<string, unknown> = {}) {
  return {
    manifest,
    assetsBase: runtimeBase.href,
    packManifests,
    assetArtifacts,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser AVR CK Build IR', () => {
  it('plans and Rust-validates the complete Uno Action graph deterministically', async () => {
    const first = await createAvrBrowserBuildIR(request(), planning());
    const second = await createAvrBrowserBuildIR(request(), planning());
    await expect(validateBuildIR(first)).resolves.toBeUndefined();
    expect(second).toEqual(first);

    const preprocess = first.graph.actions.find((action: any) => action.tool === 'ck:arduino-preprocess');
    const compile = first.graph.actions.find((action: any) => action.kind === 'compile');
    const link = first.graph.actions.find((action: any) => action.kind === 'link');
    const hex = first.graph.actions.find((action: any) => action.transform?.format === 'hex');

    expect(first.graph.actions).toHaveLength(4);
    expect(compile.dependencies).toContain(preprocess.id);
    expect(link.dependencies).toContain(compile.id);
    expect(hex.dependencies).toContain(link.id);
    expect(first.artifacts).toEqual([
      { path: 'build/firmware.elf', format: 'elf' },
      { path: 'build/firmware.hex', format: 'hex' },
    ]);
    expect(first.packs).toMatchObject({
      toolchain: { id: 'avr-gcc-atmega328p-wasm', abi: 'avr-gcc-wasm-v1' },
      platform: { id: 'arduino-avr-core', version: '1.8.6' },
      board: { id: 'arduino-avr-uno-board', fqbn: 'arduino:avr:uno' },
    });
    expect(compile.packInputs).toHaveLength(3);
    expect(compile.packInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ packId: packManifests.toolchain.id, artifactId: 'runtime-assets' }),
      expect.objectContaining({ packId: packManifests.platform.id, artifactId: 'core-assets' }),
      expect.objectContaining({ packId: packManifests.board.id, artifactId: 'variant-assets' }),
    ]));
    expect(link.packInputs).toHaveLength(2);
    expect(link.packInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ packId: packManifests.toolchain.id, artifactId: 'runtime-assets' }),
      expect.objectContaining({ packId: packManifests.platform.id, artifactId: 'core-assets' }),
    ]));
    expect(first.graph.actions.flatMap((action: any) => [
      ...action.inputs.map((input: any) => input.path),
      ...action.outputs.map((output: any) => output.path),
    ]).every((path: string) => !path.startsWith('/') && !path.includes('\\'))).toBe(true);
  });

  it('plans Arduino tabs as one preprocess and compile unit', async () => {
    const create = (other: string) => createAvrBrowserBuildIR({
      board: 'arduino:avr:uno',
      files: [
        { name: 'Other.ino', content: other },
        { name: 'main.ino', content: 'void setup() {}\n' },
      ],
      options: { optimize: 'fast' },
    }, planning());
    const baseline = await create('void loop() {}\n');
    const changed = await create('void loop() { delay(1); }\n');
    const preprocess = baseline.graph.actions.find((action: any) => action.tool === 'ck:arduino-preprocess');
    const compiles = baseline.graph.actions.filter((action: any) => action.kind === 'compile');

    expect(preprocess.arguments).toEqual([
      'main.ino', 'Other.ino', '-o', 'build/generated/main.cpp',
    ]);
    expect(preprocess.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'main.ino', role: 'sketch-main' }),
      expect.objectContaining({ path: 'Other.ino', role: 'sketch-tab' }),
    ]));
    expect(compiles).toHaveLength(1);
    expect(baseline.diagnosticMap.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: 'Other.ino', sourceLine: 1 }),
    ]));
    const actionKey = (ir: any, predicate: (action: any) => boolean) => ir.graph.actions.find(predicate).cacheKey;
    expect(actionKey(changed, (action) => action.tool === 'ck:arduino-preprocess'))
      .not.toBe(actionKey(baseline, (action) => action.tool === 'ck:arduino-preprocess'));
    expect(actionKey(changed, (action) => action.kind === 'compile'))
      .not.toBe(actionKey(baseline, (action) => action.kind === 'compile'));
  });

  it('includes the physical asset Pack identity in compile and link Action keys', async () => {
    const baseline = await createAvrBrowserBuildIR(request(), planning());
    const changed = await createAvrBrowserBuildIR(request(), planning({
      assetArtifacts: {
        ...assetArtifacts,
        toolchain: { ...assetArtifacts.toolchain, sha256: 'a'.repeat(64) },
      },
    }));
    const key = (ir: any, kind: string) => ir.graph.actions.find((action: any) => action.kind === kind).cacheKey;

    expect(key(changed, 'compile')).not.toBe(key(baseline, 'compile'));
    expect(key(changed, 'link')).not.toBe(key(baseline, 'link'));
  });

  it('materializes exactly the Pack paths declared by the graph', async () => {
    const ir = await createAvrBrowserBuildIR(request(), planning());
    const loadArtifacts = Object.fromEntries(roles.map((role) => {
      const artifact = assetArtifacts[role];
      const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(artifact.chunks[0].path, runtimeBase))));
      return [role, vi.fn(async () => ({ artifact, bytes }))];
    }));
    const loaders = Object.fromEntries(roles.map((role) => [role, { loadArtifact: loadArtifacts[role] }]));
    const provider = createAvrBrowserPackProvider({
      planning: planning({ loaders }),
      ir,
    });
    const written = new Map<string, Uint8Array>();
    await provider.materialize(ir.packs, {
      writeFile(path: string, bytes: Uint8Array) { written.set(path, new Uint8Array(bytes)); },
    });
    const expected = [...new Set(ir.graph.actions
      .flatMap((action: any) => action.inputs.map((input: any) => input.path))
      .filter((path: string) => path.startsWith('packs/')))].sort();

    for (const role of roles) expect(loadArtifacts[role]).toHaveBeenCalledOnce();
    expect([...written.keys()].sort()).toEqual(expected);
    expect([...written].every(([path, bytes]) => (
      bytes.byteLength === manifest.packs[
        path.startsWith('packs/toolchain/') ? 'toolchain'
          : path.startsWith('packs/platform/') ? 'platform' : 'board'
      ].assetPack.entries.find((entry: any) => entry.path === packedAssetPath(path)).length
    ))).toBe(true);
  });

  it('binds planning to all three release-pinned Pack descriptors', async () => {
    const reset = vi.fn();
    const createPackLoader = vi.fn(({ manifestUrl }: { manifestUrl: URL }) => {
      const role = roles.find((candidate) => manifestUrl.pathname.endsWith(`/${manifest.packs[candidate].manifest}`));
      if (!role) throw new Error(`unexpected AVR Pack URL: ${manifestUrl.href}`);
      return { loadManifest: vi.fn(async () => packManifests[role]), reset };
    });
    const loaded = await loadAvrBrowserBuildPlanning({
      manifest,
      assetsBase: runtimeBase.href,
      createPackLoader,
    });

    expect(loaded.assetArtifacts).toEqual(assetArtifacts);
    expect(createPackLoader).toHaveBeenCalledTimes(3);
    for (const role of roles) {
      expect(createPackLoader).toHaveBeenCalledWith(expect.objectContaining({
        expectedId: packManifests[role].id,
        expectedRevision: packManifests[role].revision,
      }));
    }
    loaded.reset();
    expect(reset).toHaveBeenCalledTimes(3);
  });
});
