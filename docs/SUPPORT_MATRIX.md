# Support Matrix / 支持矩阵

This document describes the `v0.1.0` browser release boundary. Rows marked
`Supported target` are the targets the hosted browser workflow is prepared to
compile and flash through Web Serial. It is a capability statement, not a
promise that every Arduino library, processor option, or menu combination will
compile.

## Browser route / 浏览器路径

The browser route is the primary user workflow. Compilation runs in a browser
Worker backed by WebAssembly, while flashing is performed by the user's
browser after explicit serial permission. Large immutable runtime Packs are
published separately from the source repository.

| Family | Board | Status | Notes |
| --- | --- | --- | --- |
| AVR | Uno (`arduino:avr:uno`) | Supported target / 当前支持目标 | Browser AVR Worker path |
| AVR | Duemilanove / Diecimila (`arduino:avr:diecimila`) | Supported target / 当前支持目标 | Shared ATmega328P profile |
| AVR | Nano (`arduino:avr:nano`) | Supported target / 当前支持目标 | Classic ATmega328P profile |
| AVR | Mega (`arduino:avr:mega`) | Retained, unavailable / 保留但暂不可用 | Board definition is kept; runtime pack is not active |
| ESP32 | ESP32 (`esp32:esp32:esp32`) | Supported target / 当前支持目标 | Requires separately published runtime assets |
| ESP32 | ESP32-S2 (`esp32:esp32:esp32s2`) | Supported target / 当前支持目标 | Requires separately published runtime assets |
| ESP32 | ESP32-S3 (`esp32:esp32:esp32s3`) | Supported target / 当前支持目标 | Requires separately published runtime assets |
| ESP32 | ESP32-C3 (`esp32:esp32:esp32c3`) | Supported target / 当前支持目标 | C3 browser contract is guarded and pinned |
| ESP32 | ESP32-C6 (`esp32:esp32:esp32c6`) | Supported target / 当前支持目标 | Requires separately published runtime assets |
| ESP32 | ESP32-C5 (`esp32:esp32:esp32c5`) | Retained, unavailable / 保留但暂不可用 | Planning and board definition retained |
| ESP32 | ESP32-H2 (`esp32:esp32:esp32h2`) | Retained, unavailable / 保留但暂不可用 | Planning and board definition retained |
| ESP32 | ESP32-P4 (`esp32:esp32:esp32p4`) | Retained, unavailable / 保留但暂不可用 | Planning and board definition retained |

## Scope notes / 范围说明

- Browser support is limited by the selected board profile, compiler Pack,
  platform Pack, board Pack, browser memory, and library compatibility.
- The hosted instance can compile and flash the supported rows today; a fresh
  source clone must publish matching runtime assets before it has the same
  browser coverage.
- The source repository intentionally omits the large immutable runtime files.
  A hosted deployment may publish them separately only after completing its
  own provenance and license review.
- Web Serial flashing happens in the user's browser after explicit permission.
  It is not a server-side flashing service.
- Identical immutable artifacts may be cached, but each compile request must
  preserve input and job isolation.
- This matrix does not claim a server-side worker is online. A server reporting
  `workers=0` or `serverCompile=false` is operating in browser-only mode.
