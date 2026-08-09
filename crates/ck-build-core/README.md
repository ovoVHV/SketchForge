# ck-build-core

`ck-build-core` is the Rust implementation boundary for CK Build IR. The
current crate resolves project and Pack inputs, plans the complete CK Action
DAG, emits the same `ck-build-ir` schema v1 as `packages/core`, validates it,
and calculates content-addressed Action keys.

This crate is deliberately independent from GCC, Arduino CLI, host paths,
browser virtual filesystems, and executor implementations. Browser and native
service production planners call the published Rust/WASM artifact; the
TypeScript planner remains a parity oracle and temporary rollback source.

## Current API

- `resolve_project()` creates a deterministic, content-addressed project
  snapshot from source-file DTOs.
- `resolve_target()`, `resolve_platform()`, and `resolve_libraries()` validate
  immutable Pack identities and recursive library dependencies.
- `resolve_platform_manifest()` validates a content-addressed CK Platform
  Manifest and resolves one FQBN, its menu defaults/overrides, Variant, and
  merged Arduino properties.
- `create_action_graph()` validates and canonicalizes an executor-independent
  Action DAG.
- `plan_build_actions()` creates deterministic preprocess, compile, archive,
  link, and transform Actions from project and immutable Pack source DTOs.
- `plan_build_ir()` resolves the same planner input into a fully keyed Build
  IR document.
- `create_build_ir()` composes those stages into CK Build IR v1.
- `calculate_action_keys()` recalculates transitive Action cache keys.
- `map_diagnostics()` maps generated diagnostics back to original sources.
- `migrate_build_ir_json()` parses and normalizes serialized CK Build IR v1.
- `normalize_build_ir()` canonicalizes paths, collections, project hashes,
  and Action keys.
- `validate_build_ir()` validates pack identities, graph dependencies, and
  logical paths.
- `canonical_json()` provides the stable JSON representation shared with the
  TypeScript implementation.
- Feature `wasm` exposes the same stages as camelCase JSON adapters through
  `wasm-bindgen`. Native callers use the typed Rust DTOs directly.

| Native Rust | WASM export |
| --- | --- |
| `resolve_project(ProjectInput)` | `resolveProject(json)` |
| `resolve_target(TargetInput)` | `resolveTarget(json)` |
| `resolve_platform(PlatformPackRef)` | `resolvePlatform(json)` |
| `resolve_platform_manifest(ResolvePlatformManifestInput)` | `resolvePlatformManifest(json)` |
| `resolve_libraries(LibraryResolutionInput)` | `resolveLibraries(json)` |
| `create_action_graph(Vec<BuildAction>)` | `createActionGraph(json)` |
| `create_build_ir(BuildIrInput)` | `createBuildIR(json)` |
| `plan_build_actions(BuildPlannerInput)` | `planBuildActions(json)` |
| `plan_build_ir(BuildPlannerInput)` | `planBuildIR(json)` |
| `calculate_action_keys(&mut BuildIr)` | `calculateActionKeys(json)` |
| `map_diagnostics(diagnostics, map)` | `mapDiagnostics(json)` |

The WASM boundary accepts and returns canonical JSON strings. It does not
expose Rust memory layouts or executor paths, so the schema can be versioned
independently from generated JavaScript bindings. None of these stages looks
up or executes `gcc`, `ar`, `ld`, or `objcopy`.

## Verification

```text
cargo test --manifest-path crates/ck-build-core/Cargo.toml
cargo check --manifest-path crates/ck-build-core/Cargo.toml --features wasm
```

The compatibility tests read a v1 fixture serialized by the TypeScript
implementation and run shared Platform Manifest and comprehensive planner
fixtures through both implementations. They assert byte-for-byte canonical
output and Action-key stability across menu resolution, C, C++, assembly,
sketches, Core/Variant, recursive libraries, archives, linker inputs, and image
transforms.

## Browser WASM build

The browser artifact chain is locked by `wasm-build.lock.json`. On Windows it
uses Rust `1.93.0`, `wasm32-unknown-unknown`, and the official prebuilt
`wasm-bindgen-cli 0.2.126` archive with a pinned SHA-256.

```powershell
pwsh -File crates/ck-build-core/scripts/build-web.ps1
```

The script keeps rustup, Cargo downloads, tools, temporary files, and the
Cargo target directory under `var/ck-build-core-wasm` on the E: workspace. It
does not install the target or compiler cache into the user's C: profile.
Generated browser files are written to `crates/ck-build-core/dist/web`, which
is intentionally ignored and can always be rebuilt.

Every build performs two independent wasm-bindgen passes and requires every
output hash to match. It then loads the generated `--target web` bindings with
Node `initSync`, exercises representative APIs, and writes a deterministic
`build-manifest.json` containing byte sizes and SHA-256 hashes. Custom E: paths
can be supplied with `-VarDir` and `-OutputDir`.

## Migration boundary

The planner, Platform Manifest resolver, and parity gates are complete and in
production behind native/browser adapters. Executors remain outside this crate;
offline Platform Pack construction remains in TypeScript and feeds the same
versioned manifest consumed by Rust.
