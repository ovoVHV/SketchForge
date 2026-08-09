use ck_build_core::{
    calculate_action_keys, canonical_json, create_action_graph, create_build_ir, map_diagnostics,
    migrate_build_ir_json, plan_build_ir, resolve_libraries, resolve_platform,
    resolve_platform_manifest, resolve_project, resolve_target, validate_build_ir, BuildAction,
    BuildIr, BuildIrInput, BuildPlannerInput, DiagnosticMap, DiagnosticMapEntry,
    DiagnosticMapInput, DiagnosticSeverity, LibraryDependencyRef, LibraryKind, LibraryPackRef,
    LibraryResolutionInput, ProjectFileInput, ProjectInput, RawBuildDiagnostic,
    ResolvePlatformManifestInput, SourceLanguage, TargetInput, CK_PLATFORM_PACK_SCHEMA_VERSION,
    CK_RECIPE_LOWERING_SCHEMA_VERSION,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

const TYPESCRIPT_V1: &str = include_str!("fixtures/typescript-build-ir-v1.json");
const PLANNER_PARITY_INPUT: &str = include_str!("fixtures/planner-parity-input.json");
const PLATFORM_MANIFEST_INPUT: &str =
    include_str!("fixtures/platform-manifest-resolution-input.json");

fn fixture_ir() -> BuildIr {
    serde_json::from_str(TYPESCRIPT_V1).unwrap()
}

#[test]
fn typescript_v1_fixture_has_byte_for_byte_canonical_parity() {
    let migrated =
        migrate_build_ir_json(TYPESCRIPT_V1).expect("TypeScript v1 fixture must be valid");

    assert_eq!(migrated, TYPESCRIPT_V1.trim());
}

#[test]
fn migration_recalculates_stale_typescript_action_keys() {
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    value["graph"]["actions"][0]["cacheKey"] = Value::String("0".repeat(64));

    let migrated = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap();

    assert_eq!(migrated, TYPESCRIPT_V1.trim());
}

#[test]
fn migration_rewrites_the_explicit_v0_envelope_to_canonical_v1() {
    let current: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    let mut project = current["project"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            json!({
                "name": file["path"],
                "content": file["content"],
                "language": file["language"],
                "generated": file["generated"]
            })
        })
        .collect::<Vec<_>>();
    project.reverse();
    let mut actions = current["graph"]["actions"].as_array().unwrap().clone();
    actions.reverse();
    for action in &mut actions {
        action["cacheKey"] = Value::String("0".repeat(64));
    }
    let legacy = json!({
        "kind": "ck-build-ir",
        "schemaVersion": 0,
        "project": project,
        "target": {
            "board": current["target"]["fqbn"],
            "options": current["target"]["options"]
        },
        "packs": current["packs"],
        "actions": actions,
        "artifacts": current["artifacts"],
        "diagnostics": current["diagnosticMap"]["entries"]
    });

    let migrated = migrate_build_ir_json(&serde_json::to_string(&legacy).unwrap()).unwrap();

    assert_eq!(migrated, TYPESCRIPT_V1.trim());
}

#[test]
fn migration_rejects_future_schema_versions() {
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    value["schemaVersion"] = json!(99);

    let error = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap_err();

    assert!(error.to_string().contains("unsupported schema version 99"));
}

#[test]
fn migration_preserves_compact_pack_artifact_inputs_and_validates_revision() {
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    value["graph"]["actions"][0]["packInputs"] = json!([{
        "kind": "pack-artifact",
        "packId": "espressif-arduino",
        "packRevision": "c".repeat(64),
        "packSchema": 1,
        "artifactId": "compile-000",
        "sha256": "e".repeat(64),
        "role": "compiler-vfs"
    }]);

    let migrated = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap();
    let migrated_value: Value = serde_json::from_str(&migrated).unwrap();
    assert_eq!(
        migrated_value["graph"]["actions"][0]["packInputs"][0]["artifactId"],
        "compile-000"
    );

    value["graph"]["actions"][0]["packInputs"][0]["packRevision"] = Value::String("f".repeat(64));
    let error = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap_err();
    assert!(error
        .to_string()
        .contains("Pack input identity does not match"));
}

#[test]
fn public_action_key_api_normalizes_and_validates_pack_inputs() {
    let parse = |pack_inputs: Value| -> BuildIr {
        let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
        value["graph"]["actions"][0]["packInputs"] = pack_inputs;
        serde_json::from_value(value).unwrap()
    };
    let input = |artifact_id: &str, sha256: &str| {
        json!({
            "kind": "pack-artifact",
            "packId": "espressif-arduino",
            "packRevision": "c".repeat(64),
            "packSchema": 1,
            "artifactId": artifact_id,
            "sha256": sha256,
            "role": "compiler-vfs"
        })
    };

    let first = input("compile-z", &"e".repeat(64));
    let second = input("compile-a", &"f".repeat(64));
    let mut unsorted = parse(json!([first.clone(), second.clone()]));
    calculate_action_keys(&mut unsorted).unwrap();
    let normalized = serde_json::to_value(&unsorted).unwrap();
    assert_eq!(
        normalized["graph"]["actions"][0]["packInputs"][0]["artifactId"],
        "compile-a"
    );

    let mut empty = parse(json!([]));
    calculate_action_keys(&mut empty).unwrap();
    assert!(serde_json::to_value(&empty).unwrap()["graph"]["actions"][0]
        .get("packInputs")
        .is_none());

    let mut decimal_schema = parse(json!([{
        "kind": "pack-artifact",
        "packId": "espressif-arduino",
        "packRevision": "c".repeat(64),
        "packSchema": 1.0,
        "artifactId": "compile-a",
        "sha256": "e".repeat(64)
    }]));
    calculate_action_keys(&mut decimal_schema).unwrap();
    assert_eq!(
        serde_json::to_value(&decimal_schema).unwrap()["graph"]["actions"][0]["packInputs"][0]
            ["packSchema"],
        1
    );

    let mut nul_safe = parse(json!([
        {
            "kind": "pack-artifact",
            "packId": "espressif-arduino",
            "packRevision": "c".repeat(64),
            "packSchema": 1,
            "artifactId": "b",
            "sha256": "e".repeat(64),
            "role": "c\0d"
        },
        {
            "kind": "pack-artifact",
            "packId": "espressif-arduino",
            "packRevision": "c".repeat(64),
            "packSchema": 1,
            "artifactId": "b\0c",
            "sha256": "f".repeat(64),
            "role": "d"
        }
    ]));
    calculate_action_keys(&mut nul_safe).unwrap();
    match &nul_safe.graph.actions[0] {
        BuildAction::Compile { base, .. } => assert_eq!(base.pack_inputs.len(), 2),
        _ => panic!("fixture action must compile"),
    }

    let mut zero_schema = parse(json!([{
        "kind": "pack-artifact",
        "packId": "espressif-arduino",
        "packRevision": "c".repeat(64),
        "packSchema": 0,
        "artifactId": "compile-a",
        "sha256": "e".repeat(64)
    }]));
    assert!(calculate_action_keys(&mut zero_schema)
        .unwrap_err()
        .to_string()
        .contains("schema must be a positive integer"));

    let mut invalid_sha = parse(json!([input("compile-a", "not-a-sha256")]));
    assert!(calculate_action_keys(&mut invalid_sha)
        .unwrap_err()
        .to_string()
        .contains("sha256 must be 64 lowercase hexadecimal characters"));

    let mut duplicate = parse(json!([first.clone(), first]));
    assert!(calculate_action_keys(&mut duplicate)
        .unwrap_err()
        .to_string()
        .contains("duplicate action Pack input"));
}

#[test]
fn action_json_rejects_unknown_fields_fail_closed() {
    let mut top_level: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    top_level["graph"]["actions"][0]["futureFlag"] = json!(true);
    let error = serde_json::from_value::<BuildIr>(top_level).unwrap_err();
    assert!(error
        .to_string()
        .contains("action compile-main contains unknown field futureFlag"));

    let mut nested: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    nested["graph"]["actions"][0]["compileUnit"]["futureFlag"] = json!(true);
    let error = serde_json::from_value::<BuildIr>(nested).unwrap_err();
    assert!(error.to_string().contains("unknown field `futureFlag`"));
}

#[test]
fn board_pack_identity_matches_all_immutable_fields() {
    for field in 0..5 {
        let mut ir = fixture_ir();
        match field {
            0 => ir.target.board_pack.id.push_str("-other"),
            1 => ir.target.board_pack.version = "2.0.0".into(),
            2 => ir.target.board_pack.sha256 = "e".repeat(64),
            3 => {
                ir.target.board_pack.fqbn.push_str("-other");
                ir.target.fqbn = ir.target.board_pack.fqbn.clone();
            }
            4 => {
                ir.target.board_pack.variant.push_str("-other");
                ir.target.variant = ir.target.board_pack.variant.clone();
            }
            _ => unreachable!(),
        }
        assert!(validate_build_ir(&ir)
            .unwrap_err()
            .to_string()
            .contains("target and build pack board references do not match"));
    }
}

#[test]
fn unicode_library_cache_key_matches_typescript_utf16_order() {
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    let non_bmp_id = "lib:\u{10000}";
    let bmp_id = "lib:\u{e000}";
    value["packs"]["libraries"] = json!({
        "roots": [bmp_id, non_bmp_id],
        "packs": [
            {
                "kind": "library", "id": bmp_id, "name": "Bmp", "version": "1.0.0",
                "sha256": "2".repeat(64), "architectures": ["*"],
                "manifest": { "name": "Bmp", "version": "1.0.0" }, "dependencies": []
            },
            {
                "kind": "library", "id": non_bmp_id, "name": "NonBmp", "version": "1.0.0",
                "sha256": "1".repeat(64), "architectures": ["*"],
                "manifest": { "name": "NonBmp", "version": "1.0.0" }, "dependencies": []
            }
        ]
    });
    value["graph"]["actions"][0]["packDependencies"] = json!([bmp_id, non_bmp_id]);

    let normalized = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap();
    let normalized: Value = serde_json::from_str(&normalized).unwrap();

    assert_eq!(
        normalized["packs"]["libraries"]["packs"][0]["id"],
        non_bmp_id
    );
    assert_eq!(
        normalized["graph"]["actions"][0]["cacheKey"],
        "7f90ff290fc8c37e58b6bba789b63610cea6cf41945b6140206b74a7f5d084ff"
    );
}

#[test]
fn action_keys_resolve_fixed_pack_dependencies_and_reject_ambiguous_ids() {
    let normalize = |value: &Value| -> Value {
        let json = migrate_build_ir_json(&serde_json::to_string(value).unwrap()).unwrap();
        serde_json::from_str(&json).unwrap()
    };
    let cache_key = |value: &Value| {
        value["graph"]["actions"][0]["cacheKey"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    value["graph"]["actions"][0]["packDependencies"] = json!([
        value["packs"]["board"]["id"],
        value["packs"]["platform"]["id"],
        value["packs"]["toolchain"]["id"]
    ]);
    let baseline = normalize(&value);

    value["packs"]["board"]["sha256"] = Value::String("e".repeat(64));
    value["target"]["boardPack"]["sha256"] = Value::String("e".repeat(64));
    let changed_board = normalize(&value);
    assert_ne!(cache_key(&baseline), cache_key(&changed_board));

    let mut unknown: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    unknown["graph"]["actions"][0]["packDependencies"] = json!(["pack:missing"]);
    let error = migrate_build_ir_json(&serde_json::to_string(&unknown).unwrap()).unwrap_err();
    assert!(error
        .to_string()
        .contains("references missing pack dependency pack:missing"));

    let mut duplicate: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    duplicate["packs"]["platform"]["id"] = duplicate["packs"]["board"]["id"].clone();
    let error = migrate_build_ir_json(&serde_json::to_string(&duplicate).unwrap()).unwrap_err();
    assert!(error
        .to_string()
        .contains("ambiguous Pack id esp32-c3-devkit: used by platform and board"));

    let mut library_collision: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    library_collision["packs"]["libraries"]["packs"][0]["id"] =
        library_collision["packs"]["board"]["id"].clone();
    library_collision["packs"]["libraries"]["roots"][0] =
        library_collision["packs"]["board"]["id"].clone();
    let error =
        migrate_build_ir_json(&serde_json::to_string(&library_collision).unwrap()).unwrap_err();
    assert!(error
        .to_string()
        .contains("ambiguous Pack id esp32-c3-devkit: used by board and library"));
}

#[test]
fn action_keys_keep_transitive_library_pack_identities() {
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    value["packs"]["libraries"]["packs"][0]["dependencies"] = json!([{
        "id": "lib:leaf",
        "version": "1.0.0",
        "sha256": "1".repeat(64)
    }]);
    value["packs"]["libraries"]["packs"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "kind": "library",
            "id": "lib:leaf",
            "version": "1.0.0",
            "sha256": "1".repeat(64),
            "name": "Leaf",
            "architectures": ["*"],
            "manifest": { "name": "Leaf", "version": "1.0.0" },
            "dependencies": []
        }));
    let baseline = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap();
    let baseline: Value = serde_json::from_str(&baseline).unwrap();

    value["packs"]["libraries"]["packs"][0]["dependencies"][0]["sha256"] =
        Value::String("2".repeat(64));
    value["packs"]["libraries"]["packs"][1]["sha256"] = Value::String("2".repeat(64));
    let changed = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap();
    let changed: Value = serde_json::from_str(&changed).unwrap();

    assert_ne!(
        baseline["graph"]["actions"][0]["cacheKey"],
        changed["graph"]["actions"][0]["cacheKey"]
    );
}

#[test]
fn public_resolution_stages_compose_to_the_typescript_fixture() {
    let baseline = fixture_ir();
    let input = BuildIrInput {
        project: ProjectInput::Snapshot(baseline.project.clone()),
        target: TargetInput {
            fqbn: baseline.target.fqbn.clone(),
            options: baseline.target.options.clone(),
            board_pack: baseline.target.board_pack.clone(),
        },
        packs: baseline.packs.clone(),
        actions: baseline.graph.actions.clone(),
        artifacts: baseline.artifacts.clone(),
        diagnostic_map: DiagnosticMapInput::Map(baseline.diagnostic_map.clone()),
    };

    let created = create_build_ir(input).unwrap();
    let serialized = canonical_json(&serde_json::to_value(created).unwrap()).unwrap();

    assert_eq!(serialized, TYPESCRIPT_V1.trim());
}

#[test]
fn resolve_project_infers_languages_and_normalizes_paths() {
    let project = resolve_project(ProjectInput::Files(vec![
        ProjectFileInput {
            path: "src\\pins.S".into(),
            content: "nop".into(),
            language: None,
            generated: Some(true),
        },
        ProjectFileInput {
            path: "./main.ino".into(),
            content: "void setup() {}".into(),
            language: None,
            generated: None,
        },
    ]))
    .unwrap();

    assert_eq!(project.files[0].path, "main.ino");
    assert_eq!(project.files[0].language, SourceLanguage::Ino);
    assert_eq!(project.files[1].path, "src/pins.S");
    assert_eq!(project.files[1].language, SourceLanguage::Asm);
    assert!(project.files[1].generated);
}

#[test]
fn resolve_project_rejects_case_folded_duplicates_and_uses_utf16_order() {
    let duplicate = resolve_project(ProjectInput::Files(vec![
        ProjectFileInput {
            path: "main.ino".into(),
            content: "void setup() {}".into(),
            language: None,
            generated: None,
        },
        ProjectFileInput {
            path: "MAIN.ino".into(),
            content: "void loop() {}".into(),
            language: None,
            generated: None,
        },
    ]));
    assert!(duplicate
        .unwrap_err()
        .to_string()
        .contains("duplicate project file"));

    let project = resolve_project(ProjectInput::Files(vec![
        ProjectFileInput {
            path: "\u{e000}.cpp".into(),
            content: "int bmp;".into(),
            language: None,
            generated: None,
        },
        ProjectFileInput {
            path: "\u{1f600}.cpp".into(),
            content: "int non_bmp;".into(),
            language: None,
            generated: None,
        },
    ]))
    .unwrap();
    assert_eq!(project.files[0].path, "\u{1f600}.cpp");
    assert_eq!(project.files[1].path, "\u{e000}.cpp");
}

#[test]
fn target_and_platform_resolution_validate_pack_identity() {
    let baseline = fixture_ir();
    let target = resolve_target(TargetInput {
        fqbn: baseline.target.fqbn.clone(),
        options: BTreeMap::new(),
        board_pack: baseline.target.board_pack.clone(),
    })
    .unwrap();
    assert_eq!(target.variant, "esp32c3");
    assert_eq!(
        resolve_platform(baseline.packs.platform.clone()).unwrap(),
        baseline.packs.platform
    );

    let mismatch = resolve_target(TargetInput {
        fqbn: "arduino:avr:uno".into(),
        options: BTreeMap::new(),
        board_pack: baseline.target.board_pack,
    })
    .unwrap_err();
    assert!(mismatch.to_string().contains("does not match"));
}

#[test]
fn library_resolution_checks_recursive_content_identity() {
    let leaf = LibraryPackRef {
        kind: LibraryKind::Library,
        id: "lib:leaf".into(),
        version: "1.0.0".into(),
        sha256: "1".repeat(64),
        name: "Leaf".into(),
        architectures: vec!["*".into()],
        license: None,
        manifest: BTreeMap::new(),
        dependencies: vec![],
    };
    let root = LibraryPackRef {
        kind: LibraryKind::Library,
        id: "lib:root".into(),
        version: "1.0.0".into(),
        sha256: "2".repeat(64),
        name: "Root".into(),
        architectures: vec!["*".into()],
        license: None,
        manifest: BTreeMap::new(),
        dependencies: vec![LibraryDependencyRef {
            id: leaf.id.clone(),
            version: leaf.version.clone(),
            sha256: leaf.sha256.clone(),
        }],
    };
    let resolved = resolve_libraries(LibraryResolutionInput {
        roots: Some(vec![root.id.clone()]),
        packs: vec![root.clone(), leaf.clone()],
    })
    .unwrap();
    assert_eq!(resolved.roots, vec!["lib:root"]);
    assert_eq!(resolved.packs[0].id, "lib:leaf");

    let error = resolve_libraries(LibraryResolutionInput {
        roots: Some(vec![root.id.clone()]),
        packs: vec![root],
    })
    .unwrap_err();
    assert!(error.to_string().contains("missing dependency lib:leaf"));
}

#[test]
fn library_resolution_rejects_ambiguous_logical_revisions() {
    let first = LibraryPackRef {
        kind: LibraryKind::Library,
        id: "lib:demo-first".into(),
        version: "1.0.0".into(),
        sha256: "1".repeat(64),
        name: "Demo".into(),
        architectures: vec!["*".into()],
        license: None,
        manifest: BTreeMap::new(),
        dependencies: vec![],
    };
    let second = LibraryPackRef {
        id: "lib:demo-second".into(),
        sha256: "2".repeat(64),
        ..first.clone()
    };

    let error = resolve_libraries(LibraryResolutionInput {
        roots: Some(vec![first.id.clone(), second.id.clone()]),
        packs: vec![first, second],
    })
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("ambiguous library pack Demo@1.0.0: multiple revisions"));
}

#[test]
fn action_graph_and_key_stages_are_independently_callable() {
    let mut ir = fixture_ir();
    let expected = ir.graph.actions[0].clone();
    let graph = create_action_graph(vec![expected]).unwrap();
    assert_eq!(graph.actions.len(), 1);

    match &mut ir.graph.actions[0] {
        BuildAction::Compile { base, .. } => base.cache_key = "0".repeat(64),
        _ => panic!("fixture action must compile"),
    }
    calculate_action_keys(&mut ir).unwrap();
    match &ir.graph.actions[0] {
        BuildAction::Compile { base, .. } => {
            assert_eq!(
                base.cache_key,
                "9eb4eb21e7d44f4b88c1d1da8235b720aab4770dbec905cd5a0b5141e3a9e94d"
            );
        }
        _ => panic!("fixture action must compile"),
    }

    let mut cyclic = ir.graph.actions[0].clone();
    match &mut cyclic {
        BuildAction::Compile { base, .. } => base.dependencies = vec![base.id.clone()],
        _ => panic!("fixture action must compile"),
    }
    assert!(create_action_graph(vec![cyclic])
        .unwrap_err()
        .to_string()
        .contains("depends on itself"));
}

#[test]
fn malformed_action_graph_is_rejected_before_execution() {
    let mut value: Value = serde_json::from_str(TYPESCRIPT_V1).unwrap();
    value["graph"]["actions"][0]["dependencies"] = json!(["compile-main"]);

    let error = migrate_build_ir_json(&serde_json::to_string(&value).unwrap()).unwrap_err();

    assert!(error.to_string().contains("depends on itself"));
}

#[test]
fn canonical_json_sorts_nested_object_keys() {
    assert_eq!(
        canonical_json(&json!({ "b": 2, "a": { "z": true, "y": null }, "list": [3, 1] })).unwrap(),
        r#"{"a":{"y":null,"z":true},"b":2,"list":[3,1]}"#,
    );
}

#[test]
fn diagnostics_map_back_to_the_original_source() {
    let mapped = map_diagnostics(
        &[RawBuildDiagnostic {
            severity: DiagnosticSeverity::Error,
            file: "generated.cpp".into(),
            line: 4,
            column: Some(2),
            message: "bad".into(),
            raw: None,
        }],
        &DiagnosticMap {
            entries: vec![DiagnosticMapEntry {
                generated_file: "generated.cpp".into(),
                generated_line: 4,
                generated_column: None,
                source_file: "main.ino".into(),
                source_line: 2,
                source_column: None,
            }],
        },
    );

    assert_eq!(mapped[0].source_file, "main.ino");
    assert_eq!(mapped[0].source_line, 2);
    assert_eq!(mapped[0].diagnostic.file, "main.ino");
    assert_eq!(mapped[0].diagnostic.line, 2);
    assert_eq!(mapped[0].generated_file.as_deref(), Some("generated.cpp"));
    assert_eq!(mapped[0].generated_line, Some(4));
    assert_eq!(mapped[0].generated_column, Some(2));
    assert!(mapped[0].from_generated);
}

#[test]
fn rust_planner_has_canonical_parity_with_the_typescript_production_planner() {
    let input: BuildPlannerInput = serde_json::from_str(PLANNER_PARITY_INPUT).unwrap();
    let rust_ir = plan_build_ir(input).expect("Rust planner must accept the shared fixture");
    let rust_json = canonical_json(&serde_json::to_value(rust_ir).unwrap()).unwrap();

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..").canonicalize().unwrap();
    let input_path = manifest_dir.join("tests/fixtures/planner-parity-input.json");
    let runner_path = manifest_dir.join("tests/fixtures/run-typescript-planner.mjs");
    let output = Command::new("node")
        .arg(runner_path)
        .arg(input_path)
        .current_dir(repo_root)
        .output()
        .expect("Node must run the TypeScript production planner fixture");
    assert!(
        output.status.success(),
        "TypeScript planner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let typescript_json = String::from_utf8(output.stdout).unwrap();

    if rust_json != typescript_json {
        let index = rust_json
            .bytes()
            .zip(typescript_json.bytes())
            .position(|(left, right)| left != right)
            .unwrap_or_else(|| rust_json.len().min(typescript_json.len()));
        let start = index.saturating_sub(160);
        let rust_end = (index + 320).min(rust_json.len());
        let typescript_end = (index + 320).min(typescript_json.len());
        panic!(
            "planner mismatch at byte {index}\nRust: {}\nTypeScript: {}",
            &rust_json[start..rust_end],
            &typescript_json[start..typescript_end],
        );
    }
}

#[test]
fn platform_manifest_resolution_has_typescript_parity() {
    let input: ResolvePlatformManifestInput =
        serde_json::from_str(PLATFORM_MANIFEST_INPUT).unwrap();
    assert_eq!(
        input.manifest.schema_version,
        CK_PLATFORM_PACK_SCHEMA_VERSION
    );
    assert_eq!(input.manifest.recipes.len(), 5);
    assert_eq!(
        input.manifest.recipe_lowering.schema_version,
        CK_RECIPE_LOWERING_SCHEMA_VERSION
    );
    assert_eq!(
        input.manifest.recipe_lowering.sha256,
        "e87b3e0dad526a331f7ce5808d060db5e7e8829f2c12f6cc1d1111199bfd4559"
    );
    assert_eq!(
        input.manifest.sha256,
        "7454d87ed52269241177303df422447d1a23b6e5f438e235b8ca6ade065c9dd4"
    );
    let resolved =
        resolve_platform_manifest(input).expect("Rust must resolve the Platform Manifest");
    assert_eq!(resolved.resolved_recipes.len(), 5);
    assert_eq!(
        resolved.recipe_lowering.sha256,
        "e87b3e0dad526a331f7ce5808d060db5e7e8829f2c12f6cc1d1111199bfd4559"
    );
    let rust_json = canonical_json(&serde_json::to_value(resolved).unwrap()).unwrap();

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..").canonicalize().unwrap();
    let input_path = manifest_dir.join("tests/fixtures/platform-manifest-resolution-input.json");
    let runner_path = manifest_dir.join("tests/fixtures/run-typescript-platform-manifest.mjs");
    let output = Command::new("node")
        .arg(runner_path)
        .arg(input_path)
        .current_dir(repo_root)
        .output()
        .expect("Node must run the TypeScript Platform Manifest fixture");
    assert!(
        output.status.success(),
        "TypeScript Platform Manifest resolver failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(rust_json, String::from_utf8(output.stdout).unwrap());
}

#[test]
fn platform_manifest_schema_v1_is_rejected_by_public_resolver() {
    let mut input: ResolvePlatformManifestInput =
        serde_json::from_str(PLATFORM_MANIFEST_INPUT).unwrap();
    input.manifest.schema_version = 1;

    let error = resolve_platform_manifest(input).unwrap_err();
    assert!(error
        .to_string()
        .contains("unsupported platform manifest schema 1"));
}
