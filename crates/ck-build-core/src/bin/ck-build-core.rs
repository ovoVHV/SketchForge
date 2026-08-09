use ck_build_core::{
    calculate_action_keys, canonical_json, create_action_graph, create_build_ir, map_diagnostics,
    migrate_build_ir_json, normalize_build_ir, plan_build_actions, plan_build_ir,
    resolve_libraries, resolve_platform, resolve_platform_manifest, resolve_project,
    resolve_target, BuildAction, BuildIr, BuildIrInput, BuildPlannerInput, DiagnosticMap,
    LibraryResolutionInput, PlatformPackRef, ProjectInput, RawBuildDiagnostic,
    ResolvePlatformManifestInput, TargetInput,
};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::io::{self, Read};

const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapDiagnosticsInput {
    diagnostics: Vec<RawBuildDiagnostic>,
    map: DiagnosticMap,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let operation = arguments
        .next()
        .ok_or_else(|| invalid_input("ck-build-core operation is required"))?;
    if arguments.next().is_some() {
        return Err(invalid_input("ck-build-core accepts exactly one operation").into());
    }

    let mut input = String::new();
    io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_string(&mut input)?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err(invalid_input("ck-build-core input exceeds 256 MiB").into());
    }

    let output = match operation.as_str() {
        "resolve-project" => encode(resolve_project(decode::<ProjectInput>(&input)?)?)?,
        "resolve-target" => encode(resolve_target(decode::<TargetInput>(&input)?)?)?,
        "resolve-platform" => encode(resolve_platform(decode::<PlatformPackRef>(&input)?)?)?,
        "resolve-platform-manifest" => encode(resolve_platform_manifest(decode::<
            ResolvePlatformManifestInput,
        >(&input)?)?)?,
        "resolve-libraries" => encode(resolve_libraries(decode::<LibraryResolutionInput>(
            &input,
        )?)?)?,
        "create-action-graph" => encode(create_action_graph(decode::<Vec<BuildAction>>(&input)?)?)?,
        "create-build-ir" => encode(create_build_ir(decode::<BuildIrInput>(&input)?)?)?,
        "plan-build-actions" => encode(plan_build_actions(decode::<BuildPlannerInput>(&input)?)?)?,
        "plan-build-ir" => encode(plan_build_ir(decode::<BuildPlannerInput>(&input)?)?)?,
        "calculate-action-keys" => {
            let mut ir = decode::<BuildIr>(&input)?;
            calculate_action_keys(&mut ir)?;
            encode(ir)?
        }
        "map-diagnostics" => {
            let value = decode::<MapDiagnosticsInput>(&input)?;
            encode(map_diagnostics(&value.diagnostics, &value.map))?
        }
        "migrate-build-ir" => migrate_build_ir_json(&input)?,
        "validate-build-ir" => {
            let mut ir = decode::<BuildIr>(&input)?;
            normalize_build_ir(&mut ir)?;
            "null".to_owned()
        }
        _ => {
            return Err(
                invalid_input(&format!("unsupported ck-build-core operation: {operation}")).into(),
            )
        }
    };
    print!("{output}");
    Ok(())
}

fn decode<T: for<'de> Deserialize<'de>>(input: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str(input)
}

fn encode<T: Serialize>(value: T) -> Result<String, Box<dyn Error>> {
    let value = serde_json::to_value(value)?;
    Ok(canonical_json(&value)?)
}

fn invalid_input(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
