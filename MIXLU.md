# MIXLU Project Progress

Last updated: 2026-08-10 12:59:21 +08:00

This file is the public progress snapshot. It contains no server credentials,
private keys, deployment passwords, or private operational paths.

## Project goal

SketchForge is a browser-based Arduino IDE. Users can write Arduino C/C++,
compile supported projects in the browser, download firmware, flash AVR and
ESP32 boards through Web Serial, and inspect serial output without installing
the full Arduino CLI locally.

## Current product status

- Browser editing, browser compilation, firmware download, Web Serial flashing,
  and the serial monitor are implemented for the published targets.
- The hosted instance has the matching immutable compiler and board assets.
- The browser-first path moves most compile CPU to the visitor's device; the
  small server primarily delivers the application, assets, and project APIs.
- Server-side compile fallback and automated hardware runners remain separate
  deployment work. Their absence does not disable the browser compile or flash
  workflow.

## Stage record

| Stage | Status | Completion | Evidence or result |
| --- | --- | ---: | --- |
| Build IR and Browser/Native planning contracts | Complete | 100% | TypeScript, Rust, WASM, provenance, and fail-closed contract work is in the source tree |
| ESP32 post-link and custom partition contracts | Complete | 100% | Browser and Native paths share manifest-owned products, partition parsing, output hashes, and size checks |
| Active release and Gateway static closure | Complete | 100% | Active-only release metadata, asset allowlists, CDN-safe manifests, and Gateway contracts are checked in |
| Project recovery, cancellation, and progress feedback | Complete | 100% | Per-tab recovery, cancellation handles, SSE stages, and visible progress wiring are included |
| Source release hygiene | Complete | 100% | Apache-2.0, notices, source audit, package metadata, and sensitive-file exclusions are present |
| SketchForge rename and public documentation | Complete | 100% | Source identifiers, UI labels, README, support matrix, and compatibility migration are updated |
| 16-way unique-source browser concurrency | Complete | 100% | One browser session compiled 16 different ESP32 sketches successfully (`16/16`), with a roughly 59-second full overlap window |
| Automated hardware runner | Pending | 0% | Browser Web Serial already works; CI hardware automation is intentionally left for a later stage |

## Published browser targets

- Arduino AVR: Uno, Duemilanove / Diecimila, Nano.
- ESP32: ESP32, ESP32-S2, ESP32-S3, ESP32-C3, ESP32-C6.
- Mega, ESP32-C5, ESP32-H2, and ESP32-P4 definitions remain retained for later
  runtime publication and are not advertised as active targets.
- The ESP32 browser library catalog currently contains 145 libraries and 147
  locked versions. A particular library still depends on its board Pack and
  compatibility evidence.

## Engineering boundaries

- A project accepts at most 128 files, 2 MiB of UTF-8 source, and an 8 MiB
  complete JSON request body.
- Custom ESP32 partition input accepts the exact root `partitions.csv` path;
  arbitrary nested or renamed partition files remain rejected.
- Browser compilation uses an isolated project snapshot and Worker state for
  each tab. Immutable toolchain and result caches may be shared by content
  identity, but mutable user source is not shared.
- Web Serial is a direct browser-to-device flow requiring explicit permission;
  the server is not a USB bridge.

## Browser concurrency evidence

- The 2026-08-10 test used 16 unique sketches with actually called per-task
  `volatile` symbols, so identical source fingerprints could not explain the
  result. ESP32, C3, C6, S2, and S3 targets were mixed across the 16 tabs.
- All 16 builds succeeded. Page-reported compile times were approximately
  59-113 seconds, and the first and last requests were started within about
  2.3 seconds.
- This is browser-side capacity under warm immutable asset conditions. It is
  not evidence of 16 server workers, a completely cold download, or a promise
  of 1,000 simultaneous first-time users.
- The public repository commit `d062eefb15a0849e5fb6aca2a95ad8991106e5a1`
  is on `main`; GitHub Actions Source checks run `31357358066` completed with
  `success`.

## Concurrency plan

1. Keep the browser-first path as the default so visitor devices carry most
   compile CPU.
2. Publish immutable compiler and Board Pack assets through a digest-addressed
   CDN with prefetching and long-lived browser caching.
3. Put server fallback behind Redis/BullMQ queues and separate AVR, Xtensa,
   and RISC-V Worker pools.
4. Scale matching Workers from queue depth and CPU/memory pressure, isolate
   every job in a temporary directory, and enforce quotas, cancellation,
   timeouts, idempotency, and bounded retries.

## Remaining work

1. Publish and document the matching immutable runtime assets for fresh clones.
2. Add the retained board Packs and expand the verified library matrix.
3. Provision and validate a separate server Worker topology for unsupported
   browser targets and server-side fallback, including cold-start and queue
   pressure tests.
4. Put the large runtime assets behind a CDN and test weak devices and cold
   cache downloads.
5. Add an automated real hardware runner and record repeatable board evidence.
