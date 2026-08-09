import { describe, expect, it } from 'vitest';

import {
  discoverLocalLibraryExternalDependencies,
  resolveLocalLibraries,
} from '../src/build-ir/local-libraries.js';
import { planBuildActions } from '../src/build-ir/planner.js';

const files = [
  { path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
  { path: 'include/config.h', content: '#pragma once\n' },
  { path: 'libraries/Parent/library.properties', content: 'name=Parent\nversion=1.0.0\narchitectures=esp32\ndepends=Child\nlicense=MIT\n' },
  { path: 'libraries/Parent/src/Parent.h', content: '#pragma once\n' },
  { path: 'libraries/Parent/src/Parent.cpp', content: '#include <Child.h>\nvoid parent() {}\n' },
  { path: 'libraries/Parent/examples/Example.ino', content: 'this is not compiled\n' },
  { path: 'libraries/Child/library.properties', content: 'name=Child\nversion=2.0.0\narchitectures=*\n' },
  { path: 'libraries/Child/Child.h', content: '#pragma once\n' },
  { path: 'libraries/Child/Child.cpp', content: 'void child() {}\n' },
] as const;

describe('project-local Library Packs', () => {
  it('supports Arduino 1.5 and 1.0 layouts with recursive local dependencies', () => {
    const resolved = resolveLocalLibraries(files, 'esp32');
    expect([...resolved.projectCompilePaths].sort()).toEqual(['include/config.h', 'main.ino']);
    expect(resolved.libraries.map((library) => library.pack.name)).toEqual(['Child', 'Parent']);
    expect(resolved.libraries[0]!.includePaths).toEqual(['.', 'utility']);
    expect(resolved.libraries[1]!.includePaths).toEqual(['src']);
    expect(resolved.libraries[1]!.pack.dependencies).toMatchObject([
      { id: resolved.libraries[0]!.pack.id, version: '2.0.0', sha256: resolved.libraries[0]!.pack.sha256 },
    ]);
    expect(resolved.libraries[1]!.files.some((file) => file.path.includes('examples'))).toBe(false);
    expect(resolved.libraries[1]!.pack.license).toBe('MIT');
  });

  it('rejects an architecture mismatch and missing recursive dependency', () => {
    expect(() => resolveLocalLibraries([
      { path: 'libraries/OnlyAvr/library.properties', content: 'name=OnlyAvr\nversion=1.0.0\narchitectures=avr\n' },
      { path: 'libraries/OnlyAvr/src/OnlyAvr.cpp', content: 'void x() {}\n' },
    ], 'esp32')).toThrow(/does not support architecture/);
    expect(() => resolveLocalLibraries([
      { path: 'libraries/Needs/library.properties', content: 'name=Needs\nversion=1.0.0\ndepends=Missing\n' },
      { path: 'libraries/Needs/src/Needs.cpp', content: 'void x() {}\n' },
    ], 'esp32')).toThrow(/missing dependency/);
  });

  it('discovers external manifest dependencies without treating local siblings as Registry roots', () => {
    expect(discoverLocalLibraryExternalDependencies(files.map((file) => (
      file.path === 'libraries/Parent/library.properties'
        ? { ...file, content: 'name=Parent\nversion=1.0.0\ndepends=Child, Adafruit BusIO\n' }
        : file
    )))).toEqual([{ name: 'Adafruit BusIO' }]);
  });

  it('supports header-only libraries and rejects local dependency cycles deterministically', () => {
    const headerOnly = resolveLocalLibraries([
      { path: 'main.ino', content: '#include <HeaderOnly.h>\n' },
      { path: 'libraries/HeaderOnly/library.properties', content: 'name=HeaderOnly\nversion=1.0.0\n' },
      { path: 'libraries/HeaderOnly/src/HeaderOnly.h', content: '#pragma once\n#include "HeaderOnly.tpp"\n' },
      { path: 'libraries/HeaderOnly/src/HeaderOnly.tpp', content: 'template <typename T> T identity(T value) { return value; }\n' },
    ], 'esp32');
    expect(headerOnly.libraries[0]?.files.map((file) => file.path)).toContain('src/HeaderOnly.h');
    expect(headerOnly.libraries[0]?.files).toContainEqual(expect.objectContaining({
      path: 'src/HeaderOnly.tpp', language: 'other',
    }));

    expect(() => resolveLocalLibraries([
      { path: 'libraries/A/library.properties', content: 'name=A\ndepends=B\n' },
      { path: 'libraries/A/src/A.h', content: '#pragma once\n' },
      { path: 'libraries/B/library.properties', content: 'name=B\ndepends=A\n' },
      { path: 'libraries/B/src/B.h', content: '#pragma once\n' },
    ], 'esp32')).toThrow(/dependency cycle/);
  });

  it('keeps the full snapshot while excluding local sources from project compile Actions', () => {
    const resolved = resolveLocalLibraries(files, 'esp32');
    const packRefs = resolved.libraries.map((library) => library.pack);
    const plan = planBuildActions({
      project: resolved.projectFiles,
      projectCompilePaths: resolved.projectCompilePaths,
      target: {
        fqbn: 'esp32:esp32:esp32',
        options: {},
        boardPack: {
          kind: 'board', id: 'board:test', version: '1', sha256: '1'.repeat(64),
          fqbn: 'esp32:esp32:esp32', variant: 'esp32',
        },
      },
      packs: {
        toolchain: { kind: 'toolchain', id: 'toolchain:test', version: '1', sha256: '2'.repeat(64), abi: 'xtensa', instructionSet: 'xtensa' },
        platform: { kind: 'platform', id: 'platform:test', version: '1', sha256: '3'.repeat(64), platform: 'esp32' },
        board: { kind: 'board', id: 'board:test', version: '1', sha256: '1'.repeat(64), fqbn: 'esp32:esp32:esp32', variant: 'esp32' },
        libraries: { roots: packRefs.map((pack) => pack.id), packs: packRefs },
      },
      libraries: resolved.libraries,
    });
    expect(plan.actions.filter((action) => action.kind === 'compile' && action.id.startsWith('compile-project-'))).toHaveLength(1);
    expect(plan.actions.some((action) => action.id.includes('Parent'))).toBe(true);
  });
});
