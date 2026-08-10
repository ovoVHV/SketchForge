const CPP_KEYWORDS = new Set([
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'auto',
  'bitand',
  'bitor',
  'bool',
  'break',
  'case',
  'catch',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'compl',
  'concept',
  'const',
  'consteval',
  'constexpr',
  'constinit',
  'const_cast',
  'continue',
  'co_await',
  'co_return',
  'co_yield',
  'decltype',
  'default',
  'delete',
  'do',
  'double',
  'dynamic_cast',
  'else',
  'enum',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'register',
  'reinterpret_cast',
  'requires',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'static_cast',
  'struct',
  'switch',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typedef',
  'typeid',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'wchar_t',
  'while',
  'xor',
  'xor_eq',
  'boolean',
  'byte',
  'word',
  'String',
  'size_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'int64_t',
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'uint64_t',
]);

const ARDUINO_CONSTANTS = new Set([
  'HIGH',
  'LOW',
  'INPUT',
  'OUTPUT',
  'INPUT_PULLUP',
  'INPUT_PULLDOWN',
  'LED_BUILTIN',
  'LSBFIRST',
  'MSBFIRST',
  'CHANGE',
  'FALLING',
  'RISING',
  'DEFAULT',
  'EXTERNAL',
  'INTERNAL',
  'INTERNAL1V1',
  'INTERNAL2V56',
  'PI',
  'HALF_PI',
  'TWO_PI',
  'DEG_TO_RAD',
  'RAD_TO_DEG',
  'SERIAL',
  'DISPLAY',
  'LSB',
  'MSB',
  'WL_NO_SHIELD',
  'WL_IDLE_STATUS',
  'WL_NO_SSID_AVAIL',
  'WL_SCAN_COMPLETED',
  'WL_CONNECTED',
  'WL_CONNECT_FAILED',
  'WL_CONNECTION_LOST',
  'WL_DISCONNECTED',
]);

const ARDUINO_FUNCTIONS = new Set([
  'setup',
  'loop',
  'pinMode',
  'digitalRead',
  'digitalWrite',
  'analogRead',
  'analogWrite',
  'analogReference',
  'analogReadResolution',
  'analogWriteResolution',
  'tone',
  'noTone',
  'shiftIn',
  'shiftOut',
  'pulseIn',
  'pulseInLong',
  'millis',
  'micros',
  'delay',
  'delayMicroseconds',
  'min',
  'max',
  'abs',
  'constrain',
  'map',
  'pow',
  'sq',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'random',
  'randomSeed',
  'lowByte',
  'highByte',
  'bitRead',
  'bitWrite',
  'bitSet',
  'bitClear',
  'bit',
  'attachInterrupt',
  'detachInterrupt',
  'interrupts',
  'noInterrupts',
  'yield',
  'isAlphaNumeric',
  'isAlpha',
  'isAscii',
  'isWhitespace',
  'isControl',
  'isDigit',
  'isGraph',
  'isLowerCase',
  'isPrintable',
  'isPunct',
  'isSpace',
  'isUpperCase',
  'isHexadecimalDigit',
  'Serial',
  'Serial1',
  'Serial2',
  'Wire',
  'SPI',
  'WiFi',
  'begin',
  'end',
  'available',
  'availableForWrite',
  'read',
  'peek',
  'flush',
  'write',
  'print',
  'println',
  'setTimeout',
  'parseInt',
  'parseFloat',
  'status',
  'localIP',
  'disconnect',
  'scanNetworks',
  'SSID',
  'RSSI',
  'macAddress',
]);

export const ARDUINO_SYNTAX_CLASSES = Object.freeze({
  comment: 'syntax-comment',
  string: 'syntax-string',
  preprocessor: 'syntax-preprocessor',
  keyword: 'syntax-keyword',
  number: 'syntax-number',
  constant: 'syntax-constant',
  function: 'syntax-function',
});

const HTML_ESCAPE = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const STRING_PREFIXES = Object.freeze([
  { prefix: 'u8R"', raw: true },
  { prefix: 'uR"', raw: true },
  { prefix: 'UR"', raw: true },
  { prefix: 'LR"', raw: true },
  { prefix: 'R"', raw: true },
  { prefix: 'u8"', raw: false },
  { prefix: "u8'", raw: false },
  { prefix: 'u"', raw: false },
  { prefix: "u'", raw: false },
  { prefix: 'U"', raw: false },
  { prefix: "U'", raw: false },
  { prefix: 'L"', raw: false },
  { prefix: "L'", raw: false },
]);

const NUMBER_PATTERN = /^(?:0[xX][0-9A-Fa-f](?:'?[0-9A-Fa-f])*(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)?|0[bB][01](?:'?[01])*(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)?|(?:(?:[0-9](?:'?[0-9])*)?\.[0-9](?:'?[0-9])*|[0-9](?:'?[0-9])*\.(?:[0-9](?:'?[0-9])*)?)(?:[eE][+-]?[0-9](?:'?[0-9])*)?[fFlL]?|[0-9](?:'?[0-9])*[eE][+-]?[0-9](?:'?[0-9])*[fFlL]?|[0-9](?:'?[0-9])*(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?|[fF])?)/;

function toSource(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function isIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function pushToken(tokens, type, value) {
  if (value.length === 0) {
    return;
  }
  const previous = tokens[tokens.length - 1];
  if (previous?.type === type) {
    previous.value += value;
    return;
  }
  tokens.push({ type, value });
}

function stringStartAt(source, index) {
  const character = source[index];
  if (character === '"' || character === "'") {
    return { quoteIndex: index, raw: false };
  }
  if (isIdentifierPart(source[index - 1])) {
    return null;
  }
  for (const candidate of STRING_PREFIXES) {
    if (source.startsWith(candidate.prefix, index)) {
      return {
        quoteIndex: index + candidate.prefix.length - 1,
        raw: candidate.raw,
      };
    }
  }
  return null;
}

function scanQuotedString(source, start, quoteIndex) {
  const quote = source[quoteIndex];
  let cursor = quoteIndex + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      if (source[cursor + 1] === '\r' && source[cursor + 2] === '\n') {
        cursor += 3;
      } else {
        cursor += Math.min(2, source.length - cursor);
      }
      continue;
    }
    if (character === quote) {
      return cursor + 1;
    }
    if (character === '\r' || character === '\n') {
      return cursor;
    }
    cursor += 1;
  }
  return source.length;
}

function scanRawString(source, start, quoteIndex) {
  const delimiterStart = quoteIndex + 1;
  let openingParenthesis = delimiterStart;
  while (openingParenthesis < source.length && openingParenthesis - delimiterStart <= 16) {
    const character = source[openingParenthesis];
    if (character === '(') {
      break;
    }
    if (character === '\\' || character === ')' || /\s/.test(character)) {
      return scanQuotedString(source, start, quoteIndex);
    }
    openingParenthesis += 1;
  }
  if (source[openingParenthesis] !== '(') {
    return scanQuotedString(source, start, quoteIndex);
  }
  const delimiter = source.slice(delimiterStart, openingParenthesis);
  const terminator = `)${delimiter}"`;
  const closing = source.indexOf(terminator, openingParenthesis + 1);
  return closing === -1 ? source.length : closing + terminator.length;
}

function scanPreprocessor(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    let lineEnd = cursor;
    while (lineEnd < source.length && source[lineEnd] !== '\r' && source[lineEnd] !== '\n') {
      lineEnd += 1;
    }
    if (lineEnd === source.length) {
      return source.length;
    }
    let slashCursor = lineEnd - 1;
    let slashCount = 0;
    while (slashCursor >= start && source[slashCursor] === '\\') {
      slashCount += 1;
      slashCursor -= 1;
    }
    if (slashCount % 2 === 0) {
      return lineEnd;
    }
    cursor = lineEnd + (
      source[lineEnd] === '\r' && source[lineEnd + 1] === '\n' ? 2 : 1
    );
  }
  return source.length;
}

function identifierType(identifier) {
  if (CPP_KEYWORDS.has(identifier)) {
    return 'keyword';
  }
  if (ARDUINO_CONSTANTS.has(identifier)) {
    return 'constant';
  }
  if (ARDUINO_FUNCTIONS.has(identifier)) {
    return 'function';
  }
  return 'plain';
}

export function escapeSyntaxHtml(value) {
  return toSource(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

export function tokenizeArduino(sourceValue) {
  const source = toSource(sourceValue);
  const tokens = [];
  let cursor = 0;
  let linePrefixIsWhitespace = true;

  while (cursor < source.length) {
    const character = source[cursor];

    if (character === '\r' || character === '\n') {
      const end = character === '\r' && source[cursor + 1] === '\n' ? cursor + 2 : cursor + 1;
      pushToken(tokens, 'plain', source.slice(cursor, end));
      cursor = end;
      linePrefixIsWhitespace = true;
      continue;
    }

    if (linePrefixIsWhitespace && (character === ' ' || character === '\t')) {
      let end = cursor + 1;
      while (source[end] === ' ' || source[end] === '\t') {
        end += 1;
      }
      pushToken(tokens, 'plain', source.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (linePrefixIsWhitespace && character === '#') {
      const end = scanPreprocessor(source, cursor);
      pushToken(tokens, 'preprocessor', source.slice(cursor, end));
      cursor = end;
      linePrefixIsWhitespace = false;
      continue;
    }

    linePrefixIsWhitespace = false;

    if (source.startsWith('//', cursor)) {
      let end = cursor + 2;
      while (end < source.length && source[end] !== '\r' && source[end] !== '\n') {
        end += 1;
      }
      pushToken(tokens, 'comment', source.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (source.startsWith('/*', cursor)) {
      const closing = source.indexOf('*/', cursor + 2);
      const end = closing === -1 ? source.length : closing + 2;
      pushToken(tokens, 'comment', source.slice(cursor, end));
      cursor = end;
      continue;
    }

    const stringStart = stringStartAt(source, cursor);
    if (stringStart !== null) {
      const end = stringStart.raw
        ? scanRawString(source, cursor, stringStart.quoteIndex)
        : scanQuotedString(source, cursor, stringStart.quoteIndex);
      pushToken(tokens, 'string', source.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (isIdentifierStart(character)) {
      let end = cursor + 1;
      while (isIdentifierPart(source[end])) {
        end += 1;
      }
      const identifier = source.slice(cursor, end);
      pushToken(tokens, identifierType(identifier), identifier);
      cursor = end;
      continue;
    }

    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[cursor + 1] ?? ''))) {
      const number = NUMBER_PATTERN.exec(source.slice(cursor))?.[0];
      if (number) {
        pushToken(tokens, 'number', number);
        cursor += number.length;
        continue;
      }
    }

    pushToken(tokens, 'plain', character);
    cursor += 1;
  }

  return tokens;
}

export function highlightArduino(source) {
  return tokenizeArduino(source).map((token) => {
    const escaped = escapeSyntaxHtml(token.value);
    const className = ARDUINO_SYNTAX_CLASSES[token.type];
    return className ? `<span class="${className}">${escaped}</span>` : escaped;
  }).join('');
}
