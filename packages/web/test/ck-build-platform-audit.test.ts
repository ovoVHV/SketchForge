import { describe, expect, it } from 'vitest';

import {
  auditCkBuildPlatform,
  CK_BUILD_PLATFORM_AUDIT_POLICY,
} from '../../../scripts/audit-ck-build-platform.mjs';

const workspace = process.cwd();

describe('CK Build platform static audit', () => {
  it('passes against the checked-in architecture without running a compiler', async () => {
    const result = await auditCkBuildPlatform({ root: workspace });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checked.length).toBeGreaterThan(20);
  });

  it('keeps runtime and hardware acceptance explicitly external', () => {
    expect(CK_BUILD_PLATFORM_AUDIT_POLICY.externalGates).toEqual([
      expect.objectContaining({ id: 'browser-action-graph-runtime' }),
      expect.objectContaining({ id: 'native-action-graph-runtime' }),
      expect.objectContaining({ id: 'browser-library-matrix-runtime' }),
      expect.objectContaining({ id: 'avr-corresponding-source-release' }),
      expect.objectContaining({
        id: 'hardware-flash-matrix',
        command: 'manual/CI hardware flash matrix',
      }),
    ]);
    expect(CK_BUILD_PLATFORM_AUDIT_POLICY.externalGates
      .find((gate) => gate.id === 'hardware-flash-matrix')?.command)
      .not.toMatch(/^npm run /);
  });
});
