/**
 * 工具链路径配置。
 *
 * 刻意与板子定义（boards/*.json）分开：
 *   · 板子定义是**可移植数据** —— MCU、主频、引脚、编译宏，在哪台机器上都一样，
 *     可以进版本库、可以直接喂给前端。
 *   · 工具链路径是**环境事实** —— 开发机在 Arduino15 下，生产镜像在 /opt 下。
 * 混在一起的话，板子定义就没法进版本库了。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

export interface ArchToolchain {
  /** 编译器 bin 目录 */
  binDir: string;
  /** 完整工具链根目录；沙箱需同时挂载编译器后端和运行库 */
  rootDir?: string;
  /** Arduino core 源码目录，如 .../cores/arduino */
  coreDir: string;
  /** variants 根目录，具体板子用 variant 名拼接 */
  variantsDir: string;
}

/**
 * ESP32 的工具链布局和 AVR 差别很大，单独一个类型：
 *   · 编译器按芯片族分（xtensa / riscv），但同一个 bin 目录里放着多个前缀
 *   · **重活已经预编译**：SDK 里 141 个 `.a` 共 111 MB，是 ESP-IDF 的产物
 *     （espressif/esp32-arduino-libs）。我们只编 core + sketch，然后链接
 *   · 镜像要用 esptool 从 elf 生成，不是 objcopy
 */
export interface Esp32Toolchain {
  /** 编译器 bin 目录（xtensa 与 riscv 各一个） */
  xtensaBinDir?: string;
  riscvBinDir?: string;
  /** 完整编译器根；沙箱必须同时挂载 libexec、运行库和 sysroot */
  xtensaRootDir?: string;
  riscvRootDir?: string;
  /** Arduino core 源码目录 */
  coreDir: string;
  variantsDir: string;
  /** 平台根目录，partitions/boot_app0 在它下面 */
  platformDir: string;
  /** 按 target 找预编译 SDK 的根，如 <tools>/esp32-libs/3.3.7 */
  sdkRootFor: (target: string) => string | null;
  /** esptool 可执行文件 */
  esptool: string;
}

export interface ToolchainConfig {
  avr?: ArchToolchain;
  esp32?: Esp32Toolchain;
  /** 构建缓存根目录（core.a、库 .a、L0 结果缓存都放这里） */
  cacheDir: string;
  /** 每次编译的临时工作目录根 */
  workDir: string;
  /** 库根目录列表，靠前的优先级更高 */
  librariesDirs: string[];
}

const exe = platform() === 'win32' ? '.exe' : '';

/** 拼出某个工具的完整路径 */
export function toolPath(tc: ArchToolchain, name: string): string {
  return join(tc.binDir, name + exe);
}

/**
 * 从本机 Arduino15 目录自动探测工具链（开发用）。
 * 生产环境应当用环境变量显式指定，不要依赖探测。
 */
export function detectLocalToolchain(): ToolchainConfig {
  const root =
    process.env.ARDUINO15_DIR ??
    (platform() === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Arduino15')
      : platform() === 'darwin'
        ? join(homedir(), 'Library', 'Arduino15')
        : join(homedir(), '.arduino15'));

  const cfg: ToolchainConfig = {
    cacheDir: process.env.AF_CACHE_DIR ?? join(process.cwd(), 'var', 'cache'),
    workDir: process.env.AF_WORK_DIR ?? join(process.cwd(), 'var', 'work'),
    librariesDirs: [],
  };

  // ---- AVR ----
  const avrHw = join(root, 'packages', 'arduino', 'hardware', 'avr');
  const avrVer = firstSubdir(avrHw);
  const avrToolRoot = join(root, 'packages', 'arduino', 'tools', 'avr-gcc');
  const avrToolVer = firstSubdir(avrToolRoot);
  if (avrVer && avrToolVer) {
    cfg.avr = {
      binDir: join(avrToolRoot, avrToolVer, 'bin'),
      rootDir: join(avrToolRoot, avrToolVer),
      coreDir: join(avrHw, avrVer, 'cores', 'arduino'),
      variantsDir: join(avrHw, avrVer, 'variants'),
    };
  }

  // ---- ESP32 ----
  const espPkg = join(root, 'packages', 'esp32');
  const espHw = join(espPkg, 'hardware', 'esp32');
  const espVer = firstSubdir(espHw);
  const espTools = join(espPkg, 'tools');
  if (espVer) {
    const platformDir = join(espHw, espVer);
    const xtensaVer = firstSubdir(join(espTools, 'esp-x32'));
    const riscvVer = firstSubdir(join(espTools, 'esp-rv32'));
    const esptoolVer = firstSubdir(join(espTools, 'esptool_py'));

    if (esptoolVer) {
      cfg.esp32 = {
        ...(xtensaVer ? {
          xtensaBinDir: join(espTools, 'esp-x32', xtensaVer, 'bin'),
          xtensaRootDir: join(espTools, 'esp-x32', xtensaVer),
        } : {}),
        ...(riscvVer ? {
          riscvBinDir: join(espTools, 'esp-rv32', riscvVer, 'bin'),
          riscvRootDir: join(espTools, 'esp-rv32', riscvVer),
        } : {}),
        coreDir: join(platformDir, 'cores', 'esp32'),
        variantsDir: join(platformDir, 'variants'),
        platformDir,
        esptool: join(espTools, 'esptool_py', esptoolVer, `esptool${exe}`),
        // 每个 target 一套预编译 SDK：esp32-libs / esp32s3-libs / esp32c3-libs …
        sdkRootFor: (target: string) => {
          const dir = join(espTools, `${target}-libs`);
          const v = firstSubdir(dir);
          return v ? join(dir, v) : null;
        },
      };
    }
  }

  // ---- 库目录 ----
  // 开发期直接用本机已有的库：内置库（Wire/SPI/EEPROM…）+ 用户库。
  // 生产环境由 AF_LIBRARIES_DIRS 指定白名单库仓库，绝不做这种自动发现。
  const candidates: string[] = [];
  if (avrVer) candidates.push(join(avrHw, avrVer, 'libraries'));
  if (espVer) candidates.push(join(espHw, espVer, 'libraries'));
  const docs =
    platform() === 'win32'
      ? join(homedir(), 'Documents', 'Arduino', 'libraries')
      : platform() === 'darwin'
        ? join(homedir(), 'Documents', 'Arduino', 'libraries')
        : join(homedir(), 'Arduino', 'libraries');
  candidates.push(docs);
  cfg.librariesDirs = candidates.filter((d) => existsSync(d));

  return applyEnvOverrides(cfg);
}

function firstSubdir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  // 同步读目录：只在启动时调用一次
  const entries = readdirSync(dir).filter((e) => {
    try { return statSync(join(dir, e)).isDirectory(); } catch { return false; }
  });
  entries.sort().reverse(); // 版本号降序，取最新
  return entries[0] ?? null;
}

/** 环境变量优先于自动探测 —— 生产环境走这条路 */
function applyEnvOverrides(cfg: ToolchainConfig): ToolchainConfig {
  if (process.env.AF_AVR_BIN && process.env.AF_AVR_CORE && process.env.AF_AVR_VARIANTS) {
    cfg.avr = {
      binDir: process.env.AF_AVR_BIN,
      rootDir: process.env.AF_AVR_ROOT ?? dirname(process.env.AF_AVR_BIN),
      coreDir: process.env.AF_AVR_CORE,
      variantsDir: process.env.AF_AVR_VARIANTS,
    };
  }
  if (process.env.AF_LIBRARIES_DIRS) {
    cfg.librariesDirs = process.env.AF_LIBRARIES_DIRS.split(/[;:]/).filter(Boolean);
  }
  const esp32Core = process.env.AF_ESP32_CORE;
  const esp32Variants = process.env.AF_ESP32_VARIANTS;
  const esp32Platform = process.env.AF_ESP32_PLATFORM;
  const esp32SdkRoot = process.env.AF_ESP32_SDK_ROOT;
  const esp32Esptool = process.env.AF_ESP32_ESPTOOL;
  const xtensaBinDir = process.env.AF_ESP32_XTENSA_BIN;
  const riscvBinDir = process.env.AF_ESP32_RISCV_BIN;
  if (
    esp32Core && esp32Variants && esp32Platform && esp32SdkRoot && esp32Esptool
    && (xtensaBinDir || riscvBinDir)
  ) {
    cfg.esp32 = {
      ...(xtensaBinDir ? {
        xtensaBinDir,
        xtensaRootDir: process.env.AF_ESP32_XTENSA_ROOT ?? dirname(xtensaBinDir),
      } : {}),
      ...(riscvBinDir ? {
        riscvBinDir,
        riscvRootDir: process.env.AF_ESP32_RISCV_ROOT ?? dirname(riscvBinDir),
      } : {}),
      coreDir: esp32Core,
      variantsDir: esp32Variants,
      platformDir: esp32Platform,
      esptool: esp32Esptool,
      sdkRootFor: (target: string) => {
        const direct = join(esp32SdkRoot, target);
        if (existsSync(direct)) return direct;
        const versionedRoot = join(esp32SdkRoot, `${target}-libs`);
        const version = firstSubdir(versionedRoot);
        return version ? join(versionedRoot, version) : null;
      },
    };
  }
  return cfg;
}

export function describeToolchain(cfg: ToolchainConfig): string {
  const parts: string[] = [];
  parts.push(cfg.avr ? `avr: ${cfg.avr.binDir}` : 'avr: 未找到');
  parts.push(cfg.esp32 ? `esp32: ${cfg.esp32.xtensaBinDir ?? cfg.esp32.riscvBinDir}` : 'esp32: 未配置');
  parts.push(`库目录: ${cfg.librariesDirs.length ? cfg.librariesDirs.join(', ') : '（无）'}`);
  return parts.join('\n  ');
}
