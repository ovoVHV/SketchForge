import { describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_ARCHIVE_BYTES,
  decodeProjectArchive,
  encodeProjectArchive,
  projectArchiveFilename,
  safeDownloadFilename,
} from '../public/project-transfer.js';

const project = {
  files: [
    { name: 'main.ino', content: 'void setup() {}\n' },
    { name: 'src/helper.cpp', content: 'int helper = 1;\n' },
  ],
  activeFile: 'src/helper.cpp',
  board: 'arduino:avr:uno',
  options: { optimize: 'size' },
  libraries: [{ name: 'Servo', version: '1.2.2' }],
};

describe('portable project archives', () => {
  it('round-trips the complete normalized project state', () => {
    const decoded = decodeProjectArchive(encodeProjectArchive(project));
    expect(decoded).toMatchObject({
      schemaVersion: 2,
      activeFile: 'src/helper.cpp',
      board: 'arduino:avr:uno',
      options: { optimize: 'size' },
      libraries: [{ name: 'Servo', version: '1.2.2' }],
    });
    expect(decoded.files.map((file: { name: string }) => file.name))
      .toEqual(['main.ino', 'src/helper.cpp']);
  });

  it('rejects malformed, unsupported, unsafe, and oversized archives', () => {
    expect(() => decodeProjectArchive('{')).toThrow(/valid JSON/);
    expect(() => decodeProjectArchive(JSON.stringify({ format: 'other', version: 1 })))
      .toThrow(/unsupported/);
    expect(() => decodeProjectArchive(JSON.stringify({
      format: 'arduinofast-project',
      version: 1,
      project: { schemaVersion: 2, ...project, files: [{ name: '../main.ino', content: '' }] },
    }))).toThrow(/invalid state/);
    expect(() => decodeProjectArchive('x'.repeat(MAX_PROJECT_ARCHIVE_BYTES + 1)))
      .toThrow(/too large/);
  });

  it('creates bounded filesystem-safe download names', () => {
    expect(projectArchiveFilename('  demo project / one  ')).toBe('demo-project-one.arduinofast.json');
    expect(safeDownloadFilename('..\\bad/name?.bin', 'firmware.bin')).toBe('bad-name-.bin');
    expect(safeDownloadFilename('...')).toBe('project');
    expect(projectArchiveFilename('')).toBe('project.arduinofast.json');
  });
});
