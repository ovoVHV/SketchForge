# SketchForge ESP32 Xtensa Clang WASM

This package contains an Espressif LLVM/Clang/LLD build hosted by WASI. It
targets the Xtensa processors used by ESP32, ESP32-S2, and ESP32-S3.

The public API is compatible with the YoWASP Clang wrapper:

```js
import { runClang } from '@sketchforge/esp32-xtensa-clang-wasm';

const files = await runClang(
  ['clang', '--target=xtensa-esp-elf', '-mcpu=esp32', '-c', 'main.c', '-o', 'main.o'],
  { 'main.c': 'int value(void) { return 42; }' },
);
```

`runClang(null)` preloads the compiler resources. Commands execute inside the
YoWASP virtual filesystem and return its file tree.

This package is a compiler component, not a claim of hardware validation for
every supported ESP32 board. The consuming SketchForge runtime records its
own SDK, linker, image, browser, and hardware verification state.
