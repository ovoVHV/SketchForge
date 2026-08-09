#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

readonly SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly REPOSITORY_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
readonly LLVM_SOURCE=${LLVM_SOURCE:-"$PWD/llvm-project"}
readonly BUILD_ROOT=${BUILD_ROOT:-"$PWD/esp32-xtensa-wasm-build"}
readonly WASI_SDK_ROOT=${WASI_SDK_ROOT:-}
readonly JOBS=${ESP32_XTENSA_WASM_JOBS:-2}
readonly NATIVE_BUILD="$BUILD_ROOT/llvm-tblgen-build"
readonly WASM_BUILD="$BUILD_ROOT/llvm-build"
readonly RESOURCE_PREFIX="$BUILD_ROOT/clang-resource-headers/wasi-prefix"
readonly RESOURCE_HEADERS="$WASM_BUILD/lib/clang/23/include"
readonly TOOLCHAIN="$REPOSITORY_ROOT/toolchains/esp32-xtensa-wasm/Toolchain-WASI-Xtensa.cmake"

[[ "$(uname -s)" == Linux ]] || fail "the compiler build requires Linux"
[[ "$(uname -m)" == x86_64 ]] || fail "the pinned WASI SDK requires x86-64 Linux"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || fail "ESP32_XTENSA_WASM_JOBS must be a positive integer"
[[ -f "$LLVM_SOURCE/llvm/CMakeLists.txt" ]] || fail "LLVM_SOURCE is not a complete llvm-project checkout"
[[ -f "$LLVM_SOURCE/clang/CMakeLists.txt" ]] || fail "LLVM_SOURCE does not contain clang"
[[ -f "$LLVM_SOURCE/lld/CMakeLists.txt" ]] || fail "LLVM_SOURCE does not contain lld"
[[ -x "$WASI_SDK_ROOT/bin/clang" ]] || fail "WASI_SDK_ROOT does not contain bin/clang"
[[ -x "$WASI_SDK_ROOT/bin/wasm-ld" ]] || fail "WASI_SDK_ROOT does not contain bin/wasm-ld"
command -v cmake >/dev/null || fail "cmake is not installed"
command -v ninja >/dev/null || fail "ninja is not installed"

cmake --fresh -G Ninja -S "$LLVM_SOURCE/llvm" -B "$NATIVE_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  '-DLLVM_ENABLE_PROJECTS=clang' \
  -DLLVM_TARGETS_TO_BUILD= \
  -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_ENABLE_BINDINGS=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_CURL=OFF \
  -DLLVM_ENABLE_FFI=OFF \
  -DLLVM_ENABLE_HTTPLIB=OFF \
  -DLLVM_ENABLE_LTO=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_BUILD_TOOLS=OFF \
  -DCLANG_BUILD_TOOLS=OFF \
  -DLLVM_APPEND_VC_REV=OFF
cmake --build "$NATIVE_BUILD" --target llvm-tblgen clang-tblgen -- -j"$JOBS"

cmake --fresh -G Ninja -S "$LLVM_SOURCE/llvm" -B "$WASM_BUILD" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
  -DWASI_SDK_ROOT="$WASI_SDK_ROOT" \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1 \
  '-DLLVM_ENABLE_PROJECTS=clang;lld' \
  -DLLVM_TARGETS_TO_BUILD= \
  -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa \
  -DLLVM_TABLEGEN="$NATIVE_BUILD/bin/llvm-tblgen" \
  -DCLANG_TABLEGEN="$NATIVE_BUILD/bin/clang-tblgen" \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_ENABLE_BINDINGS=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_CURL=OFF \
  -DLLVM_ENABLE_FFI=OFF \
  -DLLVM_ENABLE_HTTPLIB=OFF \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_LTO=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_BUILD_TOOLS=OFF \
  -DCLANG_BUILD_TOOLS=OFF \
  -DLLD_BUILD_TOOLS=OFF \
  -DLLD_BUILD_ONLY_ELF=ON \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_TOOL_LLVM_AR_BUILD=ON \
  -DLLVM_TOOL_LLVM_CAS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CGDATA_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CTXPROF_UTIL_BUILD=OFF \
  -DLLVM_TOOL_LLVM_CXXFILT_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DWARFDUMP_BUILD=OFF \
  -DLLVM_TOOL_LLVM_GPU_LOADER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_IR2VEC_BUILD=OFF \
  -DLLVM_TOOL_LLVM_NM_BUILD=OFF \
  -DLLVM_TOOL_LLVM_OBJCOPY_BUILD=ON \
  -DLLVM_TOOL_LLVM_OBJDUMP_BUILD=OFF \
  -DLLVM_TOOL_LLVM_OFFLOAD_BINARY_BUILD=OFF \
  -DLLVM_TOOL_LLVM_OFFLOAD_WRAPPER_BUILD=OFF \
  -DLLVM_TOOL_LLVM_READOBJ_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SIZE_BUILD=OFF \
  -DLLVM_TOOL_LLVM_SYMBOLIZER_BUILD=OFF \
  -DLLVM_TOOL_SANCOV_BUILD=OFF \
  -DLLVM_TOOL_LLVM_RC_BUILD=OFF \
  -DLLVM_TOOL_LLVM_ML_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LIPO_BUILD=OFF \
  -DLLVM_TOOL_LLVM_LIBTOOL_DARWIN_BUILD=OFF \
  -DLLVM_TOOL_LLVM_IFS_BUILD=OFF \
  -DLLVM_TOOL_LLVM_GSYMUTIL_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DWP_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DEBUGINFOD_FIND_BUILD=OFF \
  -DLLVM_TOOL_LLVM_DEBUGINFOD_BUILD=OFF \
  -DLLVM_TOOL_DSYMUTIL_BUILD=OFF \
  -DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF \
  -DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF \
  -DLLVM_APPEND_VC_REV=OFF
cmake --build "$WASM_BUILD" --target llvm-driver clang-resource-headers -- -j"$JOBS"

[[ -d "$RESOURCE_HEADERS" ]] || fail "Clang resource headers were not generated: $RESOURCE_HEADERS"

case "$RESOURCE_PREFIX" in
  "$BUILD_ROOT"/*) ;;
  *) fail "resource prefix escaped BUILD_ROOT" ;;
esac
cmake -E rm -rf "$RESOURCE_PREFIX"
cmake -E make_directory "$RESOURCE_PREFIX/usr"
cmake -E copy_directory "$RESOURCE_HEADERS" "$RESOURCE_PREFIX/usr/include"

printf 'PASS llvm-driver %s\n' "$WASM_BUILD/bin/llvm"
printf 'PASS resources   %s\n' "$RESOURCE_PREFIX"
