# ESP32-C3/C6 RISC-V Browser Compiler Source Lock

This directory defines the source lock and minimal YoWASP patch originally used
for the C3 browser compiler feasibility build. The resulting compiler lineage
is now consumed by the release-pinned C3 and C6 browser runtimes under
`packages/web/public/esp32/v2/`. This source directory is not itself a runtime:
generated compiler, SDK, Arduino core, and board assets remain separate
content-addressed Packs.

The compiler is a WASI-hosted LLVM driver. Its host stays
`wasm32-wasip1`; the patch changes the code-generation backend from
WebAssembly to RISC-V. This is sufficient for the Arduino ESP32-C3 profile's
`rv32imc_zicsr_zifencei` target only if the acceptance checks below pass.

Build the pinned-source candidate on a CI builder runner with at least 16 GiB RAM
and 30 GiB free disk:

```sh
docker build \
  --file docker/Dockerfile.browser-esp32c3-toolchain \
  --target artifact \
  --output type=local,dest=dist/esp32c3-riscv-wasm \
  .
```

The repository also contains a manual GitHub Actions workflow at
`.github/workflows/browser-esp32c3-riscv-wasm.yml`. It targets a self-hosted
Linux x86-64 runner carrying the `esp32c3-wasm` label. The workflow checks the
runner's RAM and the free space on both the workspace and Docker data filesystems
before starting the build. Configure that label only on runners with at least
16 GiB RAM, 30 GiB free disk, Docker, and Docker Buildx.

The 16 GiB value is a conservative requirement for compiling LLVM from source on
the CI builder. It is not a browser download size, browser WebAssembly memory
target, or end-user device requirement. The production runtime independently
measures browser heap headroom, loads compiler/SDK/board Packs lazily, and falls
back to the server when the selected browser cannot satisfy that runtime budget.

After building, the workflow installs the generated package and calls its WASM
Clang API with `--target=riscv32-esp-elf`,
`-march=rv32imc_zicsr_zifencei`, and `-mabi=ilp32`. It first validates an ELF32
little-endian `EM_RISCV` relocatable object with the RVC and soft-float ABI flags,
then compiles and links a freestanding RV32IMC ELF through the same package. The
download includes the package, license files, source provenance, smoke object/report,
`SHA256SUMS`, and an artifact manifest.

These candidate smoke tests deliberately exclude Arduino inputs. A passing run
does not by itself prove the Arduino core/ESP-IDF link, image generation, browser
execution, or hardware flash loop; those are separate release gates.

After downloading the real workflow artifact to a host with Arduino-ESP32 3.3.7,
run the SDK acceptance gate before considering any release work:

```sh
npm run verify:browser-esp32c3-arduino-sdk -- <artifact-directory>
```

On the verified C3 UART board, append `--flash-port COM13` (or the platform's
serial-port path). That mode uses the production `flashEsp32()` implementation,
requires the post-flash automatic reset, and waits for the newly compiled
firmware's unique serial marker. It is intentionally opt-in because it writes
to physical hardware.

The output is an experimental npm-style compiler artifact, not a CDN release.
Promotion into the current content-addressed runtime was gated separately
against Arduino-ESP32 3.3.7 by all of the following:

1. Compile a C++ Arduino sketch with `--target=riscv32-esp-elf` and
   `-march=rv32imc_zicsr_zifencei`.
2. Link the resulting object, the Arduino core, and C3 SDK archives using
   `ld.lld`, including the SDK's `R_RISCV_ALIGN` relocation.
3. Produce an ELF accepted by the browser image builder and byte-compare its
   app image to esptool output.
4. Flash the C3 and observe the firmware's serial marker without a manual
   reset.

The release runtime obtains target runtime libraries, Arduino core, and ESP-IDF
archives from its independently pinned SDK Pack; they are not hidden inside the
compiler artifact. Current C3/C6 descriptors, Pack revisions, production-route
tests, and image parity are checked by `ck-build-platform.yml`. A prior C3
descriptor also completed four-part flashing, automatic reset, and serial-marker
readback; the current descriptor still remains subject to the explicit hardware
matrix in the root README. License, source-offer, and notice material ships with
the compiler and SDK release metadata.
