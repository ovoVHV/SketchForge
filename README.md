# SketchForge

**把 Arduino 开发搬进浏览器。写代码、编译固件、下载产物，直接连接开发板烧录。**

**A complete Arduino workflow in the browser: edit, compile, download, flash, and monitor.**

[立即体验](https://www.niubikaka.lat/arduino/) | [支持矩阵](docs/SUPPORT_MATRIX.md) | [Apache-2.0](LICENSE)

[![Source checks](https://github.com/ovoVHV/SketchForge/actions/workflows/source-check.yml/badge.svg)](https://github.com/ovoVHV/SketchForge/actions/workflows/source-check.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> SketchForge 是可直接使用的网页 Arduino IDE，不是只能保存文本的编辑器。当前在线实例已经能够对已发布的 AVR 与 ESP32 目标完成浏览器编译、生成固件、下载固件，并通过 Web Serial 烧录到开发板。
>
> SketchForge is a working browser IDE, not a text editor demo. The hosted instance can compile supported AVR and ESP32 targets, produce firmware, download it, and flash boards through Web Serial.

## 中文

### 一页完成从代码到板子的流程

打开网页，写下 Arduino C/C++，选择板卡，点击编译。编译成功后可以保存或下载固件；连接 USB 开发板并授权串口后，直接点击烧录。烧录完成后，串口监视器仍在同一页面里。

```text
编辑代码 -> 选择板卡 -> 浏览器编译 -> 查看诊断与 Flash/RAM 占用
                                      |
                                      +-> 下载 .hex / .bin 固件
                                      +-> Web Serial 烧录 -> 串口监视器
```

### 现在就能用

| 能力 | 说明 |
| --- | --- |
| 网页编辑器 | Arduino C/C++、多文件项目、文件夹导入、源码文件管理 |
| 浏览器编译 | Web Worker + WebAssembly 在用户设备上完成主要编译工作 |
| 编译结果 | 错误诊断、编译进度、Flash/RAM 占用、`.hex` / `.bin` 固件下载 |
| 直接烧录 | AVR 使用 STK500，ESP32 使用 `esptool-js`，USB 不需要交给服务器 |
| 串口调试 | 同页打开串口监视器，查看开发板输出 |
| 库与项目 | 145 个库、147 个锁定版本，GitHub 库导入，项目云保存与归档导入导出 |

### 三步开始

1. 打开[在线体验](https://www.niubikaka.lat/arduino/)，选择要使用的板卡。
2. 在编辑器中写入或导入项目，点击“编译”，等待浏览器生成固件。
3. 选择“下载固件”，或连接开发板后授权串口并点击“烧录到板子”。

桌面版 Chrome 或 Edge 的 HTTPS 页面最适合烧录。Safari 和 iOS 当前不提供 Web Serial，但仍然可以编辑、编译和下载固件。

### 当前可用板卡

| 系列 | 浏览器编译目标 | 烧录方式 |
| --- | --- | --- |
| Arduino AVR | Uno、Duemilanove / Diecimila、Nano | Web Serial / STK500 |
| ESP32 | ESP32、ESP32-S2、ESP32-S3、ESP32-C3、ESP32-C6 | Web Serial / `esptool-js` |

Mega、ESP32-C5、ESP32-H2 和 ESP32-P4 的板卡定义与规划代码仍保留在源码中，方便后续兼容；它们目前不在公开运行资产的可用目标列表里。完整 FQBN、运行资产和状态请查看[支持矩阵](docs/SUPPORT_MATRIX.md)。

“支持”表示当前板卡路径和对应运行资产有实现或验证，不表示每一个处理器选项、分区组合和第三方库都已经逐一验证。库兼容会随着新的 Pack 测试和发布持续增加。

### 已验证的 16 路并发编译

2026-08-10，我们用同一个浏览器会话启动了 `16` 份互不相同的 ESP32 源码，覆盖 ESP32、ESP32-C3、ESP32-C6、ESP32-S2 和 ESP32-S3。`16/16` 全部编译成功，失败数为 `0`；16 路任务有约 `59` 秒的完整重叠执行窗口，单任务页面耗时约 `59-113` 秒。

这里的“16 路并发”指浏览器本地编译：每个任务在独立的 Web Worker 和项目快照中运行，服务器主要分发页面与版本化资产。它不是“一台服务器同时运行 16 个编译器”，也不是对一千名首次冷启动用户的容量承诺。工具链和 SDK 等不可变资产仍可能被同源浏览器缓存，完整边界记录见 [MIXLU.md](MIXLU.md)。

### 并发问题的后续解决路线

并发不是靠把所有编译都堆到一台小服务器上解决，而是按请求类型分层：

| 层级 | 做法 | 解决的问题 |
| --- | --- | --- |
| 浏览器编译 | Web Worker + WASM，编译 CPU 由用户设备分担 | 大多数用户不占用服务器编译 CPU |
| 资产分发 | WASM、Board Pack、SDK 和库按版本固定摘要发布到 CDN，浏览器预取并长期缓存 | 避免每个用户重复下载大文件，降低源站带宽峰值 |
| 服务端兜底 | Gateway 接收请求，Redis/BullMQ 排队，按 AVR、ESP32 Xtensa、ESP32 RISC-V 分池 | 浏览器不支持的板卡仍有可靠路径 |
| 横向扩容 | 增加同版本 Worker，按队列长度和 CPU/内存自动扩容；每个任务使用独立临时目录 | 把并发编译能力从单机容量变成 Worker 池容量 |
| 流量保护 | 每用户配额、队列上限、取消任务、超时、幂等键和失败重试 | 高峰时不让内存、磁盘和队列失控 |

当前公开版已经完成浏览器侧的 16 路验证；下一阶段才是给服务端 Worker 做独立的冷启动、排队、扩容和故障恢复压测。这样即使同时有很多人访问，静态页面和编译任务也不会互相拖垮。

### 为什么不需要下载 Arduino CLI

SketchForge 把编辑器、版本化工具链和项目 API 放在网页端。支持的编译任务在每位用户自己的浏览器 Worker 中运行，服务器主要负责页面、资产和项目资料分发；因此用户不需要先下载体积很大的 Arduino CLI，服务器也不需要为每个访问者启动一个完整编译器。

浏览器编译使用独立的项目快照和临时状态。每个用户、每个标签页的源文件互相隔离；不可变工具链和确定性结果可以按内容缓存，但不会因为缓存而共享另一个用户的可变源文件。

### 烧录和串口

烧录是浏览器到 USB 设备的直接操作，服务器不接管用户的串口：

- AVR 通过页面内的 STK500 流程写入 `.hex`。
- ESP32 通过 `esptool-js` 写入生成的固件分段。
- 用户必须主动点击并选择串口设备，浏览器不会静默访问 USB。
- 烧录需要 HTTPS 或 `localhost`，并使用支持 Web Serial 的桌面浏览器。
- 编译成功后的固件也可以只下载，不连接开发板。

### 开源仓库包含什么

仓库包含网页编辑器、浏览器编译器源码、Build IR、板卡配置、项目和库 API、服务端 Gateway、分布式队列/worker、Docker 参考配方、测试以及工具链来源锁。它是可以继续开发和部署的完整工程，而不是只截取了一个编辑器页面。

为了控制仓库体积并遵守上游许可证，预编译 WASM 工具链、Arduino Core、ESP32 SDK、Library Pack、缓存和生产密钥按版本放在对象存储或 CDN 中，不直接提交到 Git。在线实例已经准备了相应运行资产；新克隆者只需按发布文档准备同版本资产，即可还原对应的浏览器编译能力。

### 工程与部署边界

<details>
<summary>展开查看项目限制、服务端入口和运维合同</summary>

#### 项目和请求限制

- 总计最多 128 个项目文件。
- 项目源码总量不超过 2 MiB。
- 完整 JSON 请求体不超过 8 MiB。
- 每位访客限制为 16 个项目和 4 MiB；生产 Compose 的全局项目存储上限为 `AF_PROJECT_GLOBAL_MAX_BYTES=67108864`。
- 当前浏览器库目录包含 145 个库、147 个锁定版本；具体可用性仍取决于板卡和库 Pack。

#### 编译取消和跨源部署

- 浏览器本地编译通过 `AbortController` 取消 Worker 工作。
- 服务端 `POST /v1/compile` 仍在途时，前端会保存取消句柄；用户点击取消后会立即发送带 token 的 `DELETE` 请求。
- 跨源部署需要配置允许的来源，并正确处理 `OPTIONS` 预检请求。
- 队列失败任务按 `AF_FAILED_JOB_TTL_SECONDS` 和 `AF_MAX_FAILED_JOBS_PER_POOL` 策略保留；生产默认使用 `AF_MAX_FAILED_JOBS_PER_POOL=25` 和 `AF_FAILED_JOB_TTL_SECONDS=3600`。

#### 服务端入口

根目录的 `npm run dev` 与 `npm start` 默认启动完整 Gateway，提供 `/v1/projects`、`/v1/libraries/catalog`、`/v1/libraries/installed`、队列与静态网页 API。旧的本机单进程 NativeExecutor 入口仍可显式运行：`npm run dev:monolith` 与 `npm run start:monolith`。

#### 容量和后续路线

浏览器优先架构让服务器主要承载网页、资产、API 和项目资料，编译 CPU 主要由访问者设备承担。当前已经有单浏览器会话 `16` 份唯一源码并发成功的实测证据；这说明架构方向可行，但不等于一台小 VPS 已验证可以同时运行一千个服务端编译器。真实容量还取决于静态资源带宽、访问者设备、缓存命中率、库 Pack 和服务端兜底 Worker 数量。

静态 HTTP 压测脚本只验证网页和资产分发，不提交编译任务：

```powershell
$env:AF_BASE_URL = 'https://your-host.example/arduino/'
node scripts/bench-static-http.mjs
```

它只请求 `GET /healthz`、`GET /app.js` 和有上限的 Range 片段，不访问 `/v1/compile`，结果不能直接解释成同时编译用户数。

下一步工作：

- [x] 完成 16 份唯一源码的浏览器并发编译验证。
- [ ] 为服务端兜底建立按架构分池的 Worker，加入队列背压、自动扩容、取消、超时和失败重试。
- [ ] 把大体积编译资产放到 CDN，完成冷缓存下载、弱设备和长稳并发压测。
- [ ] 接入真实硬件 runner，扩大自动化实板验证；当前用户已经可以通过浏览器 Web Serial 完成烧录。

发布可再分发的 AVR 编译资产前，AVR GPL 对应源码是商业公开发布门禁；Arduino、Espressif、GNU、LLVM、第三方库和工具链资产继续遵循各自许可证。

</details>

### 本地开发

需要 Node.js 20 或更高版本：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run audit:source-release
```

这些检查验证源码、类型、测试和公开发布清单，不会自动下载未提交的大型工具链，也不会向线上服务提交编译任务。`docker/` 下的文件是部署参考配方，运行时 Pack 和发布资产需要单独准备并完成许可证审计。

### 目录

- `boards/`：板卡定义、上传协议和选项。
- `crates/ck-build-core/`：Rust Build IR 核心。
- `packages/core/`：编译请求、规划、缓存、工具链和库模型。
- `packages/web/`：编辑器、浏览器 Worker、烧录器、串口监视器和前端测试。
- `packages/server/`：Fastify API、项目存储、队列和编译 worker。
- `toolchains/`：固定版本的源码锁、补丁和上游许可记录。
- `docker/`：Gateway、AVR worker 和 ESP32 worker 的参考部署配方。

### 许可证

SketchForge 原创源码使用 [Apache License 2.0](LICENSE)。你可以使用、修改、分发和商用，但需要保留许可证、版权和 NOTICE。Arduino、Espressif、GNU、LLVM、第三方库及工具链资产继续使用各自的许可证，详见 [NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [LICENSES/](LICENSES/)。

SketchForge 是独立项目，与 Arduino、Espressif 及其商标所有者没有官方隶属关系。

---

## English

### A working Arduino IDE in your browser

SketchForge is a complete browser-first Arduino workflow. The hosted instance already supports editing sketches, compiling supported AVR and ESP32 targets, downloading firmware, flashing boards through Web Serial, and opening a serial monitor in the same page.

This is not a mock editor or a static code box. Write Arduino C/C++, choose a board, compile in the browser, inspect diagnostics and memory usage, then either download the artifact or authorize a USB serial device and flash it.

### What you get

| Capability | Details |
| --- | --- |
| Browser editor | Arduino C/C++, multi-file projects, folder import, and source-file management |
| Browser compiler | Web Worker + WebAssembly; most compile CPU stays on the user's device |
| Build output | Progress, diagnostics, Flash/RAM usage, and `.hex` / `.bin` downloads |
| Direct flashing | AVR through STK500; ESP32 through `esptool-js` and Web Serial |
| Serial monitor | Inspect board output without leaving the editor |
| Projects and libraries | Cloud project storage, archive import/export, GitHub library import, 145 libraries and 147 locked versions |

### Start in three steps

1. Open the [online demo](https://www.niubikaka.lat/arduino/) and choose a board.
2. Write or import a project, then click **Compile**.
3. Download the firmware, or authorize a serial device and click **Flash**.

Desktop Chrome or Edge over HTTPS is recommended for Web Serial. Safari and iOS can still edit, compile, and download firmware, but do not currently expose Web Serial.

### Current browser targets

| Family | Targets | Flash path |
| --- | --- | --- |
| Arduino AVR | Uno, Duemilanove / Diecimila, Nano | Web Serial / STK500 |
| ESP32 | ESP32, ESP32-S2, ESP32-S3, ESP32-C3, ESP32-C6 | Web Serial / `esptool-js` |

Board definitions for Mega, ESP32-C5, ESP32-H2, and ESP32-P4 remain in the source for future compatibility, but are not advertised as available by the current open-source runtime assets. See the [support matrix](docs/SUPPORT_MATRIX.md) for exact FQBNs and status.

### How the workflow works

The server delivers the editor, versioned runtime assets, and project APIs. Supported builds run inside an isolated browser Worker using a project snapshot and Build IR. Each tab and user has independent mutable state; immutable toolchains and deterministic outputs may be cached by content identity without sharing source files.

Flashing is a browser-to-device operation. The server does not take over USB, and the user must explicitly select the serial device. AVR uses the in-page STK500 flow; ESP32 uses `esptool-js` with the generated firmware segments.

### Source release and deployment

The repository contains the editor, browser compiler source, Build IR, board profiles, project and library APIs, Gateway, distributed queues/workers, Docker recipes, tests, and toolchain provenance locks. Large generated WASM toolchains, Arduino Cores, ESP32 SDK files, Library Packs, caches, and production secrets are published separately through versioned object storage or a CDN so that the source tree stays reviewable and licenses remain traceable.

The hosted instance has the matching runtime assets already published. A fresh clone needs the corresponding versioned assets before it can reproduce the same board coverage; that is a release packaging step, not a missing editor or flashing workflow.

### Engineering notes

- Projects are bounded to 128 files, 2 MiB of UTF-8 source, and 8 MiB complete JSON requests.
- A single browser session has been verified compiling 16 unique ESP32 sketches concurrently, with all 16 builds succeeding. This measures browser-side capacity, not 16 server workers and not a promise for 1,000 cold-start users.
- The production browser-first path is designed to move compile CPU to users' devices. It is not a claim that one small VPS can run one thousand server-side compiler processes.
- The distributed queue and worker path is included for deployments that need a server fallback; a hosted deployment must provision the matching worker runtime and immutable assets.
- The next automation item is a real hardware runner. Browser Web Serial flashing is already part of the user workflow.

### Concurrency roadmap

The scaling plan is deliberately layered:

| Layer | Plan | Why it matters |
| --- | --- | --- |
| Browser builds | Compile in isolated Web Workers with WASM on each user's device | Most compile CPU stays off the server |
| Asset delivery | Publish immutable WASM, Board Packs, SDKs, and libraries by digest through a CDN, with prefetching | Removes repeated large downloads from the origin |
| Server fallback | Route through Gateway and Redis/BullMQ queues, with separate AVR, Xtensa, and RISC-V pools | Keeps unsupported or blocked browser builds reliable |
| Horizontal scale | Add matching Workers and autoscale from queue depth and CPU/memory pressure; use a temporary directory per job | Turns concurrency into a pool-sizing problem instead of a single-host limit |
| Protection | Per-visitor quotas, admission control, cancellation, timeouts, idempotency, and bounded retries | Prevents spikes from exhausting memory, disk, or the queue |

The 16-build browser test is complete. Cold-start, queue, autoscaling, and failure-recovery tests for the server fallback remain a separate release stage.

### Development checks

Node.js 20 or newer is required:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run audit:source-release
```

The default checks cover source code and release hygiene. They do not download excluded compiler packs or submit builds to a hosted service.

### License

Original SketchForge source is licensed under the [Apache License 2.0](LICENSE). Use, modification, redistribution, and commercial use are allowed as long as the license, copyright, and NOTICE requirements are preserved. Arduino, Espressif, GNU, LLVM, libraries, and toolchain assets retain their own licenses; see [NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [LICENSES/](LICENSES/).

SketchForge is an independent project and is not officially affiliated with Arduino or Espressif.
