/**
 * Narrow ESP32-C3 Arduino 3.3.7 input adjustments required by LLVM LLD.
 *
 * These transformations are deliberately fail-closed and operate on text
 * supplied by the pinned SDK. They are shared by the native LLD probe and the
 * future WASM acceptance gate so both exercise identical linker inputs.
 */

export type Esp32C3LldCompatibilityInputs = Readonly<{
  ldFlags: string;
  memoryLd: string;
  sectionsLd: string;
}>;

export type Esp32C3LldCompatibilityOutputs = Readonly<{
  ldFlags: string;
  memoryLd: string;
  sectionsLd: string;
}>;

const UNSUPPORTED_LLD_FLAG = '-Wl,--no-warn-rwx-segments';
const UNSUPPORTED_WASM_CPP_FLAGS = Object.freeze([
  '-fstrict-volatile-bitfields',
  '-fno-tree-switch-conversion',
  '-freorder-blocks',
]);
const XTENSA_UNSUPPORTED_LLD_FLAGS = Object.freeze([
  '-Wl,--no-warn-rwx-segments',
]);
const XTENSA_GCC_ONLY_CPP_FLAGS = Object.freeze([
  '-fstrict-volatile-bitfields',
  '-fno-tree-switch-conversion',
]);
const XTENSA_GCC_ATOMIC_CPP_FLAG = '-mdisable-hardware-atomics';
const LEGACY_WIFI_PROVISIONING_LIBRARY = '-lwifi_provisioning';
const NETWORK_PROVISIONING_LIBRARY = '-lespressif__network_provisioning';
const XTENSA_GCC_CONSTRUCTOR_COLLECTOR =
  '    KEEP (*(EXCLUDE_FILE (*crtend.* *crtbegin.*) .ctors SORT(.ctors.*)))';
const XTENSA_CLANG_CONSTRUCTOR_COLLECTOR = [
  '    KEEP (*(SORT_BY_INIT_PRIORITY(.init_array.*) SORT_BY_INIT_PRIORITY(.ctors.*)))',
  '    KEEP (*(.init_array EXCLUDE_FILE (*crtend.* *crtbegin.*) .ctors))',
].join('\n');

// Espressif's RV32 GCC typedef choices are part of the C++ ABI. Clang's
// defaults have the same widths but produce different mangled names.
export const ESP32C3_GCC_INTEGER_ABI_FLAGS: readonly string[] = Object.freeze([
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
const MEMORY_DEFINITION = '_data_seg_org = ORIGIN(rtc_data_seg);';
const MEMORY_DEFINITION_PATTERN = /^_data_seg_org = ORIGIN\(rtc_data_seg\);\r?$/gm;
const NOINIT_COMMENT = [
  '  /**',
  '   * This section holds data that should not be initialized at power up.',
].join('\n');
function unifiedFlashRodataDummy(segment: string, absoluteStart = false): string {
  return [
    '  /**',
    '   * Dummy section represents the .flash.text section but in default_rodata_seg.',
    '   * Thus, it must have its alignment and (at least) its size.',
    '   */',
    '  .flash_rodata_dummy (NOLOAD):',
    '  {',
    `    _flash_rodata_dummy_start = ${absoluteStart ? 'ABSOLUTE(.)' : '.'};`,
    '    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);',
    '    /* Add alignment of MMU page size + 0x20 bytes for the mapping header. */',
    '    . = ALIGN(0x10000) + 0x20;',
    `  } > ${segment}`,
    '  .flash.appdesc : ALIGN(0x10)',
  ].join('\n');
}

function unifiedFlashAppdescWithExplicitAddress(segment: string): string {
  return [
    `  _flash_rodata_dummy_start = ORIGIN(${segment});`,
    `  .flash.appdesc (ALIGN(ALIGN(ORIGIN(${segment}), ALIGNOF(.flash.text)) + SIZEOF(.flash.text), 0x10000) + 0x20) : ALIGN(0x10)`,
  ].join('\n');
}
const UNIFIED_FLASH_RODATA_DUMMY_SYMBOL_PATTERN = /\b_flash_rodata_dummy_start\b/g;
const UNIFIED_FLASH_RODATA_DUMMY_REFERENCE_PATTERN = /\b(?:ADDR|LOADADDR|SIZEOF)\s*\(\s*\.flash_rodata_dummy\s*\)/g;
const ESP32C5_EXT_RAM_DUMMY = [
  '  .ext_ram.dummy (NOLOAD):',
  '  {',
  '    . = ORIGIN(extern_ram_seg);',
  '    . = . + (_rodata_reserved_end - _flash_rodata_dummy_start);',
  '    . = ALIGN (0x10000);',
  '  } > extern_ram_seg',
].join('\n');
const ESP32C5_EXT_RAM_DUMMY_CONSUMER_PATTERN = /\b(?:ADDR|LOADADDR|SIZEOF)\s*\(\s*\.ext_ram\.dummy\s*\)/g;

function makeUnifiedBusSectionsLldCompatible({
  memoryLd,
  sectionsLd,
  label,
  flashRodataSegment,
  removeExtRamDummy,
  absoluteDummyStart = false,
}: Readonly<{
  memoryLd: string;
  sectionsLd: string;
  label: string;
  flashRodataSegment?: string;
  removeExtRamDummy: boolean;
  absoluteDummyStart?: boolean;
}>): string {
  let compatibleSectionsLd = sectionsLd;
  if (removeExtRamDummy) {
    const dummyHeaders = sectionsLd.match(/^  \.ext_ram\.dummy \(NOLOAD\):\r?$/gm) ?? [];
    const dummyBlocks = sectionsLd.match(new RegExp(escapeRegExp(ESP32C5_EXT_RAM_DUMMY), 'g')) ?? [];
    const dummyConsumers = `${memoryLd}\n${sectionsLd}`.match(ESP32C5_EXT_RAM_DUMMY_CONSUMER_PATTERN) ?? [];
    if (dummyHeaders.length !== 1 || dummyBlocks.length !== 1) {
      throw new Error(`expected exactly one pinned external RAM dummy block in ${label} sections.ld`);
    }
    if (dummyConsumers.length !== 0) {
      throw new Error(`${label} external RAM dummy section gained an unsupported reference`);
    }
    compatibleSectionsLd = compatibleSectionsLd.replace(ESP32C5_EXT_RAM_DUMMY, '');
    if (compatibleSectionsLd.includes('.ext_ram.dummy (NOLOAD):')) {
      throw new Error(`failed to remove the external RAM dummy block from ${label} sections.ld`);
    }
  }
  if (flashRodataSegment) {
    const pinnedDummyBlock = unifiedFlashRodataDummy(flashRodataSegment, absoluteDummyStart);
    const dummyHeaders = compatibleSectionsLd.match(/^  \.flash_rodata_dummy \(NOLOAD\):\r?$/gm) ?? [];
    const dummyBlocks = compatibleSectionsLd.match(new RegExp(escapeRegExp(pinnedDummyBlock), 'g')) ?? [];
    if (dummyHeaders.length !== 1 || dummyBlocks.length !== 1) {
      throw new Error(`expected exactly one pinned flash rodata dummy block in ${label} sections.ld`);
    }
    const linkerText = `${memoryLd}\n${compatibleSectionsLd}`;
    const dummyStartReferences = linkerText.match(UNIFIED_FLASH_RODATA_DUMMY_SYMBOL_PATTERN) ?? [];
    if (dummyStartReferences.length !== 2) {
      throw new Error(`expected exactly two flash rodata dummy start references in ${label} linker scripts`);
    }
    if (UNIFIED_FLASH_RODATA_DUMMY_REFERENCE_PATTERN.test(linkerText)) {
      UNIFIED_FLASH_RODATA_DUMMY_REFERENCE_PATTERN.lastIndex = 0;
      throw new Error(`${label} flash rodata dummy section gained an unsupported address or size consumer`);
    }
    UNIFIED_FLASH_RODATA_DUMMY_REFERENCE_PATTERN.lastIndex = 0;
    compatibleSectionsLd = compatibleSectionsLd.replace(
      pinnedDummyBlock,
      unifiedFlashAppdescWithExplicitAddress(flashRodataSegment),
    );
    if (compatibleSectionsLd.includes('.flash_rodata_dummy (NOLOAD):')) {
      throw new Error(`failed to remove the flash rodata dummy block from ${label} sections.ld`);
    }
  }
  return compatibleSectionsLd;
}

function sectionsInsertionPoint(dataSegment: string): string {
  return `  } > ${dataSegment}\n${NOINIT_COMMENT}`;
}

function finiArray(dataSegment: string): string {
  return [
    '  .fini_array :',
    '  {',
    '    . = ALIGN(4);',
    '    __fini_array_start = ABSOLUTE(.);',
    '    KEEP (*(EXCLUDE_FILE (*crtend.* *crtbegin.*) .fini_array.*))',
    '    KEEP (*(EXCLUDE_FILE (*crtend.* *crtbegin.*) .fini_array))',
    '    __fini_array_end = ABSOLUTE(.);',
    `  } > ${dataSegment}`,
    '',
  ].join('\n');
}

const LLD_TARGETS = Object.freeze({
  c3: Object.freeze({
    label: 'ESP32-C3', dataSegment: 'dram0_0_seg', removedFlags: Object.freeze([UNSUPPORTED_LLD_FLAG]),
    replacedFlags: Object.freeze([]), flashRodataSegment: undefined, removeExtRamDummy: false,
  }),
  c6: Object.freeze({
    label: 'ESP32-C6', dataSegment: 'sram_seg',
    removedFlags: Object.freeze([UNSUPPORTED_LLD_FLAG, '-Wl,--cref']),
    replacedFlags: Object.freeze([]), flashRodataSegment: 'default_rodata_seg', removeExtRamDummy: false,
  }),
  c5: Object.freeze({
    label: 'ESP32-C5', dataSegment: 'sram_seg',
    removedFlags: Object.freeze([UNSUPPORTED_LLD_FLAG, '-Wl,--cref']),
    replacedFlags: Object.freeze([]), flashRodataSegment: 'default_rodata_seg', removeExtRamDummy: true,
  }),
  h2: Object.freeze({
    label: 'ESP32-H2', dataSegment: 'sram_seg',
    removedFlags: Object.freeze([UNSUPPORTED_LLD_FLAG, '-Wl,--cref']),
    replacedFlags: Object.freeze([]), flashRodataSegment: 'default_rodata_seg', removeExtRamDummy: false,
  }),
  p4: Object.freeze({
    label: 'ESP32-P4', dataSegment: 'sram_high',
    removedFlags: Object.freeze([UNSUPPORTED_LLD_FLAG, '-Wl,--cref']),
    replacedFlags: Object.freeze([
      Object.freeze([
        '-march=rv32imafc_zicsr_zifencei_xesploop_xespv',
        '-march=rv32imafc_zicsr_zifencei',
      ] as const),
    ]),
    flashRodataSegment: 'rodata_seg_low', removeExtRamDummy: false,
  }),
});

/**
 * Produce LLD-compatible copies of the three Arduino SDK linker inputs.
 *
 * GNU ld accepts the original C3 inputs. LLD needs only the documented
 * warning-switch removal, a non-forward memory alias reference, and explicit
 * ordinary-DRAM placement for C++ destructor entries.
 */
export function makeEsp32C3LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32RiscVLldCompatibleInputs(inputs, LLD_TARGETS.c3);
}

export function makeEsp32C6LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32RiscVLldCompatibleInputs(inputs, LLD_TARGETS.c6);
}

export function makeEsp32C5LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32RiscVLldCompatibleInputs(inputs, LLD_TARGETS.c5);
}

export function makeEsp32H2LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32RiscVLldCompatibleInputs(inputs, LLD_TARGETS.h2);
}

export function makeEsp32P4LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32RiscVLldCompatibleInputs(inputs, LLD_TARGETS.p4);
}

export function makeEsp32XtensaLldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32XtensaTargetLldCompatibleInputs(inputs, 'ESP32', true, false);
}

export function makeEsp32S2LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32XtensaTargetLldCompatibleInputs(inputs, 'ESP32-S2', true, false);
}

export function makeEsp32S3LldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
): Esp32C3LldCompatibilityOutputs {
  return makeEsp32XtensaTargetLldCompatibleInputs(inputs, 'ESP32-S3', false, true);
}

function makeEsp32XtensaTargetLldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
  label: string,
  hasRtcTextMirror: boolean,
  moveRtcDataAlias: boolean,
): Esp32C3LldCompatibilityOutputs {
  const { ldFlags, memoryLd, sectionsLd } = inputs;
  if (typeof ldFlags !== 'string' || typeof memoryLd !== 'string' || typeof sectionsLd !== 'string') {
    throw new TypeError(`${label} LLD compatibility inputs must be text`);
  }

  const flags = ldFlags.trim().split(/\s+/);
  for (const unsupportedFlag of XTENSA_UNSUPPORTED_LLD_FLAGS) {
    const count = flags.filter((flag) => flag === unsupportedFlag).length;
    if (count !== 1) {
      throw new Error(`expected exactly one ${unsupportedFlag} in ${label} ld_flags`);
    }
  }

  let compatibleSectionsLd = sectionsLd;
  const rtcTextMirror = '    . = SIZEOF(.rtc.text);';
  const rtcTextMirrorCount = sectionsLd.split(rtcTextMirror).length - 1;
  if (rtcTextMirrorCount !== (hasRtcTextMirror ? 1 : 0)) {
    throw new Error(`expected ${hasRtcTextMirror ? 'exactly one' : 'no'} RTC text mirror in ${label} sections.ld`);
  }
  if (hasRtcTextMirror) {
    compatibleSectionsLd = compatibleSectionsLd.replace(
      rtcTextMirror,
      '    . = ORIGIN(rtc_data_seg) + SIZEOF(.rtc.text);',
    );
  }

  const vectorOffsets = ['0x0', '0x180', '0x1c0', '0x200', '0x240', '0x280', '0x2c0', '0x300', '0x340', '0x3C0', '0x400'];
  for (const offset of vectorOffsets) {
    const source = `    . = ${offset};`;
    const count = compatibleSectionsLd.split(source).length - 1;
    if (count !== 1) throw new Error(`expected exactly one Xtensa vector offset ${offset} in ${label} sections.ld`);
    compatibleSectionsLd = compatibleSectionsLd.replace(
      source,
      `    . = ORIGIN(iram0_0_seg) + ${offset};`,
    );
  }

  const vectorLiterals = [
    ['0x180', 'Level2InterruptVector'],
    ['0x1c0', 'Level3InterruptVector'],
    ['0x200', 'Level4InterruptVector'],
    ['0x240', 'Level5InterruptVector'],
    ['0x2c0', 'NMIExceptionVector'],
    ['0x300', 'KernelExceptionVector'],
    ['0x340', 'UserExceptionVector'],
    ['0x3C0', 'DoubleExceptionVector'],
  ] as const;
  for (const [offset, section] of vectorLiterals) {
    const vectorStart = `    . = ORIGIN(iram0_0_seg) + ${offset};`;
    compatibleSectionsLd = compatibleSectionsLd.replace(
      vectorStart,
      `    *(.${section}.literal)\n${vectorStart}`,
    );
  }
  const trailingVectorLiterals = '    *(.*Vector.literal)';
  const trailingVectorLiteralCount = compatibleSectionsLd.split(trailingVectorLiterals).length - 1;
  if (trailingVectorLiteralCount !== 1) {
    throw new Error(`expected exactly one trailing Xtensa vector literal collector in ${label} sections.ld`);
  }
  compatibleSectionsLd = compatibleSectionsLd.replace(trailingVectorLiterals, '');

  const constructorCollectorCount = compatibleSectionsLd
    .split(XTENSA_GCC_CONSTRUCTOR_COLLECTOR).length - 1;
  if (constructorCollectorCount !== 1) {
    throw new Error(`expected exactly one pinned constructor collector in ${label} sections.ld`);
  }
  compatibleSectionsLd = compatibleSectionsLd.replace(
    XTENSA_GCC_CONSTRUCTOR_COLLECTOR,
    XTENSA_CLANG_CONSTRUCTOR_COLLECTOR,
  );

  const finiDiscard = '   *(.fini)';
  const finiDiscardCount = compatibleSectionsLd.split(finiDiscard).length - 1;
  if (finiDiscardCount !== 1 || /\*\(\.dtors(?:\s|\.)/.test(compatibleSectionsLd)) {
    throw new Error(`expected one unextended fini discard block in ${label} sections.ld`);
  }
  compatibleSectionsLd = compatibleSectionsLd.replace(
    finiDiscard,
    '   *(.dtors .dtors.*)\n   *(.fini)',
  );

  if (moveRtcDataAlias) {
    compatibleSectionsLd = makeUnifiedBusSectionsLldCompatible({
      memoryLd,
      sectionsLd: compatibleSectionsLd,
      label,
      flashRodataSegment: 'default_rodata_seg',
      removeExtRamDummy: true,
      absoluteDummyStart: true,
    });
  }

  let compatibleMemoryLd = memoryLd;
  if (moveRtcDataAlias) {
    const definitions = memoryLd.match(MEMORY_DEFINITION_PATTERN) ?? [];
    if (definitions.length !== 1 || !memoryLd.includes('REGION_ALIAS("rtc_data_seg", rtc_iram_seg );')) {
      throw new Error(`expected the pinned RTC data alias ordering in ${label} memory.ld`);
    }
    compatibleMemoryLd = `${memoryLd.replace(MEMORY_DEFINITION_PATTERN, '')}\n${MEMORY_DEFINITION}\n`;
  }

  return Object.freeze({
    ldFlags: `${flags.filter((flag) => !XTENSA_UNSUPPORTED_LLD_FLAGS.includes(flag)).join(' ')}\n`,
    memoryLd: compatibleMemoryLd,
    sectionsLd: compatibleSectionsLd,
  });
}

function makeEsp32RiscVLldCompatibleInputs(
  inputs: Esp32C3LldCompatibilityInputs,
  target: Readonly<{
    label: string;
    dataSegment: string;
    removedFlags: readonly string[];
    replacedFlags: readonly (readonly [string, string])[];
    flashRodataSegment?: string;
    removeExtRamDummy: boolean;
  }>,
): Esp32C3LldCompatibilityOutputs {
  const { ldFlags, memoryLd, sectionsLd } = inputs;
  if (typeof ldFlags !== 'string' || typeof memoryLd !== 'string' || typeof sectionsLd !== 'string') {
    throw new TypeError(`${target.label} LLD compatibility inputs must be text`);
  }

  const flags = ldFlags.trim().split(/\s+/);
  for (const removedFlag of target.removedFlags) {
    const count = flags.filter((flag) => flag === removedFlag).length;
    if (count !== 1) {
      throw new Error(`expected exactly one ${removedFlag} in ${target.label} ld_flags`);
    }
  }
  for (const [replacedFlag] of target.replacedFlags) {
    const count = flags.filter((flag) => flag === replacedFlag).length;
    if (count !== 1) {
      throw new Error(`expected exactly one ${replacedFlag} in ${target.label} ld_flags`);
    }
  }

  const memoryDefinitions = memoryLd.match(MEMORY_DEFINITION_PATTERN) ?? [];
  if (memoryDefinitions.length !== 1) {
    throw new Error(`expected exactly one ${MEMORY_DEFINITION} assignment in ${target.label} memory.ld`);
  }

  const insertionPoint = sectionsInsertionPoint(target.dataSegment);
  const insertionCount = (sectionsLd.match(new RegExp(escapeRegExp(insertionPoint), 'g')) ?? []).length;
  if (insertionCount !== 1) {
    throw new Error(`could not find the ${target.dataSegment} insertion point in ${target.label} sections.ld`);
  }

  const compatibleSectionsLd = makeUnifiedBusSectionsLldCompatible({
    memoryLd,
    sectionsLd,
    label: target.label,
    flashRodataSegment: target.flashRodataSegment,
    removeExtRamDummy: target.removeExtRamDummy,
  });

  return Object.freeze({
    // LLD rejects this GNU-ld-only warning suppression; it changes no output
    // layout, input, relocation, or symbol-resolution semantics.
    ldFlags: `${flags
      .filter((flag) => !target.removedFlags.includes(flag))
      .map((flag) => target.replacedFlags.find(([source]) => source === flag)?.[1] ?? flag)
      .join(' ')}\n`,
    // GNU ld resolves this REGION_ALIAS forward reference. LLD evaluates
    // ORIGIN() eagerly, so append the order-equivalent assignment after the
    // MEMORY/alias block.
    memoryLd: `${memoryLd.replace(MEMORY_DEFINITION_PATTERN, '')}\n${MEMORY_DEFINITION}\n`,
    // LLD otherwise treats writable fini-array members as orphans and places
    // them in the RTC reserved area. Arduino C++ destructors expect DRAM.
    sectionsLd: compatibleSectionsLd.replace(
      insertionPoint,
      `  } > ${target.dataSegment}\n${finiArray(target.dataSegment)}${NOINIT_COMMENT}`,
    ),
  });
}

/**
 * Produce the narrowly adjusted ESP32-C3 C++ flags accepted by Clang.
 *
 * The pinned Arduino SDK carries three GCC-only optimization switches. Keep
 * every other flag, including ordering, unchanged and fail if the expected
 * SDK shape changes rather than silently accepting an unreviewed update.
 */
export function makeEsp32C3WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32RiscVWasmCompatibleCppFlags(cppFlags, 'ESP32-C3');
}

export function makeEsp32C6WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32RiscVWasmCompatibleCppFlags(cppFlags, 'ESP32-C6');
}

export function makeEsp32C5WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32RiscVWasmCompatibleCppFlags(cppFlags, 'ESP32-C5');
}

export function makeEsp32H2WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32RiscVWasmCompatibleCppFlags(cppFlags, 'ESP32-H2');
}

export function makeEsp32P4WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32RiscVWasmCompatibleCppFlags(cppFlags, 'ESP32-P4', [
    ['-march=rv32imafc_zicsr_zifencei_xesploop_xespv', '-march=rv32imafc_zicsr_zifencei'],
    ['-march=rv32imafc_zicsr_zifencei_xesppie', '-march=rv32imafc_zicsr_zifencei'],
  ]);
}

export function makeEsp32XtensaWasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32XtensaTargetWasmCompatibleCppFlags(cppFlags, 'ESP32', true);
}

export function makeEsp32S2WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32XtensaTargetWasmCompatibleCppFlags(cppFlags, 'ESP32-S2', false);
}

export function makeEsp32S3WasmCompatibleCppFlags(cppFlags: string): string {
  return makeEsp32XtensaTargetWasmCompatibleCppFlags(cppFlags, 'ESP32-S3', true);
}

function makeEsp32XtensaTargetWasmCompatibleCppFlags(
  cppFlags: string,
  label: string,
  hasGccAtomicFlag: boolean,
): string {
  if (typeof cppFlags !== 'string') throw new TypeError(`${label} cpp_flags must be text`);

  const flags = cppFlags.trim().split(/\s+/);
  const removedFlags = hasGccAtomicFlag
    ? [...XTENSA_GCC_ONLY_CPP_FLAGS, XTENSA_GCC_ATOMIC_CPP_FLAG]
    : XTENSA_GCC_ONLY_CPP_FLAGS;
  for (const unsupportedFlag of removedFlags) {
    const count = flags.filter((flag) => flag === unsupportedFlag).length;
    if (count !== 1) {
      throw new Error(`expected exactly one ${unsupportedFlag} in ${label} cpp_flags`);
    }
  }
  if (!hasGccAtomicFlag && flags.includes(XTENSA_GCC_ATOMIC_CPP_FLAG)) {
    throw new Error(`${label} cpp_flags unexpectedly contains ${XTENSA_GCC_ATOMIC_CPP_FLAG}`);
  }

  return `${flags.filter((flag) => !removedFlags.includes(flag)).join(' ')}\n`;
}

function makeEsp32RiscVWasmCompatibleCppFlags(
  cppFlags: string,
  label: string,
  replacedFlags: readonly (readonly [string, string])[] = [],
): string {
  if (typeof cppFlags !== 'string') throw new TypeError(`${label} cpp_flags must be text`);

  const flags = cppFlags.trim().split(/\s+/);
  for (const unsupportedFlag of UNSUPPORTED_WASM_CPP_FLAGS) {
    const count = flags.filter((flag) => flag === unsupportedFlag).length;
    if (count !== 1) {
      throw new Error(`expected exactly one ${unsupportedFlag} in ${label} cpp_flags`);
    }
  }
  for (const [replacedFlag] of replacedFlags) {
    const count = flags.filter((flag) => flag === replacedFlag).length;
    if (count !== 1) {
      throw new Error(`expected exactly one ${replacedFlag} in ${label} cpp_flags`);
    }
  }

  return `${flags
    .filter((flag) => !UNSUPPORTED_WASM_CPP_FLAGS.includes(flag))
    .map((flag) => replacedFlags.find(([source]) => source === flag)?.[1] ?? flag)
    .join(' ')}\n`;
}

/**
 * Remove duplicate library switches from Espressif's linker response file.
 *
 * Arduino-ESP32 emits the component closure several times. The browser link
 * command already places this response file inside one --start-group, whose
 * fixed-point rescans provide the same circular-dependency resolution without
 * repeating identical archives in every pass. Keep the first occurrence so
 * archive search order and all non-library linker tokens remain unchanged.
 */
export function makeEsp32C3LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-C3');
}

export function makeEsp32C6LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-C6');
}

export function makeEsp32C5LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-C5');
}

export function makeEsp32H2LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-H2');
}

export function makeEsp32P4LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-P4');
}

export function makeEsp32XtensaLldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32');
}

export function makeEsp32S2LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-S2');
}

export function makeEsp32S3LldCompatibleLdLibs(ldLibs: string): string {
  return makeEsp32LldCompatibleLdLibs(ldLibs, 'ESP32-S3');
}

function makeEsp32LldCompatibleLdLibs(ldLibs: string, label: string): string {
  if (typeof ldLibs !== 'string') throw new TypeError(`${label} ld_libs must be text`);

  const tokens = ldLibs.trim().split(/\s+/).filter(Boolean);
  const seenLibraries = new Set<string>();
  const compatible: string[] = [];
  for (const token of tokens) {
    if (!token.startsWith('-l')) {
      compatible.push(token);
      continue;
    }
    if (seenLibraries.has(token)) continue;
    seenLibraries.add(token);
    compatible.push(token);
  }
  const selected = seenLibraries.has(LEGACY_WIFI_PROVISIONING_LIBRARY)
    && seenLibraries.has(NETWORK_PROVISIONING_LIBRARY)
    ? compatible.filter((token) => token !== LEGACY_WIFI_PROVISIONING_LIBRARY)
    : compatible;
  return `${selected.join(' ')}\n`;
}

export const ESP32C3_UNUSED_SDK_ARCHIVES = Object.freeze([
  'libesp_zb_api.zczr.a',
  'libesp_zb_api.zczr.debug.a',
  'libzboss_port.remote.a',
  'libzboss_port.remote.debug.a',
  'libzboss_stack.zczr.a',
  'libzboss_stack.zczr.debug.a',
]);

export const ESP32C6_UNUSED_SDK_ARCHIVES = Object.freeze([
  'libesp_zb_api.ed.a',
  'libesp_zb_api.ed.debug.a',
  'libesp_zb_api.gpd.a',
  'libesp_zb_api.zczr.a',
  'libesp_zb_api.zczr.debug.a',
  'libzboss_port.native.a',
  'libzboss_port.native.debug.a',
  'libzboss_port.remote.a',
  'libzboss_port.remote.debug.a',
  'libzboss_stack.ed.a',
  'libzboss_stack.ed.debug.a',
  'libzboss_stack.gpd.a',
  'libzboss_stack.zczr.a',
  'libzboss_stack.zczr.debug.a',
]);

export const ESP32C5_UNUSED_SDK_ARCHIVES = ESP32C6_UNUSED_SDK_ARCHIVES;

export const ESP32H2_UNUSED_SDK_ARCHIVES = Object.freeze([
  'libesp_zb_api.ed.a',
  'libesp_zb_api.ed.debug.a',
  'libesp_zb_api.gpd.a',
  'libesp_zb_api.zczr.a',
  'libesp_zb_api.zczr.debug.a',
  'libzboss_port.native.a',
  'libzboss_port.native.debug.a',
  'libzboss_stack.ed.a',
  'libzboss_stack.ed.debug.a',
  'libzboss_stack.gpd.a',
  'libzboss_stack.zczr.a',
  'libzboss_stack.zczr.debug.a',
]);

// Every archive shipped in the pinned ESP32-P4 ES SDK is selected by ld_libs.
export const ESP32P4_UNUSED_SDK_ARCHIVES: readonly string[] = Object.freeze([]);

/**
 * Remove only SDK archives that the pinned response file cannot select.
 *
 * Every other archive remains available to user sketches. Fail closed if the
 * SDK layout changes or a future response file starts naming one of these
 * variants, so a board-package upgrade cannot silently remove a dependency.
 */
export function selectEsp32C3LldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
): string[] {
  return selectEsp32LldArchiveNames(archiveNames, ldLibs, ESP32C3_UNUSED_SDK_ARCHIVES, 'ESP32-C3');
}

export function selectEsp32C6LldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
): string[] {
  return selectEsp32LldArchiveNames(archiveNames, ldLibs, ESP32C6_UNUSED_SDK_ARCHIVES, 'ESP32-C6');
}

export function selectEsp32C5LldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
): string[] {
  return selectEsp32LldArchiveNames(archiveNames, ldLibs, ESP32C5_UNUSED_SDK_ARCHIVES, 'ESP32-C5');
}

export function selectEsp32H2LldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
): string[] {
  return selectEsp32LldArchiveNames(archiveNames, ldLibs, ESP32H2_UNUSED_SDK_ARCHIVES, 'ESP32-H2');
}

export function selectEsp32P4LldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
): string[] {
  return selectEsp32LldArchiveNames(archiveNames, ldLibs, ESP32P4_UNUSED_SDK_ARCHIVES, 'ESP32-P4');
}

export function selectEsp32XtensaLldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
): string[] {
  return selectEsp32LldArchiveNames(archiveNames, ldLibs, [], 'ESP32 Xtensa');
}

function selectEsp32LldArchiveNames(
  archiveNames: readonly string[],
  ldLibs: string,
  excludedArchives: readonly string[],
  label: string,
): string[] {
  if (!Array.isArray(archiveNames) || archiveNames.some((name) => typeof name !== 'string' || !/^lib[^/\\]+\.a$/.test(name))) {
    throw new TypeError(`${label} SDK archive names are invalid`);
  }
  if (new Set(archiveNames).size !== archiveNames.length) {
    throw new Error(`${label} SDK archive names are duplicated`);
  }
  if (typeof ldLibs !== 'string') throw new TypeError(`${label} ld_libs must be text`);

  const available = new Set(archiveNames);
  const switches = new Set(ldLibs.trim().split(/\s+/).filter((token) => token.startsWith('-l')));
  for (const archive of excludedArchives) {
    if (!available.has(archive)) throw new Error(`expected ${label} unused SDK archive is missing: ${archive}`);
    const librarySwitch = `-l${archive.slice(3, -2)}`;
    if (switches.has(librarySwitch)) {
      throw new Error(`${label} excluded SDK archive became referenced: ${librarySwitch}`);
    }
  }
  const excluded = new Set(excludedArchives);
  return archiveNames.filter((name) => !excluded.has(name));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
