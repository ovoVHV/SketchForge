# AVR WebAssembly toolchain source notice

The browser runtime contains AVR GCC and GNU binutils components compiled to
WebAssembly. Those components are GPL-licensed. The hosted integration was
pinned to `@horang-corp/avr-gcc-wasm@0.2.0`; its checksums are emitted into
`WASM_SHA256SUMS` by `scripts/build-browser-avr.mjs`.

The public source preview intentionally does not declare, install, or
redistribute that prebuilt package. This file preserves the historical input
identity so a separately licensed asset build can be audited.

Upstream source reference:

- Repository: https://github.com/horang-corp/avr-gcc-wasm
- Tag: `v0.2.0`
- Commit: `e3a563f765b041623734991125d5640c7e56053e`

The external package's own notices must accompany any separately distributed
binary asset. Before commercial public deployment, replace the pinned binary input with an
independently reproducible build that publishes the complete corresponding GCC,
binutils, Emscripten glue source, patches, and build scripts. The current bundle
is suitable for integration and capacity validation, not the final compliance
sign-off.
