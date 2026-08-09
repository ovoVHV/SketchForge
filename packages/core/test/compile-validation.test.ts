import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CompileService, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, validateCompileRequest,
} from '../src/compile.js';
import { LocalExecutor } from '../src/sandbox/local.js';
import { BoardRegistry, type BoardDefinition } from '../src/toolchain/board.js';
import type { ToolchainConfig } from '../src/toolchain/config.js';
import { LibraryRegistry, loadLibrary } from '../src/toolchain/library.js';
import type { CompileRequest } from '../src/types.js';
import { DeadlineExceededError } from '../src/deadline.js';

const roots: string[] = [];

function service(): CompileService {
  const root = mkdtempSync(join(tmpdir(), 'af-compile-validation-'));
  roots.push(root);
  const libraryDir = join(root, 'libraries', 'Demo');
  mkdirSync(join(libraryDir, 'src'), { recursive: true });
  writeFileSync(join(libraryDir, 'library.properties'), 'name=Demo\nversion=1.2.3\narchitectures=avr\n');
  writeFileSync(join(libraryDir, 'src', 'Demo.h'), '#pragma once\n');

  const board: BoardDefinition = {
    fqbn: 'arduino:avr:test',
    name: 'Test AVR',
    arch: 'avr',
    pins: [],
    options: [],
    flashTotal: 32_768,
    ramTotal: 2_048,
    upload: { protocol: 'stk500v1' },
    build: { mcu: 'atmega328p', fCpu: '16000000L', variant: 'standard', defines: [] },
  };
  const boards = new BoardRegistry();
  boards.add(board);

  const libraries = new LibraryRegistry();
  libraries.add(loadLibrary(libraryDir)!);
  const toolchain: ToolchainConfig = {
    avr: {
      binDir: join(root, 'missing-bin'),
      coreDir: join(root, 'missing-core'),
      variantsDir: join(root, 'missing-variants'),
    },
    cacheDir: join(root, 'cache'),
    workDir: join(root, 'work'),
    librariesDirs: [join(root, 'libraries')],
  };
  return new CompileService({ boards, toolchain, executor: new LocalExecutor(), libraries });
}

const validRequest = (): CompileRequest => ({
  board: 'arduino:avr:test',
  files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CompileService request validation', () => {
  it('refuses to start planning after the whole-job deadline', async () => {
    await expect(service().planActionGraph(validRequest(), {
      deadlineAt: Date.now() - 1,
    })).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('plans a validated request as a deterministic CK Build IR Action graph', async () => {
    const compiler = service();
    const ir = await compiler.planActionGraph(validRequest());
    const replay = await compiler.planActionGraph(validRequest());
    expect(ir.kind).toBe('ck-build-ir');
    expect(ir.schemaVersion).toBe(1);
    expect(ir.graph.actions.length).toBeGreaterThan(1);
    expect(ir.graph.actions.every((action) => /^[a-f0-9]{64}$/.test(action.cacheKey))).toBe(true);
    expect(replay).toEqual(ir);
  });

  it('exposes the real Action DAG planner without invoking the compiler', async () => {
    const ir = await service().planActionGraph(validRequest());
    expect(ir.kind).toBe('ck-build-ir');
    expect(ir.graph.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining(['compile', 'link', 'transform']),
    );
    expect(ir.graph.actions.some((action) => action.tool === 'ck:preprocess')).toBe(true);
  });

  it('resolves Registry dependencies declared only by a project-local library manifest', async () => {
    const ir = await service().planActionGraph({
      ...validRequest(),
      files: [
        ...validRequest().files,
        { name: 'libraries/Local/library.properties', content: 'name=Local\nversion=1.0.0\ndepends=Demo\n' },
        { name: 'libraries/Local/src/Local.h', content: '#pragma once\n' },
      ],
    });
    const demo = ir.packs.libraries.packs.find((pack) => pack.name === 'Demo');
    const local = ir.packs.libraries.packs.find((pack) => pack.name === 'Local');
    expect(demo).toBeDefined();
    expect(local?.dependencies).toContainEqual({
      id: demo?.id,
      version: demo?.version,
      sha256: demo?.sha256,
    });
  });

  it('rejects incomplete IR instead of falling back to the legacy compiler', async () => {
    const compiler = service();
    const ir = await compiler.planActionGraph(validRequest());
    const incomplete = {
      ...ir,
      graph: { ...ir.graph, actions: ir.graph.actions.filter((action) => action.kind === 'transform') },
    };
    await expect(compiler.compileBuildIR(incomplete)).resolves.toMatchObject({
      status: 'error', reason: 'invalid_request',
    });
  });

  it('纯校验器在入队前收窄合法请求并拒绝畸形负载', () => {
    const valid = validRequest();
    expect(validateCompileRequest(valid)).toEqual({ ok: true, request: valid });

    expect(validateCompileRequest(null)).toMatchObject({ ok: false });
    expect(validateCompileRequest({ ...valid, files: [] })).toMatchObject({ ok: false });
    expect(validateCompileRequest({ ...valid, files: [{ name: '../main.ino', content: '' }] }))
      .toMatchObject({ ok: false });
    expect(validateCompileRequest({ ...valid, options: { optimize: 42 } }))
      .toMatchObject({ ok: false });
    expect(validateCompileRequest({ ...valid, libraries: [{ name: 'Demo', version: 42 }] }))
      .toMatchObject({ ok: false });
    expect(validateCompileRequest({ ...valid, sessionId: 'x'.repeat(129) }))
      .toMatchObject({ ok: false });
    expect(validateCompileRequest({
      ...valid,
      libraries: [{ name: 'x'.repeat(129) }],
    })).toMatchObject({ ok: false });
    expect(validateCompileRequest({
      ...valid,
      libraries: [{ name: 'Demo', version: 'x'.repeat(65) }],
    })).toMatchObject({ ok: false });
    expect(validateCompileRequest({
      ...valid,
      libraries: [{ name: 'x'.repeat(300 * 1024) }],
    })).toMatchObject({ ok: false });
  });

  it('纯校验器不读取板卡或工具链运行态', () => {
    const requestWithUnknownBoard = { ...validRequest(), board: 'vendor:arch:not-installed' };
    expect(validateCompileRequest(requestWithUnknownBoard)).toEqual({
      ok: true,
      request: requestWithUnknownBoard,
    });
  });

  it('入队前丢弃未定义字段，只保留规范化编译请求', () => {
    const validated = validateCompileRequest({
      ...validRequest(),
      ignored: 'do-not-queue',
      libraries: [{ name: 'Demo', ignored: 'do-not-queue' }],
    });

    expect(validated).toEqual({
      ok: true,
      request: {
        ...validRequest(),
        libraries: [{ name: 'Demo' }],
      },
    });
  });

  it('接受一个 ino 加受限项目库文件，并规范化文件顺序和字段', () => {
    const validated = validateCompileRequest({
      ...validRequest(),
      files: [
        { name: 'src/Math.cpp', content: '#include "Math.h"\nint twice(int x) { return x * 2; }\n', ignored: true },
        { name: 'main.ino', content: '#include <Math.h>\nvoid setup() {}\nvoid loop() {}\n' },
        { name: 'src/Math.h', content: '#pragma once\nint twice(int);\n' },
      ],
    });

    expect(validated).toEqual({
      ok: true,
      request: {
        ...validRequest(),
        files: [
          { name: 'main.ino', content: '#include <Math.h>\nvoid setup() {}\nvoid loop() {}\n' },
          { name: 'src/Math.cpp', content: '#include "Math.h"\nint twice(int x) { return x * 2; }\n' },
          { name: 'src/Math.h', content: '#pragma once\nint twice(int);\n' },
        ],
      },
    });
  });

  it('接受 C++ 模板和包含片段文件', () => {
    const files = [
      { name: 'main.ino', content: '#include "src/Templates.hpp"\nvoid setup() {}\nvoid loop() {}\n' },
      { name: 'src/Constants.inc', content: '#define PROJECT_CONSTANT 1\n' },
      { name: 'src/Templates.hpp', content: '#include "Templates.ipp"\n#include "Templates.tpp"\n' },
      { name: 'src/Templates.ipp', content: 'template <typename T> T identity(T value) { return value; }\n' },
      { name: 'src/Templates.tpp', content: 'template <typename T> struct Box { T value; };\n' },
    ];

    expect(validateCompileRequest({ ...validRequest(), files })).toEqual({
      ok: true,
      request: { ...validRequest(), files },
    });
  });

  it('accepts only the exact root partitions.csv project file', () => {
    const main = validRequest().files[0]!;
    const partitions = {
      name: 'partitions.csv',
      content: 'nvs,data,nvs,0x9000,0x5000,\n',
    };

    expect(validateCompileRequest({
      ...validRequest(),
      files: [main, partitions],
    })).toEqual({
      ok: true,
      request: { ...validRequest(), files: [main, partitions] },
    });

    for (const name of [
      'config/partitions.csv',
      'PARTITIONS.CSV',
      'partitions.txt',
      'partition.csv',
    ]) {
      expect(validateCompileRequest({
        ...validRequest(),
        files: [main, { ...partitions, name }],
      })).toMatchObject({ ok: false });
    }
  });

  it('拒绝歧义或可逃逸的项目文件集合', () => {
    const main = validRequest().files[0]!;
    const invalidFiles = [
      [{ name: 'helper.cpp', content: '' }],
      [main, { name: '../secret.h', content: '' }],
      [main, { name: 'src\\secret.h', content: '' }],
      [main, { name: 'payload.o', content: '' }],
      [main, { name: 'src/Foo.h', content: '' }, { name: 'other/foo.h', content: '' }],
      [main, { name: 'src/Util.cpp', content: '' }, { name: 'SRC/util.CPP', content: '' }],
      [main, { name: 'src/Bad.h', content: 'before\0after' }],
    ];

    for (const files of invalidFiles) {
      expect(validateCompileRequest({ ...validRequest(), files })).toMatchObject({ ok: false });
    }
    expect(validateCompileRequest({
      ...validRequest(),
      files: [main, { name: 'other.ino', content: 'int helperTab() { return 1; }\n' }],
    })).toMatchObject({
      ok: true,
      request: { files: expect.arrayContaining([expect.objectContaining({ name: 'other.ino' })]) },
    });
    expect(validateCompileRequest({
      ...validRequest(),
      files: [main, ...Array.from({ length: MAX_PROJECT_FILES }, (_, index) => ({
        name: `f${index}.h`, content: '',
      }))],
    })).toMatchObject({ ok: false });
  });

  it('对整个项目而不是单个文件执行源码总量限制', () => {
    expect(validateCompileRequest({
      ...validRequest(),
      files: [
        { name: 'main.ino', content: 'a'.repeat(Math.floor(MAX_SOURCE_BYTES / 2) + 1) },
        { name: 'extra.h', content: 'b'.repeat(Math.floor(MAX_SOURCE_BYTES / 2) + 1) },
      ],
    })).toMatchObject({ ok: false });
  });

  it('把畸形源码和选项归类为 invalid_request，而不是抛内部异常', async () => {
    const compiler = service();
    const malformedFile = { ...validRequest(), files: [{ name: 'main.ino', content: 42 }] } as unknown as CompileRequest;
    const malformedOptions = { ...validRequest(), options: { speed: 42 } } as unknown as CompileRequest;

    await expect(compiler.compile(malformedFile)).resolves.toMatchObject({ status: 'error', reason: 'invalid_request' });
    await expect(compiler.compile(malformedOptions)).resolves.toMatchObject({ status: 'error', reason: 'invalid_request' });
  });

  it('对辅助源码和头文件执行与 ino 相同的安全预检', async () => {
    const req = validRequest();
    req.files.push({
      name: 'src/secret.cpp',
      content: 'asm(".incbin \\"/etc/passwd\\"");\n',
    });

    await expect(service().compile(req)).resolves.toMatchObject({
      status: 'error',
      reason: 'rejected',
      diagnostics: [expect.objectContaining({ file: 'src/secret.cpp', line: 1 })],
    });
  });

  it('拒绝平台没有提供的精确库版本', async () => {
    const req = validRequest();
    req.libraries = [{ name: 'Demo', version: '9.9.9' }];

    await expect(service().planActionGraph(req)).rejects.toThrow(/requested version 9\.9\.9/);
    await expect(service().compile(req)).resolves.toMatchObject({
      status: 'error',
      reason: 'invalid_request',
      message: expect.stringContaining('platform provides 1.2.3'),
    });
  });
});
