import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditAvrToolchainSource,
  requireCommercialRelease,
} from './audit-avr-toolchain-source.mjs';

const BUILD_SCRIPT = 'scripts/build-browser-avr.mjs';
const RELEASE_LAYOUT = 'packages/web/browser-toolchain/release-layout.json';
const PUBLISHED_NOTICE = 'packages/web/public/avr/v4/TOOLCHAIN_SOURCE.md';
const STRUCTURED_BUILD_WIRING = `
  const releaseLayout = readReleaseLayout(
    join(toolchainSourceDir, 'release-layout.json'),
  );
  const runtimeVersion = releaseLayout.avr.version;
`;

test('current AVR binary provenance is pinned and explicitly integration-only', async () => {
  const result = await auditAvrToolchainSource();
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.runtimeVersion, 'v4');
  assert.equal(result.binaryInput.version, '0.2.0');
  assert.equal(result.commercialReleaseReady, false);
  assert.equal(result.blockers.includes('complete-corresponding-gcc-source'), true);
});

test('commercial release gate fails closed while corresponding source is incomplete', async () => {
  const result = await auditAvrToolchainSource();
  assert.throws(() => requireCommercialRelease(result), /commercial release is blocked/);
});

test('provenance audit rejects a package-lock integrity mismatch', async () => {
  const result = await auditAvrToolchainSource({
    overrides: {
      'package-lock.json': JSON.stringify({
        packages: {
          'node_modules/@horang-corp/avr-gcc-wasm': { version: '0.2.0', integrity: 'sha512-wrong' },
        },
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-package-drift'), true);
});

test('build wiring is accepted without an AVR version literal', async () => {
  const result = await auditAvrToolchainSource({
    overrides: { [BUILD_SCRIPT]: STRUCTURED_BUILD_WIRING },
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test('provenance audit rejects a hard-coded build runtime version', async () => {
  const result = await auditAvrToolchainSource({
    overrides: {
      [BUILD_SCRIPT]: `
        const releaseLayout = readReleaseLayout(join(toolchainSourceDir, 'release-layout.json'));
        const runtimeVersion = 'v4';
      `,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-build-wiring'), true);
});

test('provenance audit fails closed when build wiring declarations are missing', async () => {
  const result = await auditAvrToolchainSource({
    overrides: { [BUILD_SCRIPT]: 'const unrelated = true;' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-build-wiring'), true);
});

test('provenance audit rejects an unexpected release-layout input path', async () => {
  const result = await auditAvrToolchainSource({
    overrides: {
      [BUILD_SCRIPT]: `
        const releaseLayout = readReleaseLayout(join(toolchainSourceDir, 'other-layout.json'));
        const runtimeVersion = releaseLayout.avr.version;
      `,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-build-wiring'), true);
});

test('provenance audit rejects release-layout runtime version drift', async () => {
  const result = await auditAvrToolchainSource({
    overrides: {
      [RELEASE_LAYOUT]: JSON.stringify({
        schema: 1,
        avr: { version: 'v5', sourceFiles: ['TOOLCHAIN_SOURCE.md'] },
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-runtime-version'), true);
});

test('provenance audit rejects removing the source notice from the release layout', async () => {
  const result = await auditAvrToolchainSource({
    overrides: {
      [RELEASE_LAYOUT]: JSON.stringify({
        schema: 1,
        avr: { version: 'v4', sourceFiles: ['index.js'] },
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-publication-wiring'), true);
});

test('provenance audit rejects a stale published source notice', async () => {
  const result = await auditAvrToolchainSource({
    overrides: { [PUBLISHED_NOTICE]: '# stale notice\n' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-publication-drift'), true);
});

test('provenance audit rejects a package version mismatch', async () => {
  const result = await auditAvrToolchainSource({
    overrides: {
      'package.json': JSON.stringify({
        devDependencies: { '@horang-corp/avr-gcc-wasm': '0.2.1' },
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'source-package-drift'), true);
});
