import { describe, expect, it } from 'vitest';
import {
  ESP32C3_GCC_INTEGER_ABI_FLAGS,
  ESP32C3_UNUSED_SDK_ARCHIVES,
  ESP32C5_UNUSED_SDK_ARCHIVES,
  ESP32C6_UNUSED_SDK_ARCHIVES,
  ESP32H2_UNUSED_SDK_ARCHIVES,
  ESP32P4_UNUSED_SDK_ARCHIVES,
  makeEsp32C3LldCompatibleLdLibs,
  makeEsp32C5LldCompatibleInputs,
  makeEsp32C5LldCompatibleLdLibs,
  makeEsp32C5WasmCompatibleCppFlags,
  makeEsp32C6LldCompatibleInputs,
  makeEsp32C6LldCompatibleLdLibs,
  makeEsp32C6WasmCompatibleCppFlags,
  makeEsp32H2LldCompatibleInputs,
  makeEsp32H2LldCompatibleLdLibs,
  makeEsp32H2WasmCompatibleCppFlags,
  makeEsp32P4LldCompatibleInputs,
  makeEsp32P4LldCompatibleLdLibs,
  makeEsp32P4WasmCompatibleCppFlags,
  makeEsp32S2LldCompatibleInputs,
  makeEsp32S2LldCompatibleLdLibs,
  makeEsp32S2WasmCompatibleCppFlags,
  makeEsp32S3LldCompatibleInputs,
  makeEsp32S3LldCompatibleLdLibs,
  makeEsp32S3WasmCompatibleCppFlags,
  makeEsp32XtensaLldCompatibleInputs,
  makeEsp32XtensaLldCompatibleLdLibs,
  makeEsp32XtensaWasmCompatibleCppFlags,
  selectEsp32C3LldArchiveNames,
  selectEsp32C5LldArchiveNames,
  selectEsp32C6LldArchiveNames,
  selectEsp32H2LldArchiveNames,
  selectEsp32P4LldArchiveNames,
  selectEsp32XtensaLldArchiveNames,
} from '../../../scripts/esp32c3-lld-compat.js';

function c5CompatibilityInputs(
  extRamBlock: readonly string[] = [
    '  .ext_ram.dummy (NOLOAD):',
    '  {',
    '    . = ORIGIN(extern_ram_seg);',
    '    . = . + (_rodata_reserved_end - _flash_rodata_dummy_start);',
    '    . = ALIGN (0x10000);',
    '  } > extern_ram_seg',
  ],
  extraLines: readonly string[] = [],
) {
  return {
    ldFlags: '-Wl,--cref -Wl,--no-warn-rwx-segments -Wl,--gc-sections\n',
    memoryLd: [
      '_data_seg_org = ORIGIN(rtc_data_seg);',
      'ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "dummy")',
      '',
    ].join('\n'),
    sectionsLd: [
      '  } > sram_seg',
      '  /**',
      '   * This section holds data that should not be initialized at power up.',
      '  /**',
      '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
      '   * Thus, it must have its alignment and (at least) its size.',
      '   */',
      '  .flash_rodata_dummy (NOLOAD):',
      '  {',
      '    _flash_rodata_dummy_start = .;',
      '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
      '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
      '    . = ALIGN(0x10000) + 0x20;',
      '  } > default_rodata_seg',
      '  .flash.appdesc : ALIGN(0x10)',
      ...extRamBlock,
      ...extraLines,
      '',
    ].join('\n'),
  };
}

describe('ESP32-C3 GCC integer ABI compatibility', () => {
  it('deduplicates only repeated library switches while preserving order', () => {
    expect(makeEsp32C3LldCompatibleLdLibs(
      '-lfirst -Wl,--whole-archive -lsecond -lfirst -Wl,--whole-archive -lthird\n',
    )).toBe('-lfirst -Wl,--whole-archive -lsecond -Wl,--whole-archive -lthird\n');
  });

  it('keeps network provisioning and drops the overlapping legacy WiFi component', () => {
    const input = [
      '-lfirst',
      '-lwifi_provisioning',
      '-lespressif__network_provisioning',
      '-lwifi_provisioning',
      '-lespressif__network_provisioning',
      '-llast',
    ].join(' ');
    const expected = '-lfirst -lespressif__network_provisioning -llast\n';
    expect(makeEsp32C3LldCompatibleLdLibs(input)).toBe(expected);
    expect(makeEsp32C6LldCompatibleLdLibs(input)).toBe(expected);
    expect(makeEsp32C5LldCompatibleLdLibs(input)).toBe(expected);
    expect(makeEsp32XtensaLldCompatibleLdLibs(input)).toBe(expected);
    expect(makeEsp32S2LldCompatibleLdLibs(input)).toBe(expected);
    expect(makeEsp32S3LldCompatibleLdLibs(input)).toBe(expected);
    expect(makeEsp32H2LldCompatibleLdLibs('-lespressif__network_provisioning\n'))
      .toBe('-lespressif__network_provisioning\n');
    expect(makeEsp32P4LldCompatibleLdLibs('-lespressif__network_provisioning\n'))
      .toBe('-lespressif__network_provisioning\n');
  });

  it('excludes only pinned archives that the linker response cannot select', () => {
    const archives = ['libfreertos.a', ...ESP32C3_UNUSED_SDK_ARCHIVES, 'libwifi.a'];
    expect(selectEsp32C3LldArchiveNames(archives, '-lfreertos -lwifi\n')).toEqual([
      'libfreertos.a',
      'libwifi.a',
    ]);
  });

  it('fails closed when an excluded archive becomes referenced or disappears', () => {
    const archives = ['libfreertos.a', ...ESP32C3_UNUSED_SDK_ARCHIVES];
    expect(() => selectEsp32C3LldArchiveNames(archives, '-lesp_zb_api.zczr'))
      .toThrow(/became referenced/);
    expect(() => selectEsp32C3LldArchiveNames(
      archives.filter((name) => name !== ESP32C3_UNUSED_SDK_ARCHIVES[0]),
      '-lfreertos',
    ))
      .toThrow(/is missing/);
  });

  it('overrides every Clang integer typedef that differs from Espressif RV32 GCC', () => {
    expect(ESP32C3_GCC_INTEGER_ABI_FLAGS).toEqual([
      '-U__INT32_TYPE__',
      '-D__INT32_TYPE__=long int',
      '-U__UINT32_TYPE__',
      '-D__UINT32_TYPE__=long unsigned int',
      '-U__INT_LEAST32_TYPE__',
      '-D__INT_LEAST32_TYPE__=long int',
      '-U__UINT_LEAST32_TYPE__',
      '-D__UINT_LEAST32_TYPE__=long unsigned int',
      '-U__INT_FAST8_TYPE__',
      '-D__INT_FAST8_TYPE__=int',
      '-U__UINT_FAST8_TYPE__',
      '-D__UINT_FAST8_TYPE__=unsigned int',
      '-U__INT_FAST16_TYPE__',
      '-D__INT_FAST16_TYPE__=int',
      '-U__UINT_FAST16_TYPE__',
      '-D__UINT_FAST16_TYPE__=unsigned int',
    ]);
  });

  it('keeps each built-in undef immediately before its replacement', () => {
    for (let index = 0; index < ESP32C3_GCC_INTEGER_ABI_FLAGS.length; index += 2) {
      const undefine = ESP32C3_GCC_INTEGER_ABI_FLAGS[index]!;
      const define = ESP32C3_GCC_INTEGER_ABI_FLAGS[index + 1]!;
      expect(undefine.startsWith('-U__')).toBe(true);
      expect(define.startsWith(`-D${undefine.slice(2)}=`)).toBe(true);
    }
  });
});

describe('ESP32-C6 LLD compatibility', () => {
  it('moves the RTC alias and places fini arrays in C6 SRAM', () => {
    const result = makeEsp32C6LldCompatibleInputs({
      ldFlags: '-nostartfiles -Wl,--cref -Wl,--no-warn-rwx-segments -Wl,--gc-sections\n',
      memoryLd: [
        'MEMORY {}',
        '_data_seg_org = ORIGIN(rtc_data_seg);',
        'REGION_ALIAS("rtc_data_seg", rtc_iram_seg );',
        'ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "dummy starts at rodata origin")',
        '',
      ].join('\n'),
      sectionsLd: [
        'SECTIONS',
        '{',
        '  .data :',
        '  {',
        '    _data_end = ABSOLUTE(.);',
        '  } > sram_seg',
        '  /**',
        '   * This section holds data that should not be initialized at power up.',
        '   */',
        '  /**',
        '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
        '   * Thus, it must have its alignment and (at least) its size.',
        '   */',
        '  .flash_rodata_dummy (NOLOAD):',
        '  {',
        '    _flash_rodata_dummy_start = .;',
        '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
        '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
        '    . = ALIGN(0x10000) + 0x20;',
        '  } > default_rodata_seg',
        '  .flash.appdesc : ALIGN(0x10)',
        '  {',
        '  } > default_rodata_seg',
        '}',
        '',
      ].join('\n'),
    });

    expect(result.ldFlags).toBe('-nostartfiles -Wl,--gc-sections\n');
    expect(result.memoryLd.trimEnd().endsWith('_data_seg_org = ORIGIN(rtc_data_seg);')).toBe(true);
    expect(result.sectionsLd).toContain('__fini_array_end = ABSOLUTE(.);\n  } > sram_seg');
    expect(result.sectionsLd).toContain('_flash_rodata_dummy_start = ORIGIN(default_rodata_seg);');
    expect(result.sectionsLd).toContain(
      '.flash.appdesc (ALIGN(ALIGN(ORIGIN(default_rodata_seg), ALIGNOF(.flash.text)) + SIZEOF(.flash.text), 0x10000) + 0x20) : ALIGN(0x10)',
    );
    expect(result.sectionsLd).not.toContain('.flash_rodata_dummy (NOLOAD):');
  });

  it('fails closed when the pinned C6 flash rodata dummy layout is absent', () => {
    expect(() => makeEsp32C6LldCompatibleInputs({
      ldFlags: '-Wl,--cref -Wl,--no-warn-rwx-segments\n',
      memoryLd: [
        '_data_seg_org = ORIGIN(rtc_data_seg);',
        'ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "dummy starts at rodata origin")',
        '',
      ].join('\n'),
      sectionsLd: [
        '  } > sram_seg',
        '  /**',
        '   * This section holds data that should not be initialized at power up.',
        '',
      ].join('\n'),
    })).toThrow(/exactly one pinned flash rodata dummy block/);
  });

  it('fails closed when another script starts consuming the C6 dummy section', () => {
    const base = {
      ldFlags: '-Wl,--cref -Wl,--no-warn-rwx-segments\n',
      memoryLd: [
        '_data_seg_org = ORIGIN(rtc_data_seg);',
        'ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "dummy starts at rodata origin")',
        '',
      ].join('\n'),
      sectionsLd: [
        '  } > sram_seg',
        '  /**',
        '   * This section holds data that should not be initialized at power up.',
        '  /**',
        '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
        '   * Thus, it must have its alignment and (at least) its size.',
        '   */',
        '  .flash_rodata_dummy (NOLOAD):',
        '  {',
        '    _flash_rodata_dummy_start = .;',
        '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
        '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
        '    . = ALIGN(0x10000) + 0x20;',
        '  } > default_rodata_seg',
        '  .flash.appdesc : ALIGN(0x10)',
        '  {',
        '    unexpected = SIZEOF(.flash_rodata_dummy);',
        '  } > default_rodata_seg',
        '',
      ].join('\n'),
    };
    expect(() => makeEsp32C6LldCompatibleInputs(base)).toThrow(/unsupported address or size consumer/);
    expect(() => makeEsp32C6LldCompatibleInputs({
      ...base,
      memoryLd: '_data_seg_org = ORIGIN(rtc_data_seg);\n',
    })).toThrow(/exactly two flash rodata dummy start references/);
  });

  it('uses the C6 ISA flags while removing only unsupported Clang switches', () => {
    expect(makeEsp32C6WasmCompatibleCppFlags(
      '-march=rv32imac_zicsr_zifencei -freorder-blocks -fstrict-volatile-bitfields -fno-tree-switch-conversion -Os\n',
    )).toBe('-march=rv32imac_zicsr_zifencei -Os\n');
    expect(makeEsp32C6LldCompatibleLdLibs('-lfirst -lsecond -lfirst\n'))
      .toBe('-lfirst -lsecond\n');
  });

  it('excludes only the 14 Zigbee variants absent from the default C6 response file', () => {
    const archives = ['libfreertos.a', ...ESP32C6_UNUSED_SDK_ARCHIVES, 'libwifi.a'];
    expect(selectEsp32C6LldArchiveNames(archives, '-lfreertos -lwifi\n'))
      .toEqual(['libfreertos.a', 'libwifi.a']);
    expect(() => selectEsp32C6LldArchiveNames(archives, '-lfreertos -lesp_zb_api.ed\n'))
      .toThrow(/became referenced/);
  });
});

describe('ESP32-C5 LLD compatibility', () => {
  it('removes both overlapping dummy sections and uses the shared C6 archive profile', () => {
    const result = makeEsp32C5LldCompatibleInputs(c5CompatibilityInputs());

    expect(result.ldFlags).toBe('-Wl,--gc-sections\n');
    expect(result.sectionsLd).toContain('__fini_array_end = ABSOLUTE(.);\n  } > sram_seg');
    expect(result.sectionsLd).toContain('_flash_rodata_dummy_start = ORIGIN(default_rodata_seg);');
    expect(result.sectionsLd).not.toContain('.flash_rodata_dummy (NOLOAD):');
    expect(result.sectionsLd).not.toContain('.ext_ram.dummy (NOLOAD):');
    expect(makeEsp32C5WasmCompatibleCppFlags(
      '-march=rv32imac_zicsr_zifencei -freorder-blocks -fstrict-volatile-bitfields -fno-tree-switch-conversion -Os\n',
    )).toBe('-march=rv32imac_zicsr_zifencei -Os\n');
    expect(makeEsp32C5LldCompatibleLdLibs('-lfirst -lsecond -lfirst\n'))
      .toBe('-lfirst -lsecond\n');

    expect(ESP32C5_UNUSED_SDK_ARCHIVES).toBe(ESP32C6_UNUSED_SDK_ARCHIVES);
    const archives = ['libfreertos.a', ...ESP32C5_UNUSED_SDK_ARCHIVES, 'libwifi.a'];
    expect(selectEsp32C5LldArchiveNames(archives, '-lfreertos -lwifi\n'))
      .toEqual(['libfreertos.a', 'libwifi.a']);
  });

  it('fails closed if the C5 external RAM dummy is missing or gains a consumer', () => {
    expect(() => makeEsp32C5LldCompatibleInputs(c5CompatibilityInputs([])))
      .toThrow(/exactly one pinned external RAM dummy block/);
    expect(() => makeEsp32C5LldCompatibleInputs(c5CompatibilityInputs(undefined, [
      '  unexpected = SIZEOF(.ext_ram.dummy);',
    ]))).toThrow(/gained an unsupported reference/);
  });
});

describe('ESP32-H2 LLD compatibility', () => {
  it('applies the unified-bus layout and pinned H2 archive profile', () => {
    const result = makeEsp32H2LldCompatibleInputs({
      ldFlags: '-Wl,--cref -Wl,--no-warn-rwx-segments -Wl,--gc-sections\n',
      memoryLd: [
        '_data_seg_org = ORIGIN(rtc_data_seg);',
        'ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "dummy")',
        '',
      ].join('\n'),
      sectionsLd: [
        '  } > sram_seg',
        '  /**',
        '   * This section holds data that should not be initialized at power up.',
        '  /**',
        '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
        '   * Thus, it must have its alignment and (at least) its size.',
        '   */',
        '  .flash_rodata_dummy (NOLOAD):',
        '  {',
        '    _flash_rodata_dummy_start = .;',
        '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
        '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
        '    . = ALIGN(0x10000) + 0x20;',
        '  } > default_rodata_seg',
        '  .flash.appdesc : ALIGN(0x10)',
        '',
      ].join('\n'),
    });

    expect(result.ldFlags).toBe('-Wl,--gc-sections\n');
    expect(result.sectionsLd).toContain('__fini_array_end = ABSOLUTE(.);\n  } > sram_seg');
    expect(result.sectionsLd).not.toContain('.flash_rodata_dummy (NOLOAD):');
    expect(makeEsp32H2WasmCompatibleCppFlags(
      '-march=rv32imac_zicsr_zifencei -freorder-blocks -fstrict-volatile-bitfields -fno-tree-switch-conversion -Os\n',
    )).toBe('-march=rv32imac_zicsr_zifencei -Os\n');
    expect(makeEsp32H2LldCompatibleLdLibs('-lfirst -lsecond -lfirst\n'))
      .toBe('-lfirst -lsecond\n');

    const archives = ['libfreertos.a', ...ESP32H2_UNUSED_SDK_ARCHIVES, 'libwifi.a'];
    expect(selectEsp32H2LldArchiveNames(archives, '-lfreertos -lwifi\n'))
      .toEqual(['libfreertos.a', 'libwifi.a']);
  });
});

describe('ESP32-P4 LLD compatibility', () => {
  function p4Inputs() {
    return {
      ldFlags: [
        '-nostartfiles',
        '-march=rv32imafc_zicsr_zifencei_xesploop_xespv',
        '-mabi=ilp32f',
        '-Wl,--cref',
        '-Wl,--no-warn-rwx-segments',
        '-Wl,--enable-non-contiguous-regions',
        '-Wl,--gc-sections',
        '',
      ].join(' '),
      memoryLd: [
        '_data_seg_org = ORIGIN(rtc_data_seg);',
        'ASSERT(_flash_rodata_dummy_start == ORIGIN(rodata_seg_low), "dummy")',
        '',
      ].join('\n'),
      sectionsLd: [
        '  } > sram_high',
        '  /**',
        '   * This section holds data that should not be initialized at power up.',
        '  /**',
        '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
        '   * Thus, it must have its alignment and (at least) its size.',
        '   */',
        '  .flash_rodata_dummy (NOLOAD):',
        '  {',
        '    _flash_rodata_dummy_start = .;',
        '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
        '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
        '    . = ALIGN(0x10000) + 0x20;',
        '  } > rodata_seg_low',
        '  .flash.appdesc : ALIGN(0x10)',
        '',
      ].join('\n'),
    };
  }

  it('preserves hard-float and non-contiguous linking while removing unsupported P4 flags', () => {
    const result = makeEsp32P4LldCompatibleInputs(p4Inputs());

    expect(result.ldFlags).toBe(`${[
      '-nostartfiles',
      '-march=rv32imafc_zicsr_zifencei',
      '-mabi=ilp32f',
      '-Wl,--enable-non-contiguous-regions',
      '-Wl,--gc-sections',
    ].join(' ')}\n`);
    expect(result.sectionsLd).toContain('__fini_array_end = ABSOLUTE(.);\n  } > sram_high');
    expect(result.sectionsLd).toContain('_flash_rodata_dummy_start = ORIGIN(rodata_seg_low);');
    expect(result.sectionsLd).toContain(
      '.flash.appdesc (ALIGN(ALIGN(ORIGIN(rodata_seg_low), ALIGNOF(.flash.text)) + SIZEOF(.flash.text), 0x10000) + 0x20) : ALIGN(0x10)',
    );
    expect(result.sectionsLd).not.toContain('.flash_rodata_dummy (NOLOAD):');
  });

  it('replaces only the two pinned P4 vendor ISA flags', () => {
    expect(makeEsp32P4WasmCompatibleCppFlags([
      '-march=rv32imafc_zicsr_zifencei_xesploop_xespv',
      '-mabi=ilp32f',
      '-freorder-blocks',
      '-fstrict-volatile-bitfields',
      '-fno-tree-switch-conversion',
      '-march=rv32imafc_zicsr_zifencei_xesppie',
      '-Os',
      '',
    ].join(' '))).toBe(`${[
      '-march=rv32imafc_zicsr_zifencei',
      '-mabi=ilp32f',
      '-march=rv32imafc_zicsr_zifencei',
      '-Os',
    ].join(' ')}\n`);
    expect(() => makeEsp32P4WasmCompatibleCppFlags([
      '-march=rv32imafc_zicsr_zifencei_xesploop_xespv',
      '-freorder-blocks',
      '-fstrict-volatile-bitfields',
      '-fno-tree-switch-conversion',
      '',
    ].join(' '))).toThrow(/xesppie/);
  });

  it('keeps every P4 SDK archive because the response file references all of them', () => {
    expect(ESP32P4_UNUSED_SDK_ARCHIVES).toEqual([]);
    expect(selectEsp32P4LldArchiveNames(
      ['libriscv.a', 'libfreertos.a', 'libesp_wifi.a'],
      '-lriscv -lfreertos -lesp_wifi\n',
    )).toEqual(['libriscv.a', 'libfreertos.a', 'libesp_wifi.a']);
    expect(makeEsp32P4LldCompatibleLdLibs('-lriscv -lfreertos -lriscv\n'))
      .toBe('-lriscv -lfreertos\n');
  });

  it('fails closed when the P4 rodata segment or vendor link ISA changes', () => {
    expect(() => makeEsp32P4LldCompatibleInputs({
      ...p4Inputs(),
      sectionsLd: p4Inputs().sectionsLd.replace('> rodata_seg_low', '> default_rodata_seg'),
    })).toThrow(/pinned flash rodata dummy block/);
    expect(() => makeEsp32P4LldCompatibleInputs({
      ...p4Inputs(),
      ldFlags: p4Inputs().ldFlags.replace('_xesploop_xespv', ''),
    })).toThrow(/xesploop_xespv/);
  });
});

describe('ESP32 Xtensa Clang and LLD compatibility', () => {
  const commonCppFlags = [
    '-mlongcalls',
    '-freorder-blocks',
    '-fstrict-volatile-bitfields',
    '-fno-tree-switch-conversion',
    '-Os',
  ];
  const vectorOffsets = ['0x0', '0x180', '0x1c0', '0x200', '0x240', '0x280', '0x2c0', '0x300', '0x340', '0x3C0', '0x400'];
  const sectionsLd = (hasRtcTextMirror: boolean) => [
    'SECTIONS',
    '{',
    ...(hasRtcTextMirror ? [
      '  .rtc.dummy :',
      '  {',
      '    . = SIZEOF(.rtc.text);',
      '  } > rtc_data_seg',
    ] : []),
    '  .iram0.vectors :',
    '  {',
    ...vectorOffsets.map((offset) => `    . = ${offset};`),
    '    *(.*Vector.literal)',
    '  } > iram0_0_seg',
    '    KEEP (*(EXCLUDE_FILE (*crtend.* *crtbegin.*) .ctors SORT(.ctors.*)))',
    '  /**',
    '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
    '   * Thus, it must have its alignment and (at least) its size.',
    '   */',
    '  .flash_rodata_dummy (NOLOAD):',
    '  {',
    '    _flash_rodata_dummy_start = ABSOLUTE(.);',
    '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
    '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
    '    . = ALIGN(0x10000) + 0x20;',
    '  } > default_rodata_seg',
    '  .flash.appdesc : ALIGN(0x10)',
    '  .ext_ram.dummy (NOLOAD):',
    '  {',
    '    . = ORIGIN(extern_ram_seg);',
    '    . = . + (_rodata_reserved_end - _flash_rodata_dummy_start);',
    '    . = ALIGN (0x10000);',
    '  } > extern_ram_seg',
    '  /DISCARD/ :',
    '  {',
    '   *(.fini)',
    '   *(.eh_frame_hdr)',
    '  }',
    '}',
    '',
  ].join('\n');
  const linkerInputs = {
    ldFlags: '-mlongcalls -Wl,--cref -Wl,--no-warn-rwx-segments -Wl,--gc-sections\n',
    memoryLd: [
      'MEMORY {}',
      '_data_seg_org = ORIGIN(rtc_data_seg);',
      'REGION_ALIAS("rtc_data_seg", rtc_iram_seg );',
      'ASSERT(_flash_rodata_dummy_start == ORIGIN(default_rodata_seg), "dummy")',
      '',
    ].join('\n'),
    sectionsLd: sectionsLd(true),
  };

  it('removes only the pinned ESP32 and S3 GCC-only C++ flags', () => {
    for (const filter of [
      makeEsp32XtensaWasmCompatibleCppFlags,
      makeEsp32S3WasmCompatibleCppFlags,
    ]) {
      expect(filter([
        ...commonCppFlags,
        '-mdisable-hardware-atomics',
        '',
      ].join(' '))).toBe('-mlongcalls -freorder-blocks -Os\n');
    }
  });

  it('uses the S2 SDK shape without inventing an atomic flag', () => {
    expect(makeEsp32S2WasmCompatibleCppFlags([...commonCppFlags, ''].join(' ')))
      .toBe('-mlongcalls -freorder-blocks -Os\n');
    expect(() => makeEsp32S2WasmCompatibleCppFlags([
      ...commonCppFlags,
      '-mdisable-hardware-atomics',
      '',
    ].join(' '))).toThrow(/unexpectedly contains -mdisable-hardware-atomics/);
  });

  it('fails closed when a pinned Xtensa GCC-only flag disappears', () => {
    expect(() => makeEsp32XtensaWasmCompatibleCppFlags([
      '-mlongcalls',
      '-freorder-blocks',
      '-fstrict-volatile-bitfields',
      '-mdisable-hardware-atomics',
      '',
    ].join(' '))).toThrow(/-fno-tree-switch-conversion/);
  });

  it('anchors GNU-relative Xtensa section offsets for LLD', () => {
    for (const transform of [makeEsp32XtensaLldCompatibleInputs, makeEsp32S2LldCompatibleInputs]) {
      const result = transform(linkerInputs);
      expect(result.ldFlags).toBe('-mlongcalls -Wl,--cref -Wl,--gc-sections\n');
      expect(result.memoryLd).toBe(linkerInputs.memoryLd);
      expect(result.sectionsLd).toContain('    . = ORIGIN(rtc_data_seg) + SIZEOF(.rtc.text);');
      for (const offset of vectorOffsets) {
        expect(result.sectionsLd).toContain(`    . = ORIGIN(iram0_0_seg) + ${offset};`);
      }
      expect(result.sectionsLd).toContain(
        '    *(.Level2InterruptVector.literal)\n    . = ORIGIN(iram0_0_seg) + 0x180;',
      );
      expect(result.sectionsLd).toContain(
        '    *(.DoubleExceptionVector.literal)\n    . = ORIGIN(iram0_0_seg) + 0x3C0;',
      );
      expect(result.sectionsLd).not.toContain('*(.*Vector.literal)');
      expect(result.sectionsLd).toContain(
        '    KEEP (*(SORT_BY_INIT_PRIORITY(.init_array.*) SORT_BY_INIT_PRIORITY(.ctors.*)))\n'
        + '    KEEP (*(.init_array EXCLUDE_FILE (*crtend.* *crtbegin.*) .ctors))',
      );
      expect(result.sectionsLd).not.toContain(
        '    KEEP (*(EXCLUDE_FILE (*crtend.* *crtbegin.*) .ctors SORT(.ctors.*)))',
      );
      expect(result.sectionsLd).toContain('   *(.dtors .dtors.*)\n   *(.fini)');
    }
    const s3 = makeEsp32S3LldCompatibleInputs({ ...linkerInputs, sectionsLd: sectionsLd(false) });
    expect(s3.sectionsLd).not.toContain('SIZEOF(.rtc.text)');
    expect(s3.sectionsLd).toContain('    . = ORIGIN(iram0_0_seg) + 0x400;');
    expect(s3.sectionsLd).not.toContain('.ext_ram.dummy (NOLOAD):');
    expect(s3.sectionsLd).not.toContain('.flash_rodata_dummy (NOLOAD):');
    expect(s3.sectionsLd).toContain('.flash.appdesc (ALIGN(ALIGN(ORIGIN(default_rodata_seg)');
    expect(s3.memoryLd.indexOf('REGION_ALIAS("rtc_data_seg", rtc_iram_seg );'))
      .toBeLessThan(s3.memoryLd.indexOf('_data_seg_org = ORIGIN(rtc_data_seg);'));
    expect(() => makeEsp32XtensaLldCompatibleInputs({
      ...linkerInputs,
      ldFlags: '-mlongcalls -Wl,--gc-sections\n',
    })).toThrow(/--no-warn-rwx-segments/);
  });

  it('fails closed when a pinned Xtensa vector or RTC mirror changes', () => {
    expect(() => makeEsp32XtensaLldCompatibleInputs({
      ...linkerInputs,
      sectionsLd: linkerInputs.sectionsLd.replace('    . = 0x280;\n', ''),
    })).toThrow(/vector offset 0x280/);
    expect(() => makeEsp32S2LldCompatibleInputs({
      ...linkerInputs,
      sectionsLd: linkerInputs.sectionsLd.replace('    . = SIZEOF\(.rtc.text\);', ''),
    })).toThrow(/RTC text mirror/);
    expect(() => makeEsp32S3LldCompatibleInputs(linkerInputs)).toThrow(/expected no RTC text mirror/);
    expect(() => makeEsp32S3LldCompatibleInputs({
      ...linkerInputs,
      memoryLd: linkerInputs.memoryLd.replace('REGION_ALIAS("rtc_data_seg", rtc_iram_seg );', ''),
      sectionsLd: sectionsLd(false),
    })).toThrow(/RTC data alias ordering/);
    expect(() => makeEsp32XtensaLldCompatibleInputs({
      ...linkerInputs,
      sectionsLd: linkerInputs.sectionsLd.replace('   *(.fini)\n', ''),
    })).toThrow(/fini discard block/);
    expect(() => makeEsp32XtensaLldCompatibleInputs({
      ...linkerInputs,
      sectionsLd: linkerInputs.sectionsLd.replace('    *(.*Vector.literal)\n', ''),
    })).toThrow(/vector literal collector/);
    expect(() => makeEsp32XtensaLldCompatibleInputs({
      ...linkerInputs,
      sectionsLd: linkerInputs.sectionsLd.replace(
        '    KEEP (*(EXCLUDE_FILE (*crtend.* *crtbegin.*) .ctors SORT(.ctors.*)))\n',
        '',
      ),
    })).toThrow(/constructor collector/);
  });

  it('keeps all Xtensa SDK archives and deduplicates only library switches', () => {
    const archives = ['libxtensa.a', 'libfreertos.a', 'libesp_wifi.a'];
    expect(selectEsp32XtensaLldArchiveNames(archives, '-lxtensa -lfreertos\n'))
      .toEqual(archives);
    for (const transform of [
      makeEsp32XtensaLldCompatibleLdLibs,
      makeEsp32S2LldCompatibleLdLibs,
      makeEsp32S3LldCompatibleLdLibs,
    ]) {
      expect(transform('-lxtensa -Wl,--whole-archive -lfreertos -lxtensa\n'))
        .toBe('-lxtensa -Wl,--whole-archive -lfreertos\n');
    }
  });
});
