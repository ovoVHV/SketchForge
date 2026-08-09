import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseManifest, loadLibrary, LibraryRegistry } from '../src/toolchain/library.js';

// ---------------------------------------------------------------------------
// 用合成 fixture，保证测试可移植（不依赖某台机器上装了哪些库）
// ---------------------------------------------------------------------------

let root: string;
let avrPlatformLibraries: string;
let esp32PlatformLibraries: string;
let laterEsp32Libraries: string;
let duplicateEsp32Libraries: string;

function mkLib(
  folder: string,
  props: Record<string, string>,
  files: Record<string, string>,
  baseDir = root,
): void {
  const dir = join(baseDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'library.properties'),
    Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n'),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'af-libs-'));

  // 1.5 布局
  mkLib('Modern_Lib', { name: 'Modern Lib', version: '2.0.0', architectures: 'avr' }, {
    'src/Modern.h': '#pragma once\nvoid modern();\n',
    'src/Modern.cpp': '#include "Modern.h"\nvoid modern() {}\n',
    'src/inner/Deep.cpp': 'int deep() { return 1; }\n',
    'examples/Demo/Demo.ino': 'void setup(){} void loop(){}\n',
  });

  // 1.0 布局：源码在根目录 + utility/，examples/ 必须被排除
  mkLib('Legacy_Lib', { name: 'Legacy Lib', version: '1.0.0', architectures: '*' }, {
    'Legacy.h': '#pragma once\n#include <Helper.h>\nvoid legacy();\n',
    'Legacy.cpp': '#include "Legacy.h"\nvoid legacy() {}\n',
    'utility/util.c': 'int util(void) { return 0; }\n',
    'examples/Demo/Demo.ino': 'void setup(){} void loop(){}\n',
    'examples/Demo/extra.cpp': 'int shouldNotBeCompiled() { return 1; }\n',
  });

  // 被隐式依赖的库（Legacy 在头文件里 include 了 Helper.h，但没写 depends）
  mkLib('Helper_Lib', { name: 'Helper Lib', version: '1.2.3', architectures: '*' }, {
    'Helper.h': '#pragma once\nvoid helper();\n',
    'Helper.cpp': '#include "Helper.h"\nvoid helper() {}\n',
  });

  // 显式声明依赖
  mkLib('Top_Lib', { name: 'Top Lib', version: '3.0.0', architectures: '*', depends: 'Legacy Lib' }, {
    'Top.h': '#pragma once\nvoid top();\n',
    'Top.cpp': '#include "Top.h"\nvoid top() {}\n',
  });

  // 仅 ESP32
  mkLib('Esp_Only', { name: 'Esp Only', version: '1.0.0', architectures: 'esp32' }, {
    'Esp.h': '#pragma once\n',
  });

  // 纯头文件库
  mkLib('Header_Only', { name: 'Header Only', version: '1.0.0', architectures: '*' }, {
    'src/HeaderOnly.h': '#pragma once\ninline int ho() { return 1; }\n',
  });

  // 带预编译二进制 —— 白名单流程应拒绝
  mkLib('Precompiled_Lib', { name: 'Precompiled Lib', version: '1.0.0', architectures: '*', precompiled: 'true' }, {
    'src/Pre.h': '#pragma once\n',
  });

  avrPlatformLibraries = join(root, 'platform-libraries', 'avr');
  esp32PlatformLibraries = join(root, 'platform-libraries', 'esp32');
  laterEsp32Libraries = join(root, 'platform-libraries', 'later-esp32');
  duplicateEsp32Libraries = join(root, 'platform-libraries', 'duplicate-esp32');

  mkLib('Wire', { name: 'Wire', version: '1.0.0', architectures: 'avr' }, {
    'src/Wire.h': '#pragma once\n#define WIRE_ARCH_AVR 1\n',
    'src/Wire.cpp': '#include <Wire.h>\n',
  }, avrPlatformLibraries);
  mkLib('Wire', { name: 'Wire', version: '3.3.7', architectures: 'esp32' }, {
    'src/Wire.h': '#pragma once\n#define WIRE_ARCH_ESP32 1\n',
    'src/Wire.cpp': '#include <Wire.h>\n',
  }, esp32PlatformLibraries);
  mkLib('EspConsumer', { name: 'ESP Consumer', version: '1.0.0', architectures: 'esp32' }, {
    'src/EspConsumer.h': '#pragma once\n',
    'src/EspConsumer.cpp': '#include <Wire.h>\n',
  }, esp32PlatformLibraries);
  mkLib('Wire', { name: 'Wire', version: '9.9.9', architectures: 'esp32' }, {
    'src/Wire.h': '#pragma once\n#define WIRE_ARCH_LATER_ESP32 1\n',
    'src/Wire.cpp': '#include <Wire.h>\n',
  }, laterEsp32Libraries);
  mkLib('Wire', { name: 'Wire', version: '3.3.7', architectures: 'esp32' }, {
    'src/Wire.h': '#pragma once\n#define WIRE_DIFFERENT_REVISION 1\n',
    'src/Wire.cpp': '#include <Wire.h>\n',
  }, duplicateEsp32Libraries);
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('library.properties 解析', () => {
  it('解析基本字段', () => {
    const m = parseManifest('name=Foo\nversion=1.2.3\narchitectures=avr,esp32\ncategory=Sensors\n');
    expect(m.name).toBe('Foo');
    expect(m.version).toBe('1.2.3');
    expect(m.architectures).toEqual(['avr', 'esp32']);
    expect(m.category).toBe('Sensors');
  });

  it('未声明架构时默认不限', () => {
    expect(parseManifest('name=Foo\n').architectures).toEqual(['*']);
  });

  it('剥掉 depends 里的版本约束', () => {
    const m = parseManifest('name=Foo\ndepends=Bar Lib (>=1.0.0),Baz\n');
    expect(m.depends).toEqual(['Bar Lib', 'Baz']);
  });

  it('识别 precompiled（白名单流程要据此硬拒）', () => {
    expect(parseManifest('name=F\nprecompiled=true\n').precompiled).toBe(true);
    expect(parseManifest('name=F\nprecompiled=full\n').precompiled).toBe(true);
    expect(parseManifest('name=F\n').precompiled).toBe(false);
  });

  it('忽略注释与空行', () => {
    expect(parseManifest('# 注释\n\nname=Foo\n').name).toBe('Foo');
  });
});

describe('目录布局', () => {
  it('1.5 布局：src/ 下递归收集源文件', () => {
    const lib = loadLibrary(join(root, 'Modern_Lib'))!;
    expect(lib.layout).toBe('1.5');
    expect(lib.sources).toHaveLength(2); // Modern.cpp + inner/Deep.cpp
    expect(lib.includeDirs).toHaveLength(1);
  });

  it('1.5 布局不会把 examples/ 卷进来', () => {
    const lib = loadLibrary(join(root, 'Modern_Lib'))!;
    expect(lib.sources.every((s) => !/examples/.test(s))).toBe(true);
  });

  it('1.0 布局：只取根目录 + utility/，**绝不递归**', () => {
    const lib = loadLibrary(join(root, 'Legacy_Lib'))!;
    expect(lib.layout).toBe('1.0');
    // Legacy.cpp + utility/util.c；examples/ 下那个 extra.cpp 必须被排除
    expect(lib.sources).toHaveLength(2);
    expect(lib.sources.some((s) => /extra\.cpp/.test(s))).toBe(false);
    expect(lib.includeDirs).toHaveLength(2); // 根目录 + utility
  });

  it('纯头文件库没有可编译源文件', () => {
    const lib = loadLibrary(join(root, 'Header_Only'))!;
    expect(lib.sources).toHaveLength(0);
  });

  it('无 library.properties 的目录不算库', () => {
    expect(loadLibrary(join(root, '不存在'))).toBeNull();
  });

  it('accepts a direct library root as well as a parent library directory', () => {
    const direct = LibraryRegistry.fromDirectories([join(root, 'Modern_Lib')]);
    const parent = LibraryRegistry.fromDirectories([root]);

    expect(direct.get('Modern Lib')?.manifest.version).toBe('2.0.0');
    expect(parent.get('Modern Lib')?.manifest.version).toBe('2.0.0');
  });
});

describe('依赖解析', () => {
  const reg = () => LibraryRegistry.fromDirectories([root]);

  it('按显示名索引，而非文件夹名', () => {
    // 文件夹叫 Legacy_Lib，库名叫 "Legacy Lib"
    expect(reg().get('Legacy Lib')).toBeTruthy();
    expect(reg().get('Legacy_Lib')).toBeUndefined();
  });

  it('展开 depends 声明的依赖', () => {
    const r = reg().resolve(['Top Lib'], 'avr');
    expect(r.errors).toEqual([]);
    expect(r.libraries.map((l) => l.manifest.name)).toContain('Legacy Lib');
  });

  it('依赖排在被依赖者之前（解析顺序）', () => {
    const names = reg().resolve(['Top Lib'], 'avr').libraries.map((l) => l.manifest.name);
    expect(names.indexOf('Legacy Lib')).toBeLessThan(names.indexOf('Top Lib'));
  });

  it('从库源码的 #include 发现未声明的隐式依赖', () => {
    // Legacy Lib 的头文件 include 了 Helper.h，但 depends 里没写 ——
    // 内置库（Wire/SPI）在现实中就是这种情况
    const names = reg().resolve(['Legacy Lib'], 'avr').libraries.map((l) => l.manifest.name);
    expect(names).toContain('Helper Lib');
    expect(names.indexOf('Helper Lib')).toBeLessThan(names.indexOf('Legacy Lib'));
  });

  it('未知库报错而非静默忽略', () => {
    const r = reg().resolve(['Nope'], 'avr');
    expect(r.errors.some((e) => e.includes('Nope'))).toBe(true);
  });

  it('架构不匹配时报错', () => {
    const r = reg().resolve(['Esp Only'], 'avr');
    expect(r.errors.some((e) => e.includes('不支持'))).toBe(true);
  });

  it('架构为 * 的库任何板子都能用', () => {
    expect(reg().resolve(['Helper Lib'], 'avr').errors).toEqual([]);
    expect(reg().resolve(['Helper Lib'], 'esp32').errors).toEqual([]);
  });

  it('从 sketch 的 #include 自动探测', () => {
    const detected = reg().detectFromSource('#include <Legacy.h>\nvoid setup(){}\n', 'avr');
    expect(detected).toContain('Legacy Lib');
  });

  it('注释掉的 #include 不算数', () => {
    const detected = reg().detectFromSource('// #include <Legacy.h>\n/* #include <Top.h> */\nvoid setup(){}\n', 'avr');
    expect(detected).toEqual([]);
  });

  it('显式声明与自动探测合并，并标出哪些是自动来的', () => {
    const r = reg().resolveForSketch(['Top Lib'], '#include <Helper.h>\n', 'avr');
    expect(r.errors).toEqual([]);
    expect(r.autoDetected).toContain('Helper Lib');
    expect(r.autoDetected).not.toContain('Top Lib');
  });

  it('项目自带头文件优先于同名平台库的自动探测', () => {
    const ignored = new Set(['Legacy.h']);
    const r = reg().resolveForSketch([], '#include <Legacy.h>\n', 'avr', ignored);

    expect(r.errors).toEqual([]);
    expect(r.libraries).toEqual([]);
    expect(r.autoDetected).toEqual([]);
  });
});

describe('architecture-aware platform library candidates', () => {
  const registry = () => LibraryRegistry.fromDirectories([
    avrPlatformLibraries,
    esp32PlatformLibraries,
    laterEsp32Libraries,
  ]);

  it('selects same-name and same-header platform libraries by target architecture', () => {
    const libraries = registry();

    expect(libraries.get('Wire', 'avr')?.rootDir).toBe(join(avrPlatformLibraries, 'Wire'));
    expect(libraries.get('Wire', 'esp32')?.rootDir).toBe(join(esp32PlatformLibraries, 'Wire'));

    const avr = libraries.resolveForSketch([], '#include <Wire.h>\n', 'avr');
    const esp32 = libraries.resolveForSketch([], '#include <Wire.h>\n', 'esp32');
    expect(avr.errors).toEqual([]);
    expect(esp32.errors).toEqual([]);
    expect(avr.libraries[0]?.rootDir).toBe(join(avrPlatformLibraries, 'Wire'));
    expect(esp32.libraries[0]?.rootDir).toBe(join(esp32PlatformLibraries, 'Wire'));
  });

  it('keeps configured directory priority for candidates of the same architecture', () => {
    const libraries = registry();
    const resolved = libraries.resolve(['Wire'], 'esp32');

    expect(resolved.errors).toEqual([]);
    expect(resolved.libraries[0]?.manifest.version).toBe('3.3.7');
    expect(resolved.libraries[0]?.rootDir).toBe(join(esp32PlatformLibraries, 'Wire'));
  });

  it('selects an explicitly requested version before applying directory priority', () => {
    const resolved = registry().resolve([{ name: 'Wire', version: '9.9.9' }], 'esp32');

    expect(resolved.errors).toEqual([]);
    expect(resolved.libraries[0]?.rootDir).toBe(join(laterEsp32Libraries, 'Wire'));
  });

  it('rejects same-name and same-version libraries from different source revisions', () => {
    const libraries = LibraryRegistry.fromDirectories([
      join(esp32PlatformLibraries, 'Wire'),
      join(duplicateEsp32Libraries, 'Wire'),
    ]);
    const resolved = libraries.resolve([{ name: 'Wire', version: '3.3.7' }], 'esp32');

    expect(resolved.libraries).toEqual([]);
    expect(resolved.errors.join(' ')).toMatch(/Wire@3\.3\.7.*ambiguous.*source revisions/i);
    expect(() => libraries.list('esp32')).toThrow(/Wire@3\.3\.7.*ambiguous.*source revisions/i);
  });

  it('uses the architecture-compatible candidate for implicit library dependencies', () => {
    const resolved = registry().resolve(['ESP Consumer'], 'esp32');
    const wire = resolved.libraries.find((lib) => lib.manifest.name === 'Wire');

    expect(resolved.errors).toEqual([]);
    expect(wire?.rootDir).toBe(join(esp32PlatformLibraries, 'Wire'));
  });
});
