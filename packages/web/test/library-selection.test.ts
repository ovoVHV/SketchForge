import { describe, expect, it } from 'vitest';
import {
  mergeLibrarySelectionRows,
  normalizeLibraryReferences,
} from '../public/library-selection.js';

describe('project library selection authority', () => {
  it('never lets a partial catalog rewrite versionless or explicit references', () => {
    expect(normalizeLibraryReferences([
      { name: 'Missing From Page' },
      { name: 'Matched' },
      { name: 'Explicit', version: '9.1.0' },
    ])).toEqual([
      { name: 'Explicit', version: '9.1.0' },
      { name: 'Matched' },
      { name: 'Missing From Page' },
    ]);
  });

  it('preserves every valid selection when all catalog sources are unavailable', () => {
    expect(normalizeLibraryReferences([
      { name: 'Wire' },
      { name: 'Imported', version: 'abc123' },
    ])).toEqual([
      { name: 'Imported', version: 'abc123' },
      { name: 'Wire' },
    ]);
  });

  it('normalizes and deduplicates references without accepting malformed entries', () => {
    expect(normalizeLibraryReferences([
      { name: ' Wire ', version: ' 1.0.0 ' },
      { name: 'wire', version: '1.0.0' },
      { name: '' },
      null,
    ])).toEqual([{ name: 'wire', version: '1.0.0' }]);
  });

  it('keeps missing selections visible and maps a versionless selection to one catalog row', () => {
    const rows = mergeLibrarySelectionRows([
      { name: 'Missing', version: '3.0.0' },
      { name: 'Matched' },
    ], [
      { name: 'Matched', version: '2.0.0' },
      { name: 'Matched', version: '1.0.0' },
    ]);

    expect(rows.map(({ name, version, selected, retained }) => ({ name, version, selected, retained })))
      .toEqual([
        { name: 'Missing', version: '3.0.0', selected: true, retained: true },
        { name: 'Matched', version: '2.0.0', selected: true, retained: false },
        { name: 'Matched', version: '1.0.0', selected: false, retained: false },
      ]);
  });
});
