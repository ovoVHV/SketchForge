# ArduinoFast

`v0.1.0-browser-preview` | Apache-2.0 | 中文 / English

ArduinoFast is a browser-first Arduino editor. A user writes an Arduino
sketch in a web page; supported builds run in a Web Worker in that user's
browser. The server provides the editor API, project storage, static files,
and an optional queue architecture for a future server-side fallback. The
server is not a USB bridge and does not perform board flashing.

## 中文

### 项目是什么

ArduinoFast 是一个浏览器优先的 Arduino 网页编辑器：用户不需要在本机
下载体积很大的 Arduino CLI，网页可以把支持的编译任务交给浏览器中的
Web Worker 和 WebAssembly 执行。服务器主要承担网页/API/项目资料服务；
服务端编译 worker 是可选的后续能力，不能把当前源码版理解为已经开启了
服务端兜底。

当前发布的是 **源码版预览**，不是线上运行资产的完整镜像。仓库不携带
预编译工具链、WASM 编译器、Arduino Core、ESP32 SDK、库 Pack、缓存、
生产部署密钥或 CDN 发布目录。克隆本仓库后不能直接得到线上同样的
“打开即编译”资产；重新生成或发布这些资产时，必须单独完成上游源码、
许可证和可复现构建审计。

### 当前板卡状态

| 状态 | FQBN / 板卡 |
| --- | --- |
| 浏览器路径已验证或纳入当前支持目标 | Arduino AVR Uno、Duemilanove/Diecimila、Nano；ESP32、ESP32-S2、ESP32-S3、ESP32-C3、ESP32-C6 |
| 定义保留，但当前暂不可用 | Arduino AVR Mega；ESP32-C5、ESP32-H2、ESP32-P4 |

“已支持”只表示当前浏览器编译路径和板卡配置已经有对应实现或验证，
不表示每一个处理器选项、分区方案、第三方库组合都兼容。暂不可用板卡
的 JSON 定义和规划代码保留在仓库中，后续兼容时可以继续完善，不应在
发布说明中把它们标成可编译。

### 库兼容性

Arduino 库兼容性仍在逐库增加。库源代码、库目录和预编译 Library Pack
不属于本次源码版；每个库需要单独确认来源、版本、许可证、头文件布局和
浏览器编译结果。不要把线上缓存的库目录直接提交到公开仓库。

### 浏览器编译与烧录

浏览器编译大致经过以下边界：

```text
editor -> project snapshot -> Build IR -> browser Worker -> hex/bin artifact
                                                    |
                                                    +-> Web Serial (user approved)
```

浏览器编译任务的源文件和临时结果在用户自己的浏览器 Worker 中处理；
不同用户不会共享可变的项目工作目录。服务端模式（未来启用时）应使用
每个 job 的独立输入快照和临时空间；相同的确定性结果可以共享不可变缓存，
但不能因此暴露另一个用户的源文件。Web Serial 烧录需要用户在支持的
浏览器中明确选择串口，USB 数据不会由服务器代替用户接管。

### 并发边界

浏览器优先架构可以让服务器主要承载静态网页、API 和项目资料，用户的
编译 CPU 主要消耗在各自设备上。这不等于服务器已经验证能让一千个任务
同时由服务器编译，也不等于一台 4 核 4 GB 机器能承担一千个服务端编译器。
真实上线容量还取决于带宽、浏览器设备、缓存命中率、Redis、库 Pack 和
服务端兜底 worker 数量。

本仓库只提供不提交编译任务的静态 HTTP 测试：

```powershell
$env:AF_BASE_URL = 'https://your-host.example/arduino/'
node scripts/bench-static-http.mjs
```

它只请求 `GET /healthz`、`GET /app.js`，以及最多 256 KiB 的
`Range: bytes=0-...` 请求；不访问 `/v1/compile`、不发送 POST、不完整下载
大型工具链文件。结果只能描述为“已验证的 HTTP 连接/静态分发并发档位”，
不能称为“同时编译用户数”。

### 源码检查

要求 Node.js 20 或更高版本：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

这些命令验证 TypeScript 源码和不依赖预编译固件资产的单元测试，不会自动
下载本仓库未包含的运行时 Pack，也不会替线上服务器提交编译任务。完整的
浏览器运行时构建还需要单独准备并审计上游工具链和库资产。

`docker/` 中的文件是参考构建配方，不是可直接还原线上服务的发布物。
Gateway/worker 镜像仍需要本仓库明确排除的运行时 Pack、平台清单、预构建
目录或已编译 TypeScript 输出；这些输入必须单独生成并完成许可证审计。

### 目录说明

- `boards/`：板卡定义和选项。
- `crates/ck-build-core/`：Rust Build IR 核心源码。
- `packages/core/`：编译请求、Build IR、缓存和库模型。
- `packages/server/`：Fastify API、项目资料和队列/worker 边界源码。
- `packages/web/`：浏览器编译器、Worker、编辑器测试和源码模块。
- `packages/web/public/`：稳定前端源码快照；大型运行资产被排除。
- `toolchains/`：固定版本的源码锁、本地补丁和上游许可证；不含工具链二进制。
- `scripts/bench-static-http.mjs`：安全的静态 HTTP 并发探测。

### 许可证

ArduinoFast 自研源码使用 Apache License 2.0，见 [`LICENSE`](LICENSE)。
Apache-2.0 只覆盖本项目原创源码和由贡献者明确提交的原创内容；它不会
覆盖 Arduino、Espressif、GNU、LLVM、第三方库、npm 依赖或其他上游资产。
再分发时请同时阅读 [`NOTICE`](NOTICE) 和
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，保留上游版权和许可证
声明。ArduinoFast 与 Arduino、Espressif 及其商标所有者没有官方隶属关系。

## English

### What it is

ArduinoFast is a browser-first Arduino editor. Users write sketches in a web
page, and supported builds run in a Web Worker backed by WebAssembly on the
user's device. The server primarily serves the editor, API, projects, and
static files. A server-side compile queue is an optional future fallback; it
is not enabled by this source release.

This release is **source-only**. It intentionally excludes prebuilt compiler
and toolchain assets, WASM binaries, Arduino Cores, ESP32 SDK assets, library
Packs, caches, production deployment credentials, and generated CDN directories.
A fresh clone is therefore not an out-of-the-box copy of the hosted compiler.
Anyone rebuilding or publishing those assets must complete the upstream source,
license, and reproducible-build review separately.

### Board status

| Status | Boards / FQBN families |
| --- | --- |
| Browser path verified or part of the current support target | Arduino AVR Uno, Duemilanove/Diecimila, Nano; ESP32, ESP32-S2, ESP32-S3, ESP32-C3, ESP32-C6 |
| Definitions retained, currently unavailable | Arduino AVR Mega; ESP32-C5, ESP32-H2, ESP32-P4 |

Supported means that the browser route and board profile have an implementation
or verification path. It does not promise compatibility with every processor
option, partition layout, or third-party library. Retained-but-unavailable
board JSON and planning code are deliberately kept for later work and must not
be advertised as currently compilable.

### Libraries, compilation, and flashing

Library compatibility is being added one library at a time. Library source
trees, catalogs, and prebuilt Library Packs are not part of this source release;
each library needs its own version, provenance, license, layout, and browser
compatibility review.

Browser compilation keeps project inputs and temporary results in the user's
own Worker. Users do not share a mutable project workspace. A future server
fallback must use per-job input snapshots and temporary directories; immutable
content-addressed results may be deduplicated without exposing source files.
Flashing is a browser Web Serial operation requiring explicit user permission;
the server does not take over the USB connection.

### Concurrency and safe HTTP testing

The browser-first design moves most compile CPU to users' devices, leaving the
server to handle static delivery, APIs, and project data. That is not a claim
that one small server can run one thousand server-side compilers. Capacity
depends on bandwidth, client hardware, cache hit rate, Redis, library Packs,
and any future fallback workers.

The repository's static benchmark is intentionally limited to HTTP delivery:

```bash
AF_BASE_URL=https://your-host.example/arduino/ node scripts/bench-static-http.mjs
```

It performs only health, `app.js`, and bounded 256 KiB Range requests. It never
calls `/v1/compile`, sends no POST, and never downloads a large compiler asset
in full. Its result is an HTTP/static-distribution concurrency observation,
not a simultaneous compile-user guarantee.

### Source checks

Node.js 20 or newer is required:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

The checks cover TypeScript and source-level unit tests that do not require the
excluded firmware/runtime assets. Full browser runtime builds require a
separately prepared and licensed asset set.

Files under `docker/` are reference build recipes, not a self-contained hosted
release. Gateway and worker images still require excluded runtime Packs,
platform manifests, prebuild directories, or compiled TypeScript output. Those
inputs must be generated and licensed separately. `toolchains/` retains pinned
source locks, local patches, and upstream license texts only; it contains no
compiler binaries.

### License

Original ArduinoFast source is released under Apache License 2.0; see
[`LICENSE`](LICENSE). Apache-2.0 does not relicense Arduino, Espressif, GNU,
LLVM, third-party libraries, npm dependencies, or other upstream assets. See
[`NOTICE`](NOTICE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and
preserve the relevant upstream notices when redistributing. ArduinoFast is not
officially affiliated with Arduino or Espressif.
