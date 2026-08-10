# Forge Component Lab

Forge Component Lab is an isolated architecture experiment beside SketchForge.
It explores a component deployment model for microcontrollers without changing
the existing Arduino firmware compiler or the hosted editor.

Forge Component Lab 是 SketchForge 旁边的隔离架构实验。它验证 MCU 组件化
部署，不修改当前可用的 Arduino 完整固件编译和烧录流程。

## One Goal / 唯一目标

Build one `blink.wasm`, run those exact bytes in a browser simulator, then send
the same bytes to a Forge Runtime on an ESP32-C3 without rebuilding or flashing
the complete device firmware.

生成一个 `blink.wasm`，让同一份字节先在浏览器模拟器运行，再发送到
ESP32-C3 的 Forge Runtime；更新组件时不重新编译或烧录完整固件。

## Current Status

| Stage | Status | Evidence |
|---|---|---|
| Contract skeleton | Complete | ECABI v0, Manifest Schema, FCMP/1 transport, Blink source |
| Browser build and simulator | Pending | Must build and execute the same Wasm bytes locally |
| Reference device loopback | Pending | Must verify, stage, activate, and roll back a component |
| ESP32-C3 Forge Runtime | Pending | Requires Zephyr/WAMR build and real-board evidence |

This directory is experimental. Nothing here is advertised as production
firmware, a complete WebAssembly Component Model implementation, or verified
ESP32-C3 hardware support yet.

## Scope

ECABI v0 contains only:

- `gpio.configure`
- `gpio.write`
- `timer.sleep-ms`
- `init` and `tick` lifecycle exports

The first component may access only GPIO 8 as an output. The ABI deliberately
does not expose ESP-IDF, Zephyr driver pointers, registers, or arbitrary host
memory.

Not in the first demo: Arduino compatibility, MLIR, ThinLTO, native LLEXT,
network APIs, full Canonical ABI, production signing, or multiple boards.

## Layout

```text
spec/                 Stable experiment contracts
examples/blink/       Portable Blink component source and manifest template
web/                  Browser builder and simulator (next stage)
runtime/reference/    Executable device model (next stage)
runtime/zephyr/       ESP32-C3 host integration (hardware stage)
test/                 Contract, runtime, and transport tests
```

## Contract Rule

The artifact identity is the SHA-256 digest of `app.wasm`. Browser simulation,
loopback deployment, serial deployment, storage, and activation must all refer
to that identity. A host must reject undeclared imports, ABI mismatches,
oversized resources, and GPIO access outside the manifest capability set.

See [ECABI v0](spec/ECABI_V0.md), the
[Manifest Schema](spec/component-manifest.schema.json), and
[FCMP/1](spec/PROTOCOL.md).

