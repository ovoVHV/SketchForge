import type { ArduinoPropertyEntry, ArduinoPropertyFile } from './types.js';

/** Parse the Arduino property-file subset used by platform/board metadata. */
export function parseArduinoProperties(source: string): ArduinoPropertyFile {
  const entries: ArduinoPropertyEntry[] = [];
  const physicalLines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let logical = '';
  let logicalLine = 1;

  const consume = (): void => {
    const text = logical.trim();
    logical = '';
    if (!text || text.startsWith('#') || text.startsWith('!')) return;
    const separator = propertySeparator(text);
    const rawKey = separator < 0 ? text : text.slice(0, separator);
    let valueOffset = separator < 0 ? text.length : separator + 1;
    while (valueOffset < text.length && /[\s:=]/.test(text[valueOffset]!)) valueOffset += 1;
    const key = unescapeProperty(rawKey.trim());
    if (!key) throw new TypeError(`empty Arduino property key at line ${logicalLine}`);
    entries.push({ key, value: unescapeProperty(text.slice(valueOffset)), line: logicalLine });
  };

  for (let index = 0; index < physicalLines.length; index += 1) {
    const line = physicalLines[index]!;
    if (!logical) logicalLine = index + 1;
    const continuation = hasContinuation(line);
    const part = continuation ? line.slice(0, -1) : line;
    logical += logical ? part.trimStart() : part;
    if (!continuation) consume();
  }
  if (logical) consume();

  const properties: Record<string, string> = {};
  for (const entry of entries) properties[entry.key] = entry.value;
  return { entries, properties: sortRecord(properties) };
}

function propertySeparator(value: string): number {
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '=' || char === ':' || /\s/.test(char)) return index;
  }
  return -1;
}

function hasContinuation(value: string): boolean {
  let slashes = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function unescapeProperty(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escaped: string) => {
    if (escaped.startsWith('u')) return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    if (escaped === 't') return '\t';
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 'f') return '\f';
    return escaped;
  });
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]!]));
}
