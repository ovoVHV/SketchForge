import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_TARGETS } from '../../../scripts/build-browser-esp32c3-runtime.js';

const sourceRoot = resolve(process.cwd(), 'toolchains', 'esp32-xtensa-wasm');
const lock = JSON.parse(readFileSync(resolve(sourceRoot, 'source-lock.json'), 'utf8'));
const patchBytes = readFileSync(resolve(sourceRoot, lock.compiler.wasiPatch.path));
const patchText = patchBytes.toString('utf8');
const buildScript = readFileSync(resolve(process.cwd(), 'scripts', 'build-esp32-xtensa-wasm.sh'), 'utf8');
const toolchain = readFileSync(resolve(sourceRoot, 'Toolchain-WASI-Xtensa.cmake'), 'utf8');

function filePatch(path: string): string {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patchText.indexOf(marker);
  const end = patchText.indexOf('\ndiff --git ', start + marker.length);
  expect(start, `missing patch for ${path}`).toBeGreaterThanOrEqual(0);
  return patchText.slice(start, end < 0 ? undefined : end);
}

function addedFilePatch(path: string): string {
  return filePatch(path)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

describe('ESP32 Xtensa WASM source lock', () => {
  it('pins the compiler, WASI SDK, and locally verified wrapper inputs', () => {
    expect(lock).toMatchObject({
      schema: 1,
      status: 'candidate',
      compiler: {
        repository: 'https://github.com/espressif/llvm-project.git',
        revision: '570c44b61995a6e0d7d9c7c5c9e78e9e40a8e6ec',
        packageVersion: '23.0.0-espressif.570c44b6.12',
        backend: 'Xtensa',
        hostTriple: 'wasm32-wasip1',
      },
      build: {
        wasiSdk: {
          release: 'wasi-sdk-29',
          version: '29.0',
          sha256: '87d1d1a2879d139cdc624b968efad3d4a97b8078cdff95e63ac88ecafd1a0171',
        },
        wrapper: {
          repository: 'https://github.com/YoWASP/clang.git',
          revision: '944dd7c774954180e621cc8e12984023a7f8bcbe',
          runtime: { package: '@yowasp/runtime', version: '11.0.67' },
        },
      },
      sdk: { arduinoEsp32Version: '3.3.7' },
    });
  });

  it('locks exactly the 44 content-changing WASI patch files', () => {
    const paths = [...patchText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
      .map((match) => match[1]);
    expect(paths).toHaveLength(44);
    expect(new Set(paths).size).toBe(44);
    expect(paths).not.toContain('llvm/cmake/config.guess');
    expect(createHash('sha256').update(patchBytes).digest('hex'))
      .toBe(lock.compiler.wasiPatch.sha256);
  });

  it('builds matching TableGen tools and a no-LTO Xtensa-only WASI driver', () => {
    expect(buildScript).toContain('--target llvm-tblgen clang-tblgen');
    expect(buildScript).toContain("'-DLLVM_ENABLE_PROJECTS=clang;lld'");
    expect(buildScript).toContain('-DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa');
    expect(buildScript).toContain('-DLLVM_TOOL_LLVM_DRIVER_BUILD=ON');
    expect(buildScript).toContain('-DLLD_BUILD_ONLY_ELF=ON');
    expect(buildScript).toContain('-DLLVM_ENABLE_LTO=OFF');
    expect(buildScript).toContain('-DLLVM_TOOL_DSYMUTIL_BUILD=OFF');
    expect(buildScript).toContain('-DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF');
    expect(buildScript).toContain('--target llvm-driver clang-resource-headers');
    expect(buildScript).toContain('lib/clang/23/include');
    expect(toolchain).toContain('CMAKE_SYSTEM_NAME WASI');
    expect(toolchain).toContain('CMAKE_C_COMPILER_TARGET wasm32-wasip1');
    expect(toolchain).toContain('--max-memory=4294967296');
  });

  it('builds and registers only the ELF LLD driver', () => {
    const rootCmake = addedFilePatch('lld/CMakeLists.txt');
    expect(rootCmake).toContain('option(LLD_BUILD_ONLY_ELF');
    expect(rootCmake).toContain('add_definitions("-DLLD_BUILD_ONLY_ELF=1")');
    expect(rootCmake).toContain('if (TARGET llvm_gtest AND NOT LLD_BUILD_ONLY_ELF)');
    expect(rootCmake).toMatch(
      /if \(LLD_BUILD_ONLY_ELF\)[\s\S]+add_subdirectory\(ELF\)[\s\S]+else\(\)[\s\S]+add_subdirectory\(COFF\)/,
    );

    const toolCmake = addedFilePatch('lld/tools/lld/CMakeLists.txt');
    expect(toolCmake).toContain('set(LLD_DRIVER_LIBS lldELF)');
    expect(toolCmake).toContain('set(LLD_SYMLINKS_TO_CREATE ld.lld)');
    expect(toolCmake).toContain('set_property(GLOBAL PROPERTY LLVM_DRIVER_TOOL_ALIASES_lld "")');
    expect(toolCmake).toContain('if(LLD_BUILD_ONLY_ELF AND LLVM_TOOL_LLVM_DRIVER_BUILD)');

    const driver = addedFilePatch('lld/tools/lld/lld.cpp');
    expect(driver).toContain('static constexpr lld::DriverDef lldDrivers[] = {');
    expect(driver).toContain('{lld::Gnu, &lld::elf::link}');
    expect(driver).toContain('static constexpr lld::DriverDef lldDrivers[] = LLD_ALL_DRIVERS;');
    expect(driver.match(/lldDrivers/g)).toHaveLength(4);

    const relocScan = addedFilePatch('lld/ELF/RelocScan.h');
    expect(relocScan).toContain('if (expr == R_NONE)');
    expect(relocScan).toMatch(/if \(expr == R_NONE\)\s+return;/);

    const xtensaRelocations = addedFilePatch('lld/ELF/Arch/Xtensa.cpp');
    expect(xtensaRelocations).toContain('int64_t Xtensa::getImplicitAddend');
    expect(xtensaRelocations).toContain('int64_t Xtensa::adjustRelocationAddend');
    expect(xtensaRelocations).not.toContain('write32le(loc, val + read32le(loc));');

    const target = addedFilePatch('lld/ELF/Target.h');
    expect(target).toContain('virtual int64_t adjustRelocationAddend');

    const markLive = addedFilePatch('lld/ELF/MarkLive.cpp');
    expect(markLive).toContain('ctx.target->adjustRelocationAddend');

    const inputSection = addedFilePatch('lld/ELF/InputSection.cpp');
    expect(inputSection).toContain('target.adjustRelocationAddend');

    const outputSections = addedFilePatch('lld/ELF/OutputSections.cpp');
    expect(outputSections).toContain('getOutputRelocAddend');
    expect(outputSections).toContain('ctx.target->adjustRelocationAddend');

    const dwarf = addedFilePatch('lld/ELF/DWARF.cpp');
    expect(dwarf).toContain('ctx.target->adjustRelocationAddend');

    const syntheticSections = addedFilePatch('lld/ELF/SyntheticSections.cpp');
    expect(syntheticSections).toContain('ctx.target->adjustRelocationAddend');

    const regression = addedFilePatch('lld/test/ELF/xtensa-reloc-abs-addend.s');
    expect(regression).toContain('.long 6');
    expect(regression).toContain('.reloc ptr, R_XTENSA_32, .rodata.str1.1');
    expect(regression).toContain('--gc-sections -u ptr');
    expect(regression).toContain('ld.lld -r');
    expect(regression).toContain('--emit-relocs');
    expect(regression).toContain('--gdb-index');
    expect(regression).toContain('--debug-names');
    expect(regression).toContain('RAW-CREL');
    expect(regression).toContain('GC-NEXT: [     0]  target');

    const assembler = addedFilePatch(
      'llvm/lib/Target/Xtensa/MCTargetDesc/XtensaAsmBackend.cpp',
    );
    expect(assembler).toContain('XtensaAsmBackend::getFixupKind');
    expect(assembler).toContain('mc::isRelocation(Fixup.getKind())');

    const immediateLowering = addedFilePatch(
      'llvm/lib/Target/Xtensa/XtensaISelLowering.cpp',
    );
    expect(immediateLowering).toContain('bool HasScaledAddend = false;');
    expect(immediateLowering).toContain('bool HasAddUser = false;');
    expect(immediateLowering).toContain('HasAddUser && !HasScaledAddend');
    expect(immediateLowering).toContain('Shift->getZExtValue() >= 1');
    expect(immediateLowering).toContain('Shift->getZExtValue() <= 3');

    const immediateRegression = addedFilePatch(
      'llvm/test/CodeGen/Xtensa/add_shifted_imm.ll',
    );
    expect(immediateRegression).toContain('test_reassociated');
    expect(immediateRegression).toContain('addx4 a2, a2, a8');
    expect(immediateRegression).toContain('addx8 a2, a2, a8');

    const relocDirective = addedFilePatch(
      'llvm/test/MC/Xtensa/Relocations/reloc-directive.s',
    );
    expect(relocDirective).toContain('.reloc .Lreloc, R_XTENSA_32, target');
    expect(relocDirective).toContain('R_XTENSA_32 {{.*}} target + 0');
  });

  it('fails unsupported WASI process and symbolization operations deterministically', () => {
    const interpPatch = addedFilePatch('clang/lib/AST/ByteCode/Interp.cpp');
    expect(interpPatch).toContain('defined(__wasm__)');

    const driverPatch = addedFilePatch('clang/tools/driver/driver.cpp');
    expect(driverPatch).toContain('#if LLVM_ON_UNIX && !defined(__wasi__)');

    const toolChainPatch = addedFilePatch('clang/lib/Driver/ToolChain.cpp');
    expect(toolChainPatch).toContain('if (UseLinker == "lld")');
    expect(toolChainPatch).toContain('return "ld.lld";');

    const programPatch = addedFilePatch('llvm/lib/Support/Unix/Program.inc');
    expect(programPatch).not.toContain('assert(false && "Unsupported")');
    expect(programPatch).toContain('*ErrMsg = "WASI does not support waiting for subprocesses";');
    expect(programPatch).toContain('WaitResult.ReturnCode = -1;');
    expect(programPatch).toContain('return WaitResult;');

    const signalsPatch = addedFilePatch('llvm/lib/Support/Signals.cpp');
    expect(signalsPatch).toMatch(/static bool findModulesAndOffsets[\s\S]+?return false;/);
    expect(signalsPatch).toMatch(/static bool printMarkupContext[^\n]+\{ return false; \}/);
  });

  it('covers every Xtensa runtime builder profile', () => {
    const profiles = Object.fromEntries(lock.sdk.profiles.map((profile: any) => [profile.mcpu, profile]));
    for (const key of ['esp32', 'esp32s2', 'esp32s3'] as const) {
      const target = RUNTIME_TARGETS[key];
      expect(target.sourceBundleDir).toBe('esp32-xtensa-wasm');
      expect(profiles[key]).toEqual({
        board: target.fqbn,
        target: target.gccTriple,
        mcpu: target.sdkTarget,
      });
    }
  });
});
