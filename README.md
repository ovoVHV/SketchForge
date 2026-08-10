# SketchForge

**面向精选 Arduino / ESP32 目标的浏览器 IDE 预览：编辑、浏览器本地编译、下载固件，并在支持 Web Serial 的浏览器中烧录。**

**A working browser IDE preview for selected Arduino and ESP32 targets: edit, compile locally in the browser, download firmware, and flash through Web Serial.**

[在线实例](https://www.niubikaka.lat/arduino/) | [支持矩阵](docs/SUPPORT_MATRIX.md) | [第三方来源](THIRD_PARTY_NOTICES.md) | [Apache-2.0](LICENSE)

[![Source checks](https://github.com/ovoVHV/SketchForge/actions/workflows/source-check.yml/badge.svg)](https://github.com/ovoVHV/SketchForge/actions/workflows/source-check.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **v0.1 定位：** 当前是针对有限板卡与精选库的可用预览，不是完整 Arduino 生态替代品，也没有经过 1000 个真实浏览器的分布式验收。
>
> **v0.1 status:** This is a working preview for a bounded board and library set. It is not a complete replacement for the Arduino ecosystem and has not passed a distributed 1,000-browser certification.

## 先说清楚

| 问题 | 当前事实 |
| --- | --- |
| 这是从零开始的新项目吗？ | 不是。SketchForge 由此前的 **ArduinoFast** 工程演进并更名，仓库历史和部分兼容标识仍保留 `ArduinoFast` / `AF_*`；`CK` 是构建核心的内部技术标识。更名不代表代码或技术来源被重新发明。 |
| 浏览器编译器是本项目首创吗？ | 不是。GNU/LLVM 工具链、Arduino/Espressif 平台、YoWASP wrapper、`esptool-js` 等来自成熟上游。SketchForge 的工作重点是集成、构建规划、Pack 合同、浏览器 Worker、缓存、隔离、UI 和部署。 |
| Git clone 后等于在线实例吗？ | 不等于。公开仓库是 **source-only preview**，不包含大型 WASM 工具链、Arduino Cores、ESP32 SDK 和 Library Packs。当前还没有一个第三方可一键复现线上能力的完整公开 runtime bundle。 |
| 145 个库代表 Arduino 生态兼容吗？ | 不代表。它们是生产 active Registry 中经过固定版本和 Pack 对账的**精选白名单**，不是对 [Arduino 公共库目录](https://docs.arduino.cc/libraries/) 的广泛覆盖声明。 |
| 服务端兜底和 CDN 已上线吗？ | 截至 2026-08-11，公开实例是 `browser-only`，`serverCompile=false`、`workers=0`；Pack 仍由同源站点分发，尚未完成 CDN 验收。 |
| 已经支持 1000 人同时编译吗？ | 不能这样宣称。浏览器计算分散在用户设备上，但当前源站没有通过 1000 人冷启动资产分发测试，也没有执行 1000 个真实浏览器的分布式编译。 |

历史名称尚未全部清理是当前 release hygiene 债务，不应被描述成已经完成的从零重写。兼容存储键和部署变量会谨慎迁移；面向用户的残留标签应继续修正。

## 上游基础与本项目工作

SketchForge 不声称发明了 browser GCC、Clang/LLD、Arduino Core 或浏览器烧录协议。

**主要上游基础：**

- GNU AVR GCC / binutils、Arduino AVR Core 与 avr-libc。
- Arduino-ESP32、ESP-IDF 与 Espressif LLVM/Clang 工具链。
- YoWASP 的 WASI/JavaScript wrapper 工作；ESP32 工具链打包明确复用了固定版本的 wrapper 文件。
- `esptool-js`、Web Serial 以及第三方 Arduino libraries。

**本仓库主要实现和维护：**

- 编辑器、项目快照、多文件工作流、诊断、固件下载和 Web Serial 产品流程。
- Build IR、Action 规划、板卡配置以及 Platform / Board / Library Pack 合同。
- 浏览器 Worker 编排、资产校验、内容寻址缓存、取消和输入隔离。
- Gateway、项目 API、可选服务端队列/worker 参考实现，以及来源锁和发布门禁。

相关先行项目包括 [begeistert/wasm-toolchains](https://github.com/begeistert/wasm-toolchains) 和 [horang-corp/avr-gcc-wasm](https://github.com/horang-corp/avr-gcc-wasm)。它们证明浏览器工具链早于 SketchForge 存在；本项目不主张“第一个浏览器 Arduino 编译器”。具体归属、版本和许可证见 [NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[LICENSES/](LICENSES/) 和 `toolchains/`。

## 当前可用范围

| 能力 | 公开实例现状 |
| --- | --- |
| 编辑器 | Arduino C/C++ 语法高亮、多文件项目、文件夹导入、归档导入导出 |
| 浏览器编译 | Web Worker + WebAssembly；主要编译 CPU 在用户设备上运行 |
| 编译输出 | 进度、诊断、Flash/RAM 占用、`.hex` / `.bin` 固件下载 |
| 烧录 | AVR 使用页面内 STK500；ESP32 使用 `esptool-js`；需要用户主动授权串口 |
| 串口监视器 | 支持 Web Serial 的桌面 Chrome / Edge 可用 |
| 库 | 145 个库、147 个锁定版本的精选 active Registry；兼容性仍取决于板卡和具体 API |

### 当前浏览器目标

| 系列 | 当前目标 | 烧录路径 |
| --- | --- | --- |
| Arduino AVR | Uno、Duemilanove / Diecimila、Nano | Web Serial / STK500 |
| ESP32 | ESP32、ESP32-S2、ESP32-S3、ESP32-C3、ESP32-C6 | Web Serial / `esptool-js` |

Mega、ESP32-C5、ESP32-H2 和 ESP32-P4 只保留了定义或规划代码，当前公开运行资产不支持。Safari 和 iOS 没有 Web Serial；它们可以编辑、编译和下载，但不能直接烧录。完整边界见[支持矩阵](docs/SUPPORT_MATRIX.md)。

## 现有证据及其边界

### 功能证据

公开实例已经实际生成过 AVR/ESP32 固件，并完成浏览器下载；Web Serial 烧录流程存在且可由用户在真实开发板上操作。自动化实板矩阵仍未建立，因此这不是“所有板卡、选项和 USB 芯片都已验证”的声明。

### 16 路项目方实验

2026-08-10，项目方在同一台测试电脑、同一浏览器会话中发起 16 份不同 ESP32 源码，覆盖 ESP32、C3、C6、S2 和 S3。`16/16` 成功，约有 59 秒完整重叠窗口，页面任务耗时约 59 至 113 秒。

这是**项目方自测**，只证明该机器、浏览器、缓存状态、运行资产和测试草图组合能够完成这 16 个任务。它不证明低端设备、大型工程、冷缓存、全部库、长期稳定性或 1000 个独立用户。完整浏览器 trace、机器资源曲线和可独立复跑的 benchmark evidence bundle 尚未随本次源码发布。

### 2026-08-11 源站容量检查

从一台本地负载机直连当前源站得到以下结果；这不是第三方或多地域认证：

| 场景 | 结果 |
| --- | ---: |
| 1000 用户瞬时元数据请求模型 | `496/1000` 用户完整成功 |
| 1000 用户、最多 250 活跃 | `958/1000` 用户完整成功 |
| 1000 用户、最多 100 活跃 | `977/1000` 用户完整成功 |
| 单用户 ESP32-S3 完整 Pack | `1/1` 成功，约 62.5 秒 |
| 10 用户 ESP32-S3 完整 Pack | `8/10` 完整成功，聚合约 `2.76 MiB/s` |

按这次请求模型，1000 份 S3 冷启动约为 `55.66 GiB`。当前源站和连接稳定性不足以支撑这一场景，因此没有继续制造完整 1000 份下载。结论是：**浏览器端编译方向可用，但千人冷启动资产分发尚未通过。**

## 在线实例与源码发布的差距

仓库包含产品源码、构建模型、板卡配置、测试、Docker 参考文件和上游来源锁，但大型生成资产不在 Git 中。在线实例已经部署匹配资产，而 fresh clone 只能先运行源码检查；要获得相同编译覆盖，还需要获取或重建精确版本的工具链、Core、SDK 和 Pack，并履行各上游许可证。

目前尚缺一个版本化、带校验和、第三方可以端到端复现的公开 runtime release。这是明确的发布缺口，不应写成“clone 后只需简单配置即可完全还原”。

## 本地源码检查

需要 Node.js 20 或更高版本：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run audit:source-release
```

这些命令验证公开源码、类型和发布清单，不会下载缺失的大型运行资产，也不会证明 hosted instance 可被完整复现。

## 后续工作

- 发布可审计、版本化的 runtime bundle 和端到端复现说明。
- 把不可变 Pack 接入 CDN / 对象存储，再分别测试 CDN warm 与 cold fill。
- 在独立 VM 上完成多地域、分布式真实浏览器验收；在此之前不宣称 1000 浏览器通过。
- 扩展板卡、菜单组合和库兼容矩阵，并加入真实硬件 runner。
- 服务端 fallback 只有在实际部署 worker 并通过队列/故障测试后才标记为可用。

## 许可证

SketchForge 原创源码使用 [Apache License 2.0](LICENSE)。使用、修改、分发和商用需要保留许可证、版权与 NOTICE。Arduino、Espressif、GNU、LLVM、YoWASP、`esptool-js`、第三方库和生成工具链继续使用各自许可证；根许可证不会把它们重新许可为 Apache-2.0。

SketchForge 是独立项目，与 Arduino、Espressif 及其他上游商标所有者没有官方隶属关系。

---

## English

### Read this first

SketchForge is a working integration preview for selected Arduino and ESP32 targets. It evolved from the earlier **ArduinoFast** codebase; the rename is not a from-scratch rewrite. Legacy `ArduinoFast` / `AF_*` compatibility identifiers and internal `CK` build names still exist and are release-hygiene work, not new provenance.

SketchForge does **not** claim to have invented browser GCC, Clang/LLD, Arduino Cores, or browser flashing. It integrates GNU/LLVM toolchains, Arduino and Espressif platforms, pinned YoWASP wrapper work, `esptool-js`, Web Serial, and third-party libraries. Project-owned work is concentrated in product integration, Build IR/action planning, Pack contracts, browser Worker orchestration, validation, caching, input isolation, UI, provenance gates, and deployment code.

Related prior art includes [begeistert/wasm-toolchains](https://github.com/begeistert/wasm-toolchains) and [horang-corp/avr-gcc-wasm](https://github.com/horang-corp/avr-gcc-wasm). SketchForge does not claim to be the first browser Arduino compiler. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/](LICENSES/) for attribution.

### Current release boundary

- The hosted instance compiles selected AVR and ESP32 targets in browser Workers, produces firmware, and exposes Web Serial flashing in supported desktop browsers.
- Current targets are Uno, Duemilanove/Diecimila, Nano, ESP32, ESP32-S2, ESP32-S3, ESP32-C3, and ESP32-C6.
- Mega, ESP32-C5, ESP32-H2, and ESP32-P4 are retained but unavailable.
- The 145 libraries / 147 locked versions are a curated compatibility allowlist, not broad coverage of the Arduino library ecosystem.
- Safari and iOS do not expose Web Serial.
- As of 2026-08-11, the public deployment is browser-only (`serverCompile=false`, `workers=0`) and has no validated Pack CDN.

### Source-only preview

A fresh clone is not equivalent to the hosted deployment. Generated WASM toolchains, Arduino Cores, ESP32 SDK files, Library Packs, caches, and production secrets are excluded from Git. There is not yet a single versioned public runtime bundle that lets an independent reviewer reproduce the complete hosted board coverage end to end. That is an open release gap.

The repository contains the editor and workflow source, Build IR, board profiles, Pack contracts, Gateway and optional queue/worker code, Docker references, tests, and provenance locks. Operators must obtain or rebuild exact runtime assets and preserve their upstream licenses before deployment.

### Evidence, not promises

The project-run 16-build experiment completed 16 unique ESP32 sketches in one browser session with a roughly 59-second full-overlap window. This is evidence for one machine, browser, cache state, runtime set, and sketch set. It is not evidence for low-end devices, large projects, every library, cold-cache performance, long-duration reliability, or 1,000 independent browsers. A complete browser trace, machine-resource profile, and independently runnable benchmark evidence bundle are not yet part of this source release.

A 2026-08-11 single-origin load check achieved only `496/1000` complete users in the instantaneous metadata model. A ten-user full ESP32-S3 Pack run completed `8/10` users at roughly `2.76 MiB/s` aggregate. The current origin therefore has **not** passed a 1,000-user cold start. No distributed 1,000-browser build has been executed.

### Development checks

Node.js 20 or newer is required:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run audit:source-release
```

These commands validate source and release hygiene. They do not download the excluded runtime assets or reproduce the hosted deployment by themselves.

### License

Original SketchForge source is licensed under the [Apache License 2.0](LICENSE). Arduino, Espressif, GNU, LLVM, YoWASP, `esptool-js`, libraries, and generated toolchain assets retain their own licenses. The root license does not relicense third-party components. See [NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [LICENSES/](LICENSES/).

SketchForge is independent and is not officially affiliated with Arduino, Espressif, or other upstream trademark owners.
