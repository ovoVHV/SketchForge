# Browser Toolchain Packs

`toolchain-pack.js` defines schema `1` for immutable browser compiler packs.
It is a transport and integrity layer, not an ESP32 compiler implementation.

Each manifest has a stable `id`, a release `version`, and a `revision`. The
revision is the lowercase SHA-256 of this compact JSON value:

```json
{"schema":1,"id":"<id>","version":"<version>","artifacts":[...]}
```

Every artifact is split into one or more ordered chunks. Each chunk declares a
relative safe path, exact size, and SHA-256; the concatenated artifact also has
an exact size and SHA-256. The loader verifies the manifest revision, every
chunk, and the reconstructed artifact before returning it. It revalidates the
stable manifest URL, resolves chunks only below its directory, uses
`fetch(..., { cache: "force-cache" })` for content-addressed chunks, and
reports cumulative byte progress through `onProgress`.

The manifest revision is a consistency check on its own. A real runtime must
also pass a release-pinned `expectedRevision` from immutable, same-origin
bootstrap code; otherwise a compromised manifest could replace its own
revision. AVR v4 emits that pinned value in its local `release.js`.

Executable JavaScript is outside the CDN trust boundary. The page entrypoint,
preprocessor, Worker entrypoint, Emscripten glue, loader, and pinned release
metadata stay on the application origin. An external origin may serve only the
pack manifest and immutable data artifacts it authenticates, currently WASM
and the virtual-filesystem pack. `verified-emscripten.js` passes WASM bytes to
the local glue only after the pack loader has verified their size and SHA-256.

Schema defaults cap a manifest at 128 artifacts, 256 chunks per artifact,
1 GiB per artifact, and 2 GiB total. A caller may set lower limits for a board
or browser class. Large future ESP32 packs should use reasonably sized chunks
and should be stored on CDN/object storage, never on the application VPS.

The AVR `v4` runtime is the current reference producer and consumer. ESP32-C3
under `esp32/v2/runtime/` and the Xtensa targets under `esp32/v5/xtensa/` use
the same manifest contract for separate compiler, SDK, and flash packs. ESP32,
S2, and S3 share one checksum-pinned compiler pack but use distinct SDK and
flash manifests selected by three release-pinned descriptors. The production
ESP32 library registry currently contains 145 libraries and 147 locked versions,
including the large-library Packs for `lvgl`, `TFT_eSPI`, `U8g2`, `GxEPD2`,
`IRremoteESP8266`, and `ESP8266Audio`. Source Packs are independently
content-addressed and gzip-transported; platform-owned `FS` and `SPIFFS`
libraries use the same registry protocol. The full upstream trees and
precompiled archives are not shipped to the browser.

Release directories are immutable. When publishing changed AVR runtime bytes,
bump `runtimeVersion` in `scripts/build-browser-avr.mjs` and the matching
`avr/vN` references in `packages/web/public/browser-avr.js`; do not overwrite a
directory that may already be cached by users. Apply the same rule to ESP32:
the next changed Xtensa compiler or SDK publication must use `esp32/v6` (or a
later unused version) and update the pins in `esp32/v1/release.js` atomically.
