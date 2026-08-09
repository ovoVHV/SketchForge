import { describe, it, expect } from 'vitest';
import { preprocess } from '../src/preprocess/index.js';
import { parseDiagnostics, type RemapContext } from '../src/diagnostics/parse.js';
import { createSanitizer, identitySanitizer } from '../src/diagnostics/sanitize.js';

function ctxFor(src: string, sanitize = identitySanitizer): RemapContext {
  const p = preprocess(src, { sourceName: 'main.ino' });
  return {
    sourceName: p.sourceName,
    sourceLineCount: p.sourceLineCount,
    generatedLineToFunction: p.generatedLineToFunction,
    sanitize,
  };
}

const SKETCH = [
  '#include <Servo.h>', // 1
  'Servo s;',           // 2
  '',                   // 3
  'void setup() {',     // 4
  '  digitlWrite(13);', // 5  ← 故意拼错
  '}',                  // 6
  '',                   // 7
  'void loop() {}',     // 8
].join('\n');

describe('诊断解析与行号回映射', () => {
  it('用户代码错误直接落在正确的 .ino 行列上', () => {
    const out = `main.ino:5:3: error: 'digitlWrite' was not declared in this scope`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d).toMatchObject({
      severity: 'error',
      file: 'main.ino',
      line: 5,
      column: 3,
    });
    expect(d!.message).toContain('digitlWrite');
    expect(d!.unmapped).toBeUndefined();
  });

  it('折叠 "suggested alternative" 成一条可直接操作的提示', () => {
    const out = [
      `main.ino:5:3: error: 'digitlWrite' was not declared in this scope`,
      `main.ino:5:3: note: suggested alternative: 'digitalWrite'`,
    ].join('\n');
    const diags = parseDiagnostics(out, ctxFor(SKETCH));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('digitalWrite');
    expect(diags[0]!.message).toContain('是不是想写');
  });

  it('生成的原型报错回溯到对应函数定义的真实行', () => {
    // setup 在第 4 行、loop 在第 8 行 → <generated>:2 对应 loop
    const out = `<generated>:2:1: error: 'Widget' does not name a type`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.line).toBe(8);
    expect(d!.fromGenerated).toBe(true);
    expect(d!.message).toContain('loop');
  });

  it('头文件里的错误顺 #include 链回溯到用户的 include 行', () => {
    const out = [
      'In file included from main.ino:1:',
      '/opt/libs/Servo/Servo.h:45:2: error: #error "Board not supported"',
    ].join('\n');
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    // 落到用户第 1 行（那句 #include <Servo.h>）
    expect(d!.line).toBe(1);
    expect(d!.message).toContain('Servo.h:45');
    expect(d!.unmapped).toBeUndefined();
  });

  it('多级 #include 链取最外层（最接近用户代码的一层）', () => {
    const out = [
      'In file included from /opt/libs/Servo/Servo_impl.h:3,',
      '                 from main.ino:1:',
      '/opt/libs/Servo/Servo_impl.h:9:1: error: boom',
    ].join('\n');
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.line).toBe(1);
  });

  it('越界行号被标记为 unmapped 而不是骗前端', () => {
    const out = `main.ino:9999:1: error: something`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.unmapped).toBe(true);
    expect(d!.line).toBeLessThanOrEqual(8);
  });

  it('无文件归属的编译器级错误不被丢弃', () => {
    const out = `cc1plus: error: out of memory allocating 1234 bytes`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.severity).toBe('error');
    expect(d!.message).toContain('out of memory');
    expect(d!.unmapped).toBe(true);
  });

  it('丢弃源码回显行与插入符行', () => {
    const out = [
      `main.ino:5:3: error: 'digitlWrite' was not declared in this scope`,
      '    5 |   digitlWrite(13);',
      '      |   ^~~~~~~~~~~',
    ].join('\n');
    expect(parseDiagnostics(out, ctxFor(SKETCH))).toHaveLength(1);
  });

  it('warning 与 error 严重级正确区分', () => {
    const out = [
      `main.ino:5:3: warning: unused variable 'x'`,
      `main.ino:6:1: error: expected '}'`,
    ].join('\n');
    const diags = parseDiagnostics(out, ctxFor(SKETCH));
    expect(diags.map((d) => d.severity)).toEqual(['warning', 'error']);
  });

  it('保留项目辅助源码的相对路径和真实行号', () => {
    const ctx: RemapContext = {
      ...ctxFor(SKETCH),
      projectFiles: [{ name: 'src/MathBox.cpp', lineCount: 3 }],
    };
    const [d] = parseDiagnostics(
      'C:\\work\\build\\project\\src\\MathBox.cpp:2:7: error: expected expression',
      ctx,
    );

    expect(d).toMatchObject({ file: 'src/MathBox.cpp', line: 2, column: 7 });
    expect(d!.unmapped).toBeUndefined();
  });

  it('平台头文件经辅助源码 include 时回到该辅助源码', () => {
    const ctx: RemapContext = {
      ...ctxFor(SKETCH),
      projectFiles: [{ name: 'src/MathBox.cpp', lineCount: 3 }],
    };
    const out = [
      'In file included from C:\\work\\build\\project\\src\\MathBox.cpp:1:',
      '/opt/libs/Servo/Servo.h:45:2: error: #error "Board not supported"',
    ].join('\n');
    const [d] = parseDiagnostics(out, ctx);

    expect(d).toMatchObject({ file: 'src/MathBox.cpp', line: 1 });
    expect(d!.message).toContain('Servo.h:45');
  });

});

describe('链接器错误', () => {
  // ld 的输出不带 `error:` 前缀，格式和编译器完全不同。
  // 不单独识别的话整段会被丢弃，用户只看到 "collect2: ld returned 1 exit status"。

  it('带位置的 undefined reference 落到正确行', () => {
    const out = `main.ino:5: undefined reference to \`helper()'`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.severity).toBe('error');
    expect(d!.line).toBe(5);
    expect(d!.message).toContain('helper()');
    expect(d!.unmapped).toBeUndefined();
  });

  it('项目辅助源码里的链接错误保留其相对路径', () => {
    const ctx: RemapContext = {
      ...ctxFor(SKETCH),
      projectFiles: [{ name: 'src/MathBox.cpp', lineCount: 3 }],
    };
    const [d] = parseDiagnostics(
      'C:/work/build/project/src/MathBox.cpp:3: undefined reference to `missing()`',
      ctx,
    );

    expect(d).toMatchObject({ file: 'src/MathBox.cpp', line: 3 });
    expect(d!.unmapped).toBeUndefined();
  });

  it('归属到库归档的 undefined reference 不被丢弃', () => {
    const out = `lib0.a(Adafruit_SSD1306.cpp.o):(.text+0x1a): undefined reference to \`Wire'`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d).toBeTruthy();
    expect(d!.severity).toBe('error');
    expect(d!.unmapped).toBe(true);
    expect(d!.message).toContain('Wire');
  });

  it('给出人话解释而不是原样甩 ld 输出', () => {
    const [d] = parseDiagnostics(`main.ino:5: undefined reference to \`helper()'`, ctxFor(SKETCH));
    expect(d!.message).toMatch(/找不到|定义/);
  });

  it('识别 multiple definition', () => {
    const out = `lib0.a(a.o):(.bss+0x0): multiple definition of \`counter'`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.message).toContain('重复定义');
  });

  it('识别程序超出板子容量', () => {
    const out = `avr-ld: main.elf section \`.text' will not fit in region \`text'`;
    const [d] = parseDiagnostics(out, ctxFor(SKETCH));
    expect(d!.message).toContain('存储空间');
  });

  it('已有真实错误时，collect2 的汇总行被抑制', () => {
    const out = [
      `main.ino:5: undefined reference to \`helper()'`,
      `collect2.exe: error: ld returned 1 exit status`,
    ].join('\n');
    const diags = parseDiagnostics(out, ctxFor(SKETCH));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('helper()');
  });

  it('没有其他错误时，collect2 汇总行仍要保留（否则用户看不到任何信息）', () => {
    const out = `collect2.exe: error: ld returned 1 exit status`;
    expect(parseDiagnostics(out, ctxFor(SKETCH))).toHaveLength(1);
  });
});

describe('路径清洗', () => {
  const sanitize = createSanitizer({
    buildDir: 'C:\\tmp\\build-abc123',
    toolchainDir: 'C:\\opt\\avr-gcc',
    coreDir: 'C:\\opt\\cores\\avr',
    librariesDirs: ['C:\\opt\\libraries', 'C:\\Users\\me\\Documents\\Arduino\\libraries'],
  });

  it('抹掉构建目录，只留相对文件名', () => {
    expect(sanitize('C:\\tmp\\build-abc123\\sketch\\main.cpp:5: error')).not.toContain('build-abc123');
  });

  it('工具链目录换成占位符', () => {
    const s = sanitize('C:\\opt\\avr-gcc\\bin\\avr-g++.exe: fatal error');
    expect(s).toContain('<toolchain>');
    expect(s).not.toContain('C:\\opt\\avr-gcc');
  });

  it('正反斜杠两种写法都能命中', () => {
    expect(sanitize('C:/opt/libraries/Servo/Servo.h')).toContain('<libraries>');
  });

  it('多个库根目录都能命中（内置库 + 用户库）', () => {
    expect(sanitize('C:\\Users\\me\\Documents\\Arduino\\libraries\\Adafruit_GFX\\Adafruit_GFX.h'))
      .toContain('<libraries>');
  });

  it('不咬碎报错里的 URL', () => {
    // 曾经的 bug：https://deb.li/bubblewrap → <httpbubblewrap>
    const s = sanitize('See <https://deb.li/bubblewrap> or <file:///usr/share/doc/x/README.gz>');
    expect(s).toContain('https://deb.li/bubblewrap');
    expect(s).not.toContain('httpbubblewrap');
  });

  it('兜底：未登记的绝对路径只留文件名', () => {
    expect(sanitize('/usr/lib/gcc/secret/internal.h:3: note')).toBe('internal.h:3: note');
    expect(sanitize('D:\\somewhere\\else\\thing.cpp:1')).toBe('thing.cpp:1');
  });

  it('不误伤普通文本和 include 尖括号', () => {
    expect(sanitize("'digitalWrite' was not declared in this scope")).toBe(
      "'digitalWrite' was not declared in this scope",
    );
  });
});
