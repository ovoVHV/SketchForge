# MIXLU Project Progress

Last updated: 2026-08-10 10:06:01 +08:00

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

## Remaining work

1. Publish and document the matching immutable runtime assets for fresh clones.
2. Add the retained board Packs and expand the verified library matrix.
3. Provision and validate a separate server Worker topology for unsupported
   browser targets and server-side fallback.
4. Add an automated real hardware runner and record repeatable board evidence.
