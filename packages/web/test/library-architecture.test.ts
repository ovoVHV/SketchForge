import { describe, expect, it } from 'vitest';
import {
  filterLibrariesForArchitecture,
  libraryReferenceSupported,
  supportsLibraryArchitecture,
} from '../public/library-architecture.js';

const libraries = [
  { name: 'Wire', version: '1.0.0', architectures: ['*'] },
  { name: 'AvrOnly', version: '2.0.0', architectures: ['avr'] },
  { name: 'EspOnly', version: '3.0.0', architectures: ['esp32'] },
];

describe('library architecture filtering', () => {
  it('accepts wildcard and case-insensitive architecture matches', () => {
    expect(supportsLibraryArchitecture(libraries[0], 'AVR')).toBe(true);
    expect(supportsLibraryArchitecture(libraries[2], 'ESP32')).toBe(true);
    expect(supportsLibraryArchitecture(libraries[1], 'esp32')).toBe(false);
  });

  it('filters catalog rows without treating missing metadata as universal', () => {
    expect(filterLibrariesForArchitecture([...libraries, { name: 'Unknown' }], 'avr').map((row) => row.name))
      .toEqual(['Wire', 'AvrOnly']);
    expect(filterLibrariesForArchitecture(libraries, '').map((row) => row.name))
      .toEqual(['Wire', 'AvrOnly', 'EspOnly']);
  });

  it('keeps a versionless legacy reference only when a compatible version exists', () => {
    expect(libraryReferenceSupported({ name: 'AvrOnly' }, libraries, 'avr')).toBe(true);
    expect(libraryReferenceSupported({ name: 'AvrOnly' }, libraries, 'esp32')).toBe(false);
    expect(libraryReferenceSupported({ name: 'AvrOnly', version: '9.0.0' }, libraries, 'avr')).toBe(false);
  });

});
