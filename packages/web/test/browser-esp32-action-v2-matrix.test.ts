import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPlatformManifest } from "../../core/src/platform-pack/builder.js";
import {
  ESP32_C3_DEFAULT_OPTIONS,
  ESP32_C6_DEFAULT_OPTIONS,
  ESP32_DEFAULT_OPTIONS,
  ESP32_S2_DEFAULT_OPTIONS,
  ESP32_S3_DEFAULT_OPTIONS,
} from "../public/esp32/v2/c3-compiler.js";
import { createEsp32C3V2WorkerActionMessageHandler } from "../public/esp32/v2/c3-worker.js";
import { createEsp32C6V2WorkerActionMessageHandler } from "../public/esp32/v2/c6-worker.js";
import { createEsp32V2WorkerActionMessageHandler } from "../public/esp32/v2/esp32-worker.js";
import { createEsp32S2V2WorkerActionMessageHandler } from "../public/esp32/v2/s2-worker.js";
import { createEsp32S3V2WorkerActionMessageHandler } from "../public/esp32/v2/s3-worker.js";
import {
  createEsp32C3WorkerLauncher,
  createEsp32C6WorkerLauncher,
  createEsp32S2WorkerLauncher,
  createEsp32S3WorkerLauncher,
  createEsp32WorkerActionRequest,
  createEsp32WorkerLauncher,
} from "../public/esp32/v1/c3-runtime.js";

type MatrixTarget = {
  label: string;
  slug: string;
  board: string;
  runtimeId: string;
  compilerId: string;
  options: Readonly<Record<string, string>>;
  targetArguments: string[];
  memoryType: "dio_qspi" | "qio_qspi";
  bootloaderOffset: "0x0" | "0x1000";
  image: { flashMode: string; flashFrequency: string; flashSize: string };
  createLauncher: typeof createEsp32C3WorkerLauncher;
  createActionRequest: typeof createEsp32WorkerActionRequest;
  createWorkerActionHandler: (options: any) => (event: any) => Promise<void>;
};

const matrixTargets: readonly MatrixTarget[] = [
  {
    label: "ESP32",
    slug: "esp32",
    board: "esp32:esp32:esp32",
    runtimeId: "esp32-arduino",
    compilerId: "xtensa-esp-elf-wasm",
    options: ESP32_DEFAULT_OPTIONS,
    targetArguments: ["--target=xtensa-esp-elf", "-mcpu=esp32"],
    memoryType: "dio_qspi",
    bootloaderOffset: "0x1000",
    image: { flashMode: "dio", flashFrequency: "40m", flashSize: "4MB" },
    createLauncher: createEsp32WorkerLauncher,
    createActionRequest: createEsp32WorkerActionRequest,
    createWorkerActionHandler: createEsp32V2WorkerActionMessageHandler,
  },
  {
    label: "ESP32-S2",
    slug: "esp32s2",
    board: "esp32:esp32:esp32s2",
    runtimeId: "esp32-s2-arduino",
    compilerId: "xtensa-esp-elf-wasm",
    options: ESP32_S2_DEFAULT_OPTIONS,
    targetArguments: ["--target=xtensa-esp-elf", "-mcpu=esp32s2"],
    memoryType: "qio_qspi",
    bootloaderOffset: "0x1000",
    image: { flashMode: "dio", flashFrequency: "80m", flashSize: "4MB" },
    createLauncher: createEsp32S2WorkerLauncher,
    createActionRequest: createEsp32WorkerActionRequest,
    createWorkerActionHandler: createEsp32S2V2WorkerActionMessageHandler,
  },
  {
    label: "ESP32-S3",
    slug: "esp32s3",
    board: "esp32:esp32:esp32s3",
    runtimeId: "esp32-s3-arduino",
    compilerId: "xtensa-esp-elf-wasm",
    options: ESP32_S3_DEFAULT_OPTIONS,
    targetArguments: ["--target=xtensa-esp-elf", "-mcpu=esp32s3"],
    memoryType: "qio_qspi",
    bootloaderOffset: "0x0",
    image: { flashMode: "dio", flashFrequency: "80m", flashSize: "4MB" },
    createLauncher: createEsp32S3WorkerLauncher,
    createActionRequest: createEsp32WorkerActionRequest,
    createWorkerActionHandler: createEsp32S3V2WorkerActionMessageHandler,
  },
  {
    label: "ESP32-C3",
    slug: "esp32c3",
    board: "esp32:esp32:esp32c3",
    runtimeId: "esp32-c3-arduino",
    compilerId: "riscv32-esp-elf-wasm",
    options: ESP32_C3_DEFAULT_OPTIONS,
    targetArguments: [
      "--target=riscv32-esp-elf",
      "-march=rv32imc_zicsr_zifencei",
      "-mabi=ilp32",
    ],
    memoryType: "dio_qspi",
    bootloaderOffset: "0x0",
    image: { flashMode: "dio", flashFrequency: "40m", flashSize: "4MB" },
    createLauncher: createEsp32C3WorkerLauncher,
    createActionRequest: createEsp32WorkerActionRequest,
    createWorkerActionHandler: createEsp32C3V2WorkerActionMessageHandler,
  },
  {
    label: "ESP32-C6",
    slug: "esp32c6",
    board: "esp32:esp32:esp32c6",
    runtimeId: "esp32-c6-arduino",
    compilerId: "riscv32-esp-elf-wasm",
    options: ESP32_C6_DEFAULT_OPTIONS,
    targetArguments: [
      "--target=riscv32-esp-elf",
      "-march=rv32imac_zicsr_zifencei",
      "-mabi=ilp32",
    ],
    memoryType: "qio_qspi",
    bootloaderOffset: "0x0",
    image: { flashMode: "dio", flashFrequency: "80m", flashSize: "4MB" },
    createLauncher: createEsp32C6WorkerLauncher,
    createActionRequest: createEsp32WorkerActionRequest,
    createWorkerActionHandler: createEsp32C6V2WorkerActionMessageHandler,
  },
];

const descriptorUrl = "https://cdn.example.test/esp32/matrix/v2/runtime.json";
const PLATFORM_TEXT = [
  "name=Arduino ESP32",
  "recipe.c.o.pattern=gcc -c {source_file} -o {object_file}",
  "recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}",
  "recipe.S.o.pattern=gcc -c {source_file} -o {object_file}",
  "recipe.ar.pattern=ar rcs {archive_file_path} {object_file}",
  "recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf",
  'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin"',
].join("\n");

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor(target: MatrixTarget) {
  return {
    schema: 2,
    id: target.runtimeId,
    abi: 1,
    board: target.board,
    packs: [
      {
        role: "compiler",
        id: target.compilerId,
        revision: "a".repeat(64),
        manifest: "packs/compiler/toolchain.json",
      },
      {
        role: "sdk",
        id: `arduino-${target.slug}-sdk`,
        revision: "b".repeat(64),
        manifest: "packs/sdk/toolchain.json",
      },
      {
        role: "board",
        id: `arduino-${target.slug}-board`,
        revision: "c".repeat(64),
        manifest: "packs/board/toolchain.json",
      },
    ],
  };
}

function sdkProfile(target: MatrixTarget) {
  const boardDefine = `${target.slug.toUpperCase()}_DEV`;
  const platformManifest = createPlatformManifest({
    id: "espressif-arduino",
    version: "3.3.7",
    vendor: "esp32",
    architecture: "esp32",
    platformText: PLATFORM_TEXT,
    boardsText: [
      `${target.slug}.name=${target.label} Dev Module`,
      `${target.slug}.build.core=esp32`,
      `${target.slug}.build.variant=${target.slug}`,
      `${target.slug}.build.bootloader_addr=${target.bootloaderOffset}`,
    ].join("\n"),
  });
  const platformManifestBytes = encodeJson(platformManifest);
  const platformRef = {
    id: platformManifest.id,
    version: platformManifest.version,
    sha256: platformManifest.sha256,
  };
  const targetTriple = target.targetArguments[0]!.slice("--target=".length);
  const platformProfile = {
    schema: 5,
    id: "espressif-arduino-3.3.7",
    sdkVersion: "3.3.7",
    compile: {
      args: [
        "clang++",
        target.targetArguments[0]!,
        "-Wall",
        "-Os",
        "-c",
        "sketch.cpp",
        "-o",
        "sketch.o",
      ],
      overlaySlots: [
        { id: "target", index: 2 },
        { id: "defines", index: 3 },
        { id: "memory", index: 4 },
        { id: "variant", index: 5 },
      ],
      source: "sketch.cpp",
      object: "sketch.o",
      artifactIds: ["compile-vfs"],
      languageFlags: {
        c: ["@sdk/flags/c_flags", "-x", "c", "-std=gnu17"],
        cxx: ["@sdk/flags/cpp_flags"],
        asm: ["@sdk/flags/S_flags", "-x", "assembler-with-cpp"],
      },
    },
    link: {
      args: [
        "clang++",
        target.targetArguments[0]!,
        "-nostdlib",
        "-Lsdk/lib",
        "sketch.o",
        "-Wl,--end-group",
        "-o",
        "firmware.elf",
      ],
      overlaySlots: [
        { id: "target", index: 2 },
        { id: "memory", index: 3 },
        { id: "flags", index: 4 },
      ],
      object: "sketch.o",
      elf: "firmware.elf",
      artifactIds: ["link-vfs"],
    },
    platformManifestArtifact: {
      id: "platform-manifest",
      sha256: digest(platformManifestBytes),
    },
    platformRef,
    sdkVariant: {
      id: `arduino-${target.slug}-sdk`,
      sdkTarget: target.slug,
      memoryType: target.memoryType,
      compilerPack: {
        id: target.compilerId,
        version: "22.0.0",
        sha256: "a".repeat(64),
      },
    },
    recipeOrigins: {
      compile: platformManifest.recipeLowering.bindings.compile.cxx,
      link: platformManifest.recipeLowering.bindings.link,
    },
    recipeLowering: {
      status: "manifest-defined",
      schemaVersion: platformManifest.recipeLowering.schemaVersion,
      sha256: platformManifest.recipeLowering.sha256,
    },
    migration: { legacySchema: 4, legacyArtifact: "profile" },
  };
  const boardProfile = {
    schema: 4,
    id: `arduino-${target.slug}-default`,
    board: target.board,
    sdkVersion: "3.3.7",
    variant: target.slug,
    options: { ...target.options },
    artifactIds: ["variant"],
    overlay: {
      compile: {
        target: target.targetArguments.slice(1),
        defines: [
          `-DF_CPU=${target.options.cpu_freq ?? "160000000L"}`,
          `-DARDUINO_${boardDefine}`,
          `-DARDUINO_BOARD="${boardDefine}"`,
          `-DARDUINO_VARIANT="${target.slug}"`,
          `-DARDUINO_PARTITION_${target.options.partition_scheme ?? "default"}`,
        ],
        memory: [`-Isdk/${target.memoryType}/include`],
        variant: ["-Ivariant"],
      },
      link: {
        target: target.targetArguments.slice(1),
        memory: [`-Lsdk/${target.memoryType}`],
        flags: ["-Wl,--gc-sections"],
      },
    },
    image: target.image,
    flash: {
      bootloader: "bootloader",
      partitions: "partitions",
      bootApp0: "boot-app0",
      offsets: {
        bootloader: target.bootloaderOffset,
        partitions: "0x8000",
        bootApp0: "0xe000",
      },
    },
    platformRef: { ...platformRef, fqbn: target.board },
    execution: {
      targetTriple,
      targetArguments: [...target.targetArguments],
      elf: {
        machine: targetTriple.startsWith("riscv32-") ? 243 : 94,
        floatAbi: 0,
      },
    },
    migration: { legacySchema: 3, legacyArtifact: "profile" },
  };
  return { platformProfile, boardProfile, platformManifest };
}

function dependenciesFor(target: MatrixTarget) {
  const { platformProfile, boardProfile, platformManifest } =
    sdkProfile(target);
  const profileBytes = encodeJson(platformProfile);
  const boardProfileBytes = encodeJson(boardProfile);
  const platformManifestBytes = encodeJson(platformManifest);
  const compileTreeBytes = Uint8Array.of(1);
  const linkTreeBytes = Uint8Array.of(2);
  const variantTreeBytes = Uint8Array.of(3);
  const bootApp0Bytes = Uint8Array.of(4);
  const bootloaderBytes = Uint8Array.of(5);
  const partitionsBytes = Uint8Array.of(6);
  const manifests = new Map([
    [
      target.compilerId,
      {
        schema: 1,
        id: target.compilerId,
        version: "22.0.0",
        revision: "a".repeat(64),
        artifacts: [],
      },
    ],
    [
      `arduino-${target.slug}-sdk`,
      {
        schema: 2,
        id: `arduino-${target.slug}-sdk`,
        version: "3.3.7",
        revision: "b".repeat(64),
        artifacts: [
          {
            id: "compile-vfs",
            kind: "tree",
            size: 1,
            sha256: digest(compileTreeBytes),
            files: [
              {
                path: "include/header.h",
                offset: 0,
                length: 1,
                sha256: digest(compileTreeBytes),
              },
            ],
          },
          {
            id: "link-vfs",
            kind: "tree",
            size: 1,
            sha256: digest(linkTreeBytes),
            files: [
              {
                path: "link/core.a",
                offset: 0,
                length: 1,
                sha256: digest(linkTreeBytes),
              },
            ],
          },
          {
            id: "platform-manifest",
            kind: "json",
            size: platformManifestBytes.byteLength,
            sha256: digest(platformManifestBytes),
          },
          {
            id: "profile-v5",
            kind: "json",
            size: profileBytes.byteLength,
            sha256: digest(profileBytes),
          },
        ],
      },
    ],
    [
      `arduino-${target.slug}-board`,
      {
        schema: 2,
        id: `arduino-${target.slug}-board`,
        version: "3.3.7",
        revision: "c".repeat(64),
        artifacts: [
          {
            id: "boot-app0",
            kind: "data",
            size: 1,
            sha256: digest(bootApp0Bytes),
          },
          {
            id: "bootloader",
            kind: "data",
            size: 1,
            sha256: digest(bootloaderBytes),
          },
          {
            id: "partitions",
            kind: "data",
            size: 1,
            sha256: digest(partitionsBytes),
          },
          {
            id: "profile-v4",
            kind: "json",
            size: boardProfileBytes.byteLength,
            sha256: digest(boardProfileBytes),
          },
          {
            id: "variant",
            kind: "tree",
            size: 1,
            sha256: digest(variantTreeBytes),
            files: [
              {
                path: "variant/pins.h",
                offset: 0,
                length: 1,
                sha256: digest(variantTreeBytes),
              },
            ],
          },
        ],
      },
    ],
  ]);
  const artifactBytes = new Map<string, Uint8Array>([
    [`arduino-${target.slug}-sdk/compile-vfs`, compileTreeBytes],
    [`arduino-${target.slug}-sdk/link-vfs`, linkTreeBytes],
    [`arduino-${target.slug}-sdk/platform-manifest`, platformManifestBytes],
    [`arduino-${target.slug}-sdk/profile-v5`, profileBytes],
    [`arduino-${target.slug}-board/boot-app0`, bootApp0Bytes],
    [`arduino-${target.slug}-board/bootloader`, bootloaderBytes],
    [`arduino-${target.slug}-board/partitions`, partitionsBytes],
    [`arduino-${target.slug}-board/profile-v4`, boardProfileBytes],
    [`arduino-${target.slug}-board/variant`, variantTreeBytes],
  ]);
  return {
    createPackLoader({ expectedId }: { expectedId: string }) {
      return {
        async loadManifest() {
          const manifest = manifests.get(expectedId);
          if (!manifest)
            throw new Error(`unexpected fake manifest ${expectedId}`);
          return manifest;
        },
        async loadArtifact(id: string) {
          const bytes = artifactBytes.get(`${expectedId}/${id}`);
          const artifact = manifests
            .get(expectedId)
            ?.artifacts.find((candidate) => candidate.id === id);
          if (!bytes || !artifact)
            throw new Error(`unexpected fake artifact ${expectedId}/${id}`);
          return {
            artifact,
            bytes: new Uint8Array(bytes),
          };
        },
        reset: vi.fn(),
      };
    },
    async loadToolchain() {
      return {
        runClang: vi.fn(async () => {
          throw new Error("fake Action must not invoke clang");
        }),
        runLLVM: vi.fn(async () => {
          throw new Error("fake Action must not invoke LLVM");
        }),
      };
    },
    preprocess: vi.fn(() => ({ cpp: "" })),
    buildImage: vi.fn(async () => ({
      image: Uint8Array.of(1),
      elfSha256Embedded: true,
      elfSha256Offset: 0xb0,
    })),
  };
}

function copyAction(target: MatrixTarget) {
  return target.createActionRequest({
    id: 2,
    action: {
      id: `${target.slug}-pack-copy`,
      kind: "transform",
      tool: "ck:pack-copy",
      inputs: [{ path: "build/input.bin" }],
      outputs: [{ path: "build/output.bin" }],
      arguments: [],
      environment: {},
      dependencies: [],
      packDependencies: [],
      cacheKey: "d".repeat(64),
      transform: {
        input: "build/input.bin",
        output: "build/output.bin",
        format: "bin",
        flags: [],
      },
    },
    inputs: [{ path: "build/input.bin", bytes: Uint8Array.of(7, 8, 9) }],
  });
}

describe("ESP32 v2 Worker Action session production matrix", () => {
  it.each(matrixTargets)(
    "$label routes init/action/close through its v2 Action entry",
    async (target) => {
      const posted: Array<{ message: any; transfer?: Transferable[] }> = [];
      const listeners = new Map<string, (event: any) => void>();
      const dependencies = dependenciesFor(target);
      const actionHandler = target.createWorkerActionHandler({
        dependencies,
        postMessage(message: any, transfer?: Transferable[]) {
          queueMicrotask(() =>
            listeners.get("message")?.({ data: message, transfer }),
          );
        },
      });

      class WorkerHarness {
        addEventListener(type: string, listener: (event: any) => void) {
          listeners.set(type, listener);
        }

        postMessage(message: any, transfer?: Transferable[]) {
          posted.push({ message, transfer });
          void actionHandler({ data: message });
        }

        terminate() {}
      }

      const runtimeDescriptor = descriptor(target);
      const session = await target
        .createLauncher({
          enabled: true,
          WorkerClass: WorkerHarness as never,
          performanceRef: {},
        })
        .openActionSession({
          descriptor: runtimeDescriptor,
          descriptorUrl,
        });

      const actionRequest = copyAction(target);
      const result = await session.runAction(actionRequest.action, {
        inputs: actionRequest.inputs,
      });
      await session.close();

      expect(result).toMatchObject({
        outputs: [{ path: "build/output.bin", bytes: Uint8Array.of(7, 8, 9) }],
      });
      expect(posted.map(({ message }) => message.type)).toEqual([
        "init",
        "action",
        "close",
      ]);
      expect(posted.every(({ message }) => message.type !== "compile")).toBe(
        true,
      );
      expect(posted[0]!.message).toMatchObject({
        abi: 1,
        type: "init",
        id: 1,
        runtime: { descriptor: { id: target.runtimeId, board: target.board } },
      });
      expect(posted[1]!.message).toMatchObject({
        abi: 1,
        type: "action",
        id: 2,
        action: { tool: "ck:pack-copy" },
      });
      expect(posted[2]!.message).toMatchObject({
        abi: 1,
        type: "close",
        id: 3,
      });
    },
  );
});
