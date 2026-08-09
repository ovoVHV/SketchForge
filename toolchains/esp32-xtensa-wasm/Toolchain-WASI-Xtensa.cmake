set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(WASI_SDK_ROOT "$ENV{WASI_SDK_ROOT}" CACHE PATH "WASI SDK 29.0 root")
if(NOT WASI_SDK_ROOT)
  message(FATAL_ERROR "Set WASI_SDK_ROOT to the pinned WASI SDK 29.0 directory")
endif()

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

set(CMAKE_C_COMPILER "${WASI_SDK_ROOT}/bin/clang")
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER "${WASI_SDK_ROOT}/bin/clang++")
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_LINKER "${WASI_SDK_ROOT}/bin/wasm-ld")
set(CMAKE_AR "${WASI_SDK_ROOT}/bin/ar")
set(CMAKE_RANLIB "${WASI_SDK_ROOT}/bin/ranlib")

set(WASI_SYSROOT "${WASI_SDK_ROOT}/share/wasi-sysroot")
set(WASI_COMMON_FLAGS
  "--sysroot ${WASI_SYSROOT} -mcpu=lime1 -D_WASI_EMULATED_MMAN -ffunction-sections -fdata-sections")
set(CMAKE_C_FLAGS_INIT "${WASI_COMMON_FLAGS}")
set(CMAKE_CXX_FLAGS_INIT "${WASI_COMMON_FLAGS}")
set(CMAKE_EXE_LINKER_FLAGS_INIT
  "--sysroot ${WASI_SYSROOT} -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first -Wl,--gc-sections -Wl,--strip-all")
