import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workspace = process.cwd();
const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const workflow = readFileSync(
  join(workspace, '.github', 'workflows', 'ck-build-platform.yml'),
  'utf8',
);
const matrixScript = readFileSync(
  join(workspace, 'scripts', 'verify-ck-native-library-matrix.mjs'),
  'utf8',
);

function jobSection(name: string, nextName: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${nextName}:`, start + 1);
  if (start < 0 || end < 0) throw new Error(`workflow job section is missing: ${name}`);
  return workflow.slice(start, end);
}

function position(section: string, marker: string): number {
  const value = section.indexOf(marker);
  if (value < 0) throw new Error(`workflow marker is missing: ${marker}`);
  return value;
}

describe('CK Build CI wiring', () => {
  it('keeps fresh-checkout contracts on committed WASM and includes the new tests', () => {
    const scripts = packageJson.scripts ?? {};
    expect(scripts['check:ck-build-core-wasm']).toContain('packages/core/wasm');
    expect(scripts['check:ck-build-core-wasm-publications'])
      .toContain('check-ck-build-core-wasm-publications.mjs');

    const contractScript = scripts['test:ck-build-contracts'] ?? '';
    for (const testFile of [
      'packages/core/test/compile-validation.test.ts',
      'packages/core/test/compile-platform-manifest.test.ts',
      'packages/core/test/esp32-partition-table.test.ts',
      'packages/core/test/esp32-custom-partitions.test.ts',
      'packages/web/test/project-files.test.ts',
      'packages/web/test/avr-compiler-sw.test.ts',
      'packages/web/test/browser-esp32-action-v2-matrix.test.ts',
    ]) {
      expect(contractScript).toContain(testFile);
    }

    expect(matrixScript).toContain('COMMITTED_PLANNER_PUBLICATIONS');
    expect(matrixScript).toContain('readCommittedPlannerPublicationIdentity');
    expect(matrixScript).toContain('dependencies.requireNativeTools === true');

    expect(scripts['test:ck-active-release']).toContain('audit-ck-active-release.test.mjs');
    expect(scripts['audit:ck-active-release']).toContain('audit-ck-active-release.mjs');
    expect(scripts['test:esp32-s3-esp-sr-source-lock'])
      .toContain('audit-esp32-s3-esp-sr-source-lock.test.mjs');
    expect(scripts['audit:esp32-s3-esp-sr-source-lock'])
      .toContain('audit-esp32-s3-esp-sr-source-lock.mjs');
    expect(workflow).toContain(
      'npm run test:esp32-s3-esp-sr-source-lock && npm run audit:esp32-s3-esp-sr-source-lock',
    );
  });

  it('builds prerequisites before the contracts that consume them', () => {
    const contracts = jobSection('contracts', 'wasm-publication');
    const coreBuild = position(contracts, 'npm run build --workspace @sketchforge/core');
    expect(coreBuild).toBeGreaterThan(position(contracts, 'npm ci --omit=optional'));
    expect(coreBuild).toBeLessThan(position(contracts, 'npm run test:ck-library-matrix-contracts'));
    expect(coreBuild).toBeLessThan(position(contracts, 'npm run audit:ck-platform-profile-migration'));
    expect(coreBuild).toBeLessThan(position(contracts, 'npm run audit:ck-active-release'));
    expect(contracts).not.toContain('crates/ck-build-core/dist/web');

    const browserBuild = position(contracts, 'npm run build:ck-browser-core');
    const browserDiff = position(contracts, 'git diff --exit-code --');
    expect(browserBuild).toBeLessThan(browserDiff);
    for (const generatedFile of [
      'packages/web/public/ck-project-resolver.js',
      'packages/web/public/ck-platform-planning.js',
      'packages/web/public/ck-esp32-partitions.js',
      'packages/web/public/ck-blockly-generator.js',
      'packages/web/public/ck-firmware-patch.js',
    ]) {
      expect(contracts).toContain(generatedFile);
    }
  });

  it('makes the publication job the owner of the three-copy WASM check', () => {
    const publication = jobSection('wasm-publication', 'native-planner-publication');
    expect(publication).toContain('needs: contracts');
    const build = position(publication, 'crates/ck-build-core/scripts/build-web.ps1');
    const publish = position(publication, 'node scripts/publish-ck-build-core-wasm.mjs');
    const verify = position(publication, 'npm run check:ck-build-core-wasm-publications');
    expect(build).toBeLessThan(publish);
    expect(publish).toBeLessThan(verify);
    expect(verify).toBeLessThan(position(publication, 'git diff --exit-code'));
  });

  it('builds Core before the scheduled Native action graph job', () => {
    const native = jobSection('native-action-graph', 'runtime-evidence');
    const install = position(native, 'npm ci --omit=optional');
    const build = position(native, 'npm run build --workspace @sketchforge/core');
    const execute = position(native, 'npm run verify:ck-native-action-graph-matrix');
    expect(install).toBeLessThan(build);
    expect(build).toBeLessThan(execute);
  });
});
