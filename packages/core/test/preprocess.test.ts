import { describe, it, expect } from 'vitest';
import { composeArduinoSketch, preprocess, GENERATED_FILE } from '../src/preprocess/index.js';
import { scanFunctions } from '../src/preprocess/functions.js';

/** 从生成的 cpp 里取出第 n 行（1-based） */
const cppLine = (cpp: string, n: number) => cpp.split('\n')[n - 1];

describe('函数识别', () => {
  it('识别顶层函数并生成原型', () => {
    const src = ['void loop() {', '  helper();', '}', '', 'int helper() {', '  return 1;', '}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['loop', 'helper']);
    expect(functions.map((f) => f.prototype)).toEqual(['void loop();', 'int helper();']);
  });

  it('解决"函数在定义前被调用"——这正是自动生成原型的意义', () => {
    const src = ['void setup() { helper(); }', 'void loop() {}', 'void helper() {}'].join('\n');
    const { functions } = scanFunctions(src);
    // helper 的原型必须出现在 setup 之前，否则编译不过
    expect(functions.map((f) => f.name)).toContain('helper');
  });

  it('注释里的假函数不能被识别', () => {
    const src = [
      '// void fake1() {',
      '/* void fake2() { } */',
      'void real() {}',
    ].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['real']);
  });

  it('字符串里的花括号不能扰乱层级计数', () => {
    const src = [
      'void a() { Serial.println("}{ void fake() {"); }',
      'void b() {}',
    ].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('原始字符串 R"(...)" 内容被正确遮罩', () => {
    const src = ['void a() {', '  const char* s = R"(} void fake() {)";', '}', 'void b() {}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('回溯不能穿过 #include 指令', () => {
    const src = ['#include <Servo.h>', 'void setup() {}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions).toHaveLength(1);
    // 返回类型必须是干净的 "void"，不能把 #include 那行卷进来
    expect(functions[0]!.returnType).toBe('void');
    expect(functions[0]!.prototype).toBe('void setup();');
  });

  it('前一条语句以分号结束时，返回类型不被污染', () => {
    const src = ['Servo myServo;', 'int counter = 0;', 'void setup() {}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions[0]!.prototype).toBe('void setup();');
  });

  // ---- 以下全部是"吃不准就跳过"铁律的验证 ----

  it('跳过带默认参数的函数（生成原型反而会编译不过）', () => {
    const src = 'void beep(int times = 3) {}\nvoid setup() {}';
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['setup']);
  });

  it('跳过类成员函数（作用域不对）', () => {
    const src = ['class Foo {', 'public:', '  void method() {}', '};', 'void setup() {}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['setup']);
  });

  it('跳过 extern "C"（会丢失链接规约）', () => {
    const src = 'extern "C" void isr() {}\nvoid setup() {}';
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['setup']);
  });

  it('跳过模板函数', () => {
    const src = 'template<typename T> T maxOf(T a, T b) { return a > b ? a : b; }\nvoid setup() {}';
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['setup']);
  });

  it('跳过尾置返回类型', () => {
    const src = 'auto f(int x) -> int { return x; }\nvoid setup() {}';
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['setup']);
  });

  it('不把控制语句误认为函数', () => {
    const src = ['void setup() {', '  if (true) {}', '  for (int i=0;i<3;i++) {}', '  while (0) {}', '}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions.map((f) => f.name)).toEqual(['setup']);
  });

  it('已有的函数声明（原型）不被当成定义', () => {
    const src = 'void helper();\nvoid setup() { helper(); }\nvoid helper() {}';
    const { functions } = scanFunctions(src);
    // 只有两个定义：setup 和 helper
    expect(functions.map((f) => f.name)).toEqual(['setup', 'helper']);
  });

  it('保留 static / inline 限定符', () => {
    const src = 'static int counter() { return 1; }\nvoid setup() {}';
    const { functions } = scanFunctions(src);
    expect(functions[0]!.prototype).toBe('static int counter();');
  });

  it('指针返回值与多参数', () => {
    const src = 'const char* pick(int a, const char *b) { return b; }\nvoid setup() {}';
    const { functions } = scanFunctions(src);
    expect(functions[0]!.prototype).toBe('const char* pick(int a, const char *b);');
  });

  it('跨行的参数列表被压成单行原型（行映射依赖这个前提）', () => {
    const src = ['void f(', '  int a,', '  int b', ') {}', 'void setup() {}'].join('\n');
    const { functions } = scanFunctions(src);
    expect(functions[0]!.prototype).toBe('void f( int a, int b );');
    expect(functions[0]!.prototype).not.toContain('\n');
  });
});

describe('Arduino sketch tabs', () => {
  it('concatenates tabs with exact source-line ownership', () => {
    const composition = composeArduinoSketch([
      { path: 'main.ino', content: '#include <Arduino.h>\nvoid setup() {}\n' },
      { path: 'Other.ino', content: 'int value = 1;\r\nint helper() { return value; }\r\n' },
    ]);
    const processed = preprocess(composition.source, { sourceName: 'main.ino' });
    const helper = processed.functions.find((fn) => fn.name === 'helper')!;

    expect(composition.source).toContain('#line 1 "Other.ino"\n');
    expect(composition.lineOrigins.get(helper.line)).toEqual({
      sourceFile: 'Other.ino',
      sourceLine: 2,
    });
    expect(processed.cpp).toContain('#line 1 "Other.ino"');
  });

  it('restores the active tab after generated prototypes', () => {
    const composition = composeArduinoSketch([
      { path: 'main.ino', content: '#include <Arduino.h>\nint value = 1;\n' },
      { path: 'Other.ino', content: 'void setup() { missing(); }\nvoid loop() {}\n' },
    ]);
    const processed = preprocess(composition.source, { sourceName: 'main.ino' });

    expect(processed.cpp).toContain(
      '#line 1 "<generated>"\nvoid setup();\nvoid loop();\n#line 1 "Other.ino"\nvoid setup() { missing(); }',
    );
    expect(processed.cpp).not.toContain('#line 4 "main.ino"\nvoid setup()');
  });
});

describe('行号映射', () => {
  it('#line 指令让用户代码行号精确对齐', () => {
    const src = ['#include <Servo.h>', 'Servo s;', '', 'void setup() {', '  s.attach(9);', '}'].join('\n');
    const { cpp } = preprocess(src, { sourceName: 'main.ino' });

    expect(cppLine(cpp, 1)).toBe('#include <Arduino.h>');
    expect(cppLine(cpp, 2)).toBe('#line 1 "main.ino"');
    // 第 3 行起就是用户第 1 行
    expect(cppLine(cpp, 3)).toBe('#include <Servo.h>');
    expect(cppLine(cpp, 4)).toBe('Servo s;');
    expect(cppLine(cpp, 5)).toBe('');
    // 生成块用独立伪文件名隔离
    expect(cppLine(cpp, 6)).toBe(`#line 1 "${GENERATED_FILE}"`);
    expect(cppLine(cpp, 7)).toBe('void setup();');
    // 切回用户文件，下一行就是用户第 4 行
    expect(cppLine(cpp, 8)).toBe('#line 4 "main.ino"');
    expect(cppLine(cpp, 9)).toBe('void setup() {');
  });

  it('生成的原型行号可回溯到函数定义位置', () => {
    const src = ['void setup() {}', '', '', 'int helper() { return 0; }'].join('\n');
    const { generatedLineToFunction } = preprocess(src);
    expect(generatedLineToFunction.get(1)!.name).toBe('setup');
    expect(generatedLineToFunction.get(1)!.line).toBe(1);
    expect(generatedLineToFunction.get(2)!.name).toBe('helper');
    expect(generatedLineToFunction.get(2)!.line).toBe(4);
  });

  it('CRLF 源码归一化后行号不变', () => {
    const src = 'void setup() {}\r\nvoid loop() {}\r\n';
    const r = preprocess(src);
    expect(r.normalizedSource).not.toContain('\r');
    expect(r.functions.map((f) => f.line)).toEqual([1, 2]);
  });

  it('无函数定义时原样输出，不插入生成块', () => {
    const src = '#define X 1\nint a = X;\n';
    const { cpp, functions } = preprocess(src);
    expect(functions).toHaveLength(0);
    expect(cpp).not.toContain(GENERATED_FILE);
    expect(cppLine(cpp, 3)).toBe('#define X 1');
  });

  it.each(['', '  \n\t'])('为空白工程生成 setup/loop 空桩', (src) => {
    const result = preprocess(src);
    expect(result.normalizedSource).toBe(src);
    expect(result.cpp).toContain(`#line 1 "${GENERATED_FILE}"`);
    expect(result.cpp).toContain('void setup() {}');
    expect(result.cpp).toContain('void loop() {}');
    expect(result.functions).toEqual([]);
  });

  it('文件名里的引号和反斜杠被正确转义', () => {
    const { cpp } = preprocess('void setup() {}', { sourceName: 'a"b\\c.ino' });
    expect(cppLine(cpp, 2)).toBe('#line 1 "a\\"b\\\\c.ino"');
  });
});
