# Third-Party Notices

## Scope

This repository is a source-only preview. Large compiler/runtime assets,
Arduino cores, ESP32 SDK files, library Packs, and generated catalogs are
deliberately excluded. They are not relicensed by the Apache-2.0 license in the
root of this repository. Any operator who obtains or rebuilds those assets must
retain the exact upstream notices for the selected version.

## Browser flashing bundle

`packages/web/public/vendor/esptool.js` is a generated browser bundle used by
the Web Serial flashing path. Its embedded dependencies retain these licenses:

| Component | Version in the development lock | License | Notice |
| --- | --- | --- | --- |
| `esptool-js` | 0.6.0 | Apache-2.0 | `LICENSES/esptool-js-Apache-2.0.txt` |
| `pako` | 2.2.0 | MIT AND Zlib | `LICENSES/pako-MIT-Zlib.txt` |
| `atob-lite` | 2.0.0 | MIT | `LICENSES/atob-lite-MIT.md` |
| `tslib` | 2.8.1 | 0BSD | `LICENSES/tslib-0BSD.txt` and `LICENSES/tslib-CopyrightNotice.txt` |

The bundle is not covered by a blanket relicense of its embedded code. Keep
the files in `LICENSES/` with the bundle when redistributing it.

## JavaScript dependencies

The package manager installs JavaScript dependencies from npm according to
`package-lock.json`; those packages are not copied into this repository. Their
package-level licenses remain with the upstream packages. The direct runtime
and development dependencies used by this source tree include, among others:

- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`: Apache-2.0.
- `@balena/dockerignore`: Apache-2.0.
- `@fastify/cors`, `@fastify/static`, `bullmq`, `esbuild`, `fastify`, `ioredis`,
  `serialport`, `tsx`, and `vitest`: MIT.
- `tar`: Blue Oak Model License 1.0.
- `typescript`: Apache-2.0.
- `@types/node` and `@types/tar`: upstream package licenses as recorded in npm
  metadata.

Transitive dependencies may have additional notices. Review the installed
package metadata before making a redistributable binary or hosted asset bundle.

## Rust dependencies

`crates/ck-build-core` uses `serde`, `serde_json`, `sha2`, and optional
`wasm-bindgen`. These crates are obtained from crates.io and retain their
upstream dual MIT/Apache-2.0 or equivalent notices. The exact resolved versions
and checksums are recorded in `crates/ck-build-core/Cargo.lock`.

## Excluded compiler and library assets

Pinned source locks, local compatibility patches, and upstream license texts
needed to audit selected compiler experiments are retained under `toolchains/`.
They are source and provenance material only; no compiler binary is distributed
there.

The following families are referenced by build-source contracts but are not
distributed here:

- GNU AVR GCC and binutils WebAssembly components, including their GPL and
  related runtime notices.
- Arduino AVR Core, avr-libc, and board/platform files obtained from upstream
  Arduino packages.
- Espressif Arduino-ESP32, ESP-IDF, LLVM/Clang, esptool, bootloader, partition,
  and other ESP32 platform assets.
- Third-party Arduino libraries and their source/binary Packs.

The exact license of an excluded asset is version-specific. Do not copy an
asset into a release directory until its source offer and notices have been
reviewed and added to the corresponding release record.
