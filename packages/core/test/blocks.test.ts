import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { collectLibraryBlocks, reviewBlocksMetadata } from '../src/blocks/collector.js';
import { assembleBlockProgram, canonicalBlockVariableName, createBlocklyLibraryBundle } from '../src/blocks/generator.js';
import { createBlocksMetadata, validateBlocksMetadata } from '../src/blocks/schema.js';
import { readBlocksMetadata, writeBlocksMetadata } from '../src/blocks/storage.js';
import { loadLibrary } from '../src/toolchain/library.js';

const roots: string[] = [];
const digest = (value: string) => value.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function metadata() {
  const body = {
    schema: 1 as const,
    kind: 'ck-library-blocks' as const,
    library: { name: 'Demo', version: '1.0.0', sourceSha256: digest('a') },
    generatedAt: '2026-08-08T00:00:00.000Z',
    review: { status: 'approved' as const, reviewer: 'reviewer', reviewedAt: '2026-08-08T00:01:00.000Z' },
    category: { id: 'category:demo', name: 'Demo', colour: 120 },
    evidence: [{
      id: 'evidence:demo', kind: 'header' as const, file: 'src/Demo.h', line: 4,
      excerpt: 'void setPin(uint8_t pin);', sha256: digest('b'),
    }],
    blocks: [{
      type: 'demo_set_pin', message: 'set pin %1 label %2',
      inputs: [
        { name: 'pin', label: 'pin', kind: 'pin' as const, default: '0' },
        { name: 'label', label: 'label', kind: 'text' as const, default: '' },
      ],
      shape: 'statement' as const,
      colour: 120,
      tooltip: 'Set a pin',
      code: {
        includes: [{ key: 'include:demo', code: '#include <Demo.h>' }],
        globals: [{ key: 'global:demo', code: 'Demo {{var:device}};' }],
        setup: [{ key: 'setup:demo', code: '{{var:device}}.begin();' }],
        body: '{{var:device}}.setPin({{pin}}, {{label}});',
      },
      evidence: ['evidence:demo'],
    }],
  };
  return createBlocksMetadata(body);
}

describe('blocks.json schema and Blockly generator', () => {
  it('binds metadata to a digest and rejects unknown placeholders or tampering', () => {
    const value = metadata();
    expect(validateBlocksMetadata(value)).toMatchObject({ valid: true });
    expect(validateBlocksMetadata({ ...value, generatedAt: '2027-01-01T00:00:00.000Z' }).errors)
      .toContain('metadataSha256 does not match the body');
    const bad = createBlocksMetadata({
      ...value,
      blocks: [{ ...value.blocks[0]!, code: { ...value.blocks[0]!.code, body: '{{missing}};' } }],
    });
    expect(validateBlocksMetadata(bad).errors.join(' ')).toMatch(/unknown input missing/);
  });

  it('generates Blockly JSON, canonical C++, four regions, and block line mappings', () => {
    const value = metadata();
    const bundle = createBlocklyLibraryBundle(value, {
      pinOptions: [{ label: 'D13', value: '13' }],
    });
    expect(bundle.definitions[0]).toMatchObject({
      type: 'demo_set_pin', previousStatement: null, nextStatement: null,
      args0: [{ type: 'field_dropdown', options: [['D13', '13']] }, { type: 'field_input' }],
    });
    const block = (id: string, label: string) => bundle.generate({
      id, type: 'demo_set_pin',
      getFieldValue: (name) => name === 'pin' ? '13' : label,
    }, { valueToCode: () => '' });
    const first = block('block-a', 'alpha');
    const second = block('block-b', 'beta');
    const program = assembleBlockProgram([first, second]);
    expect(program.code.match(/#include <Demo.h>/g)).toHaveLength(1);
    expect(program.code.match(/\.begin\(\)/g)).toHaveLength(1);
    expect(program.code).toContain('.setPin(13, "alpha");');
    expect(program.sourceMap['block-a']!.startLine).toBeLessThan(program.sourceMap['block-b']!.startLine);
    expect(program.semanticSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalBlockVariableName('device')).toBe(canonicalBlockVariableName('device'));
    expect(canonicalBlockVariableName('device')).not.toBe(canonicalBlockVariableName('other'));
    expect(() => assembleBlockProgram([
      first,
      { ...second, includes: [{ key: 'include:demo', code: '#include <Other.h>' }] },
    ])).toThrow(/conflicting generated code/);
  });
});

describe('blocks metadata collector', () => {
  it('creates an evidence-backed draft and requires explicit review before public use', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-blocks-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'examples', 'Basic'), { recursive: true });
    writeFileSync(join(root, 'library.properties'), [
      'name=Sensor Demo', 'version=1.2.3', 'architectures=*', 'includes=SensorDemo.h',
    ].join('\n'));
    writeFileSync(join(root, 'src', 'SensorDemo.h'), [
      '#pragma once',
      'class SensorDemo {',
      ' public:',
      '  void begin(uint8_t pin);',
      '  float readValue() const;',
      ' private:',
      '  void secret();',
      '};',
      'bool sensorReady();',
    ].join('\n'));
    writeFileSync(join(root, 'keywords.txt'), 'SensorDemo\tKEYWORD1\nbegin\tKEYWORD2\nreadValue\tKEYWORD2\n');
    writeFileSync(join(root, 'examples', 'Basic', 'Basic.ino'), [
      '#include <SensorDemo.h>', 'SensorDemo sensor;', 'void setup() { sensor.begin(13); }',
      'void loop() { sensor.readValue(); }',
    ].join('\n'));
    const library = loadLibrary(root)!;
    const draft = collectLibraryBlocks(library, { generatedAt: '2026-08-08T00:00:00.000Z' });
    expect(draft.review.status).toBe('draft');
    expect(draft.blocks.some((block) => block.type.includes('begin'))).toBe(true);
    expect(draft.blocks.some((block) => block.type.includes('readvalue'))).toBe(true);
    expect(draft.blocks.some((block) => block.type.includes('secret'))).toBe(false);
    expect(draft.evidence.some((item) => item.kind === 'example')).toBe(true);
    expect(() => createBlocklyLibraryBundle(draft)).toThrow(/approved/);
    const approved = reviewBlocksMetadata(
      draft, 'approved', 'alice', 'API checked', '2026-08-08T00:05:00.000Z',
    );
    writeBlocksMetadata(root, approved);
    expect(readBlocksMetadata(root, true)).toEqual(approved);
    expect(createBlocklyLibraryBundle(approved).definitions.length).toBeGreaterThan(0);
  });
});
