# Embedded Component ABI v0

Status: experimental, version `forge:embedded@0.1`.

ECABI v0 is a deliberately small core-Wasm ABI. WIT is the human-readable
interface source, but the runtime does not implement the full WebAssembly
Component Model or Canonical ABI.

## Core-Wasm Imports

All integer parameters and results use core-Wasm `i32` values. A result of `0`
means success.

| Module | Name | Core signature | Meaning |
|---|---|---|---|
| `forge:embedded/gpio@0.1` | `configure` | `(i32 cap, i32 pin, i32 mode) -> i32` | Configure an allowed pin |
| `forge:embedded/gpio@0.1` | `write` | `(i32 cap, i32 pin, i32 level) -> i32` | Write `0` or `1` to an allowed output |
| `forge:embedded/timer@0.1` | `sleep-ms` | `(i32 duration) -> i32` | Cooperatively yield for a bounded duration |

The capability handle is assigned by the host after validating the manifest.
For the Blink demo, handle `1` represents the declared GPIO capability.

## Exports

| Name | Core signature | Requirement |
|---|---|---|
| `init` | `() -> i32` | Called once before activation |
| `tick` | `() -> i32` | Called repeatedly by the cooperative scheduler |
| `set-period-ms` | `(i32) -> i32` | Optional development-only configuration hook |

`tick` must return to the host. Components cannot install hardware interrupt
handlers or block a host ISR. A production runtime will enforce an execution
budget with a watchdog or epoch interruption.

## Constants

### GPIO modes

| Value | Mode |
|---:|---|
| 0 | input |
| 1 | output |
| 2 | input-pull-up |

### Error values

| Value | Name |
|---:|---|
| 0 | ok |
| 1 | denied |
| 2 | invalid-argument |
| 3 | out-of-range |
| 4 | unsupported |
| 5 | busy |
| 6 | bad-state |

## Host Validation

Before instantiation, a host must:

1. Validate the manifest against `component-manifest.schema.json`.
2. Verify the SHA-256 digest and byte length of the Wasm artifact.
3. Require the exact ABI version `forge:embedded@0.1`.
4. Reject imports outside the table above.
5. Bind capability handles only after checking declared pins and modes.
6. Enforce the declared memory, stack, and CPU budgets.

The development demo permits an unsigned manifest only when its security mode
is explicitly `development`. Production-mode signature enforcement is a later
stage and must default to rejection until implemented.

