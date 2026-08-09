# ESP32 Browser Image Builder

`image-builder.js` is the image-packaging portion of the browser-side ESP32
compiler path. It turns a finished 32-bit little-endian Xtensa or RISC-V ELF
into the target ESP32 application `.bin` layout used by esptool 5.x. It is
intentionally standalone so the compiler Web Workers can invoke it without a
server.

The writer handles each target's extended header (including ESP32-C3 chip ID
`5` and ESP32-C6 chip ID `13`), DROM/IROM MMU page placement, the ROM XOR
checksum, the appended SHA-256 validation digest, and the conventional
`.flash.appdesc` ELF digest placeholder at file offset `0xb0` when it is
present and zero-filled.

## Browser project boundary

The release-pinned ESP32, ESP32-S2, ESP32-S3, ESP32-C3, and ESP32-C6 browser
route accepts only a bounded `files[]` project. A project contains at least one
root `.ino` file, at most 128 files in total, `.c`, `.cc`, `.cpp`, `.cxx`, `.S`,
`.asm`, `.h`, `.hh`, `.hpp`, `.hxx`, `.inc`, `.ipp`, or `.tpp` auxiliary files,
and at most 2 MiB of UTF-8 source. The Worker ABI is Action-only: validation,
project resolution, preprocessing, and CK Build IR planning happen before the
Worker receives individual compile, link, or transform Actions.

Root `.ino` files are composed as one Arduino translation unit. `main.ino` is
the primary tab when present (case-insensitive); otherwise the first UTF-16
code-unit ordered path is primary, and the remaining tabs follow that same
stable order.

Paths are relative, ASCII-only, at most eight segments deep, and checked for
case-insensitive duplicates, ambiguous header basenames, NUL bytes, traversal,
and object-prototype segments before a Worker is launched. Project files are
mounted below an isolated `project/` VFS directory.

The release-pinned browser library catalog currently contains 145 libraries
and 147 locked versions. The same-origin `release.js` pins the registry
SHA-256, and every registry entry pins an immutable source Pack whose chunks
and reconstructed artifact are verified independently. The original 12-library
release directory remains beside the catalog as a rollback source.
Library files are mounted below
`libraries/<pack-id>/`, compiled independently, and linked with project
objects. Unknown names or versions fall back to the server. Arbitrary uploaded
ZIP libraries, precompiled archives, and build scripts are not accepted by
this path.

`npm run build:browser-esp32-catalog-packs` creates a deterministic plan for
every entry in CK's checked-in Arduino catalog under
`var/browser-library-catalog-packs/`. It does not change the release-pinned
registry. Add `-- --build --limit N` to download at most `N` official Arduino
ZIP archives, verify their SHA-256 values, safely decode bounded ZIP entries,
and emit content-addressed `library-source-json` packs for review. The default
plan targets `esp32` and uses four bounded download workers; both can be changed
with `--architecture` and `--concurrency`. A generated
Every generated pack must pass the complete five-target primary-header Browser
Library Matrix before publication. After review,
`npm run publish:browser-esp32-catalog-packs -- --evidence <merged-report.json>`
requires successful evidence matching the candidate Registry SHA-256,
revalidates every referenced Pack, publishes it beside the stable rollback
directory, and updates the release pin.
Archives that require generated sources,
library-specific build scripts, precompiled objects, or more than the 2 MiB
browser artifact limit remain server-fallback candidates.

## Current boundary

- Supports ELF32, little-endian, `EM_RISCV` and Xtensa executables and their
  data-bearing sections only. ELF64, relocatable objects, program-header mode,
  secure-boot padding, encrypted images, and RAM-only bootloader images are
  intentionally outside this component's scope.
- Input and final image are each capped at 64 MiB, individual output segments
  at less than 16 MiB, and images at 16 segments. These are browser-side safety
  limits as well as ESP image-format limits.
- A mapped `.flash.appdesc` causes the ELF digest to be attempted at `0xb0`.
  If that offset lands in a written payload, the destination must be a 32-byte
  zero-filled span or the build fails rather than overwriting application data.
  A malformed linker layout that leaves `0xb0` outside all payloads is reported
  as `elfSha256Embedded: false`, allowing the worker to reject that artifact.
- The component requires Web Crypto (`crypto.subtle`) for both ELF and image
  SHA-256 values. It has no Node.js dependency.
