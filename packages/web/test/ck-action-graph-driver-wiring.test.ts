import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const BROWSER_DRIVERS = ['esp32', 's2', 's3', 'c3', 'c6'].map((target) => (
  `scripts/verify-ck-browser-${target}-action-graph.mjs`
));

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Action Graph evidence v2 driver wiring', () => {
  it.each(BROWSER_DRIVERS)('%s plans and executes a real main-only incremental IR', (path) => {
    const driver = source(path);

    expect(driver).toContain('process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA');
    expect(driver).toContain('incremental evidence must modify main.ino');
    expect(driver).toContain('const incrementalIr = await createEsp32BrowserBuildIR(incrementalRequest, capability, planning)');
    expect(driver).toMatch(/executeActionGraphWithEvidence\(\{[\s\S]*incrementalIr,[\s\S]*mainSourcePath: 'main\.ino',[\s\S]*sourceRevision,/);
  });

  it('collects Native cached state per Action for baseline, replay, and incremental execution', () => {
    const driver = source('scripts/verify-native-esp32-action-graph.ts');

    expect(driver).toContain('process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA');
    expect(driver).toContain('run-${sourceRevision.slice(0, 12)}-${process.pid}-${Date.now()}');
    expect(driver).toContain('actions.push({ actionId: action.id, actionKey: action.cacheKey, cached })');
    expect(driver.match(/compileWithActionEvidence\(compiler,/g)).toHaveLength(3);
    expect(driver).toMatch(/createActionGraphEvidence\(\{[\s\S]*incrementalIr,[\s\S]*incrementalResult: incremental,[\s\S]*mainSourcePath: 'main\.ino',[\s\S]*sourceRevision,/);
    expect(driver).not.toContain('replayFullyCached: replay.cached');
  });
});
