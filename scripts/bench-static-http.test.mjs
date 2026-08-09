import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('static HTTP benchmark cannot submit compile jobs', async () => {
  const source = await readFile(new URL('./bench-static-http.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"]POST['"]/i);
  assert.doesNotMatch(source, /new URL\(['"](?:v1\/)?compile/);
  assert.match(source, /Range:/);
  assert.match(source, /RANGE_BYTES = 256 \* 1024/);
});
