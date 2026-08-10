import { describe, expect, it } from 'vitest';

import {
  escapeSyntaxHtml,
  highlightArduino,
  tokenizeArduino,
} from '../public/syntax-highlight.js';

describe('Arduino/C++ syntax highlighting', () => {
  it('escapes all HTML-sensitive characters in plain text and highlighted tokens', () => {
    const source = 'if (value < 2 && value > 0) Serial.println("<script>&\\\"");';
    const html = highlightArduino(source);

    expect(html).not.toContain('<script>');
    expect(html).toContain('value &lt;');
    expect(html).toContain('&amp;&amp; value &gt;');
    expect(html).toContain('&quot;&lt;script&gt;&amp;\\&quot;&quot;');
    expect(escapeSyntaxHtml('"\'&<>')).toBe('&quot;&#39;&amp;&lt;&gt;');
  });

  it('highlights a typical Arduino sketch without coloring identifier substrings', () => {
    const source = [
      '#include <Arduino.h>',
      'const int outputPin = LED_BUILTIN;',
      'void setup() {',
      '  pinMode(outputPin, OUTPUT);',
      '  Serial.begin(115200);',
      '}',
      'void loopCounter() {',
      '  digitalWrite(outputPin, HIGH);',
      '  delay(1\'000UL);',
      '}',
    ].join('\n');
    const html = highlightArduino(source);

    expect(html).toContain('<span class="syntax-preprocessor">#include &lt;Arduino.h&gt;</span>');
    expect(html).toContain('<span class="syntax-keyword">const</span>');
    expect(html).toContain('<span class="syntax-keyword">int</span>');
    expect(html).toContain('<span class="syntax-constant">LED_BUILTIN</span>');
    expect(html).toContain('<span class="syntax-function">pinMode</span>');
    expect(html).toContain('<span class="syntax-function">Serial</span>');
    expect(html).toContain('<span class="syntax-function">begin</span>');
    expect(html).toContain('<span class="syntax-constant">OUTPUT</span>');
    expect(html).toContain('<span class="syntax-number">115200</span>');
    expect(html).toContain('<span class="syntax-number">1&#39;000UL</span>');
    expect(html).toContain('loopCounter');
    expect(html).not.toContain('<span class="syntax-function">loop</span>Counter');
  });

  it('keeps comment markers inside strings and code-like text inside comments inert', () => {
    const source = [
      'String url = "https://example.test/<board>?q=//";',
      "char marker = '<'; // <script> digitalWrite(HIGH)",
      '/* pinMode(LED_BUILTIN, OUTPUT); */',
    ].join('\n');
    const tokens = tokenizeArduino(source);
    const html = highlightArduino(source);

    expect(tokens.filter((token) => token.type === 'string').map((token) => token.value)).toEqual([
      '"https://example.test/<board>?q=//"',
      "'<'",
    ]);
    expect(tokens.filter((token) => token.type === 'comment').map((token) => token.value)).toEqual([
      '// <script> digitalWrite(HIGH)',
      '/* pinMode(LED_BUILTIN, OUTPUT); */',
    ]);
    expect(html).toContain('<span class="syntax-string">&quot;https://example.test/&lt;board&gt;?q=//&quot;</span>');
    expect(html).toContain('<span class="syntax-comment">// &lt;script&gt; digitalWrite(HIGH)</span>');
    expect(html).not.toContain('<span class="syntax-comment">//&quot;');
  });

  it('supports escaped, prefixed, and multiline raw C++ strings', () => {
    const source = [
      'const char* escaped = "quote: \\\" // still text";',
      'const char* wide = u8"pinMode";',
      'const char* raw = R"tag(line 1',
      '/* still string */ <tag>',
      'line 3)tag";',
    ].join('\n');
    const strings = tokenizeArduino(source)
      .filter((token) => token.type === 'string')
      .map((token) => token.value);

    expect(strings).toEqual([
      '"quote: \\\" // still text"',
      'u8"pinMode"',
      'R"tag(line 1\n/* still string */ <tag>\nline 3)tag"',
    ]);
  });

  it('highlights indented preprocessor directives and their continued lines as one token', () => {
    const source = '  #define SCALE(value) \\\r\n    ((value) * 2)\r\nint result = SCALE(3);';
    const tokens = tokenizeArduino(source);
    const directive = tokens.find((token) => token.type === 'preprocessor');

    expect(directive?.value).toBe('#define SCALE(value) \\\r\n    ((value) * 2)');
    expect(highlightArduino(source)).toContain(
      '  <span class="syntax-preprocessor">#define SCALE(value) \\\r\n    ((value) * 2)</span>',
    );
  });

  it('recognizes common C++ numeric forms', () => {
    const source = '0xFFUL 0b101010 0755 3.14159f .5 2. 6.02e23 42LL';
    const numbers = tokenizeArduino(source)
      .filter((token) => token.type === 'number')
      .map((token) => token.value);

    expect(numbers).toEqual([
      '0xFFUL',
      '0b101010',
      '0755',
      '3.14159f',
      '.5',
      '2.',
      '6.02e23',
      '42LL',
    ]);
  });

  it('preserves the source exactly so it can mirror a textarea overlay', () => {
    const source = 'void setup() {\r\n\t// keep tabs and CRLF\r\n}\r\n';
    const rebuilt = tokenizeArduino(source).map((token) => token.value).join('');

    expect(rebuilt).toBe(source);
    expect(highlightArduino('')).toBe('');
    expect(highlightArduino(null)).toBe('');
  });
});
