# ESP32 Xtensa Browser Compiler Source Lock

This directory records the reproducible source inputs originally prepared for
the WASI-hosted Xtensa compiler candidate and now pinned by the ESP32,
ESP32-S2, and ESP32-S3 v5 browser runtimes. It is source metadata rather than a
runtime bundle; the published release claim is carried by each descriptor,
content-addressed Pack manifest, and release report.

The compiler source is Espressif's LLVM fork at the exact revision in
`source-lock.json`. Apply `espressif-llvm-wasi.patch` to a clean checkout of
that revision. The patch contains 44 content-changing files. The local
`llvm/cmake/config.guess` line-ending-only working-tree change is deliberately
excluded.

```sh
git clone https://github.com/espressif/llvm-project.git
cd llvm-project
git checkout 570c44b61995a6e0d7d9c7c5c9e78e9e40a8e6ec
git apply --check ../espressif-llvm-wasi.patch
git apply ../espressif-llvm-wasi.patch
```

Build the patched checkout with the repository's no-LTO script. The script
first builds matching native TableGen executables, then the WASI-hosted
`llvm-driver` plus Clang resource headers. The default is two compile jobs so
it remains usable on a memory-constrained builder; override it only after
measuring available memory.

```sh
export LLVM_SOURCE=$PWD/llvm-project
export BUILD_ROOT=$PWD/esp32-xtensa-wasm-build
export WASI_SDK_ROOT=$PWD/wasi-sdk-29.0-x86_64-linux
ESP32_XTENSA_WASM_JOBS=2 /path/to/arduinofast/scripts/build-esp32-xtensa-wasm.sh
```

The host toolchain is the official WASI SDK 29.0 x86-64 Linux archive. Its
release URL, byte size, and SHA-256 are pinned in `source-lock.json`. Browser
packaging reuses the YoWASP JavaScript API wrapper files from the separately
pinned YoWASP Clang revision, with the exact `jco` and `@yowasp/runtime`
versions recorded beside it.

The compiler artifact version used by the current v5 runtime is pinned as
`23.0.0-espressif.570c44b6.12`; pass that exact value to
`scripts/package-esp32-xtensa-wasm.mjs --version`.

The `licenses/` directory contains the Arduino-ESP32 license declaration and
the SPDX texts required by the SDK inputs. The runtime builder also copies the
compiler package's own license/notices and the installed Espressif GCC/newlib
license tree when assembling each candidate runtime.
