//! Execution-independent CK Build IR v1 normalization and validation.

use serde::de::Error as SerdeDeError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

mod planner;
mod platform_manifest;

pub use planner::{
    plan_build_actions, plan_build_ir, BuildActionPlan, BuildPlannerInput, PlannerCompilerFlags,
    PlannerLibraryInput, PlannerPlatformInput, PlannerResourceLimits, PlannerSourceTree,
    PlannerToolNames, PlannerTransformInput, PlannerTransformSpec,
};
pub use platform_manifest::{
    resolve_platform_manifest, PlatformArchiveLowering, PlatformBoard, PlatformCompatibility,
    PlatformCompileRecipeBindings, PlatformCompilerCompatibility, PlatformCompilerRuntimeInclude,
    PlatformFileEntry, PlatformFileRole, PlatformLanguageResponseFiles,
    PlatformLinkerCompatibility, PlatformLogicalPathLayout, PlatformManifest, PlatformMenu,
    PlatformMenuOption, PlatformProgrammer, PlatformPublicationLowering, PlatformRecipe,
    PlatformRecipeBindings, PlatformRecipeLowering, PlatformRecipePaths, PlatformResponseFileRoles,
    PlatformResponseFiles, PlatformToolRequirement, ResolvePlatformManifestInput,
    ResolvedPlatformManifest, CK_PLATFORM_PACK_KIND, CK_PLATFORM_PACK_SCHEMA_VERSION,
    CK_RECIPE_LOWERING_SCHEMA_VERSION,
};

pub const CK_BUILD_IR_KIND: &str = "ck-build-ir";
pub const CK_BUILD_IR_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub enum BuildIrError {
    Json(serde_json::Error),
    Validation(String),
}

impl Display for BuildIrError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => Display::fmt(error, formatter),
            Self::Validation(message) => formatter.write_str(message),
        }
    }
}

impl Error for BuildIrError {}

impl From<serde_json::Error> for BuildIrError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub type BuildIrResult<T> = std::result::Result<T, BuildIrError>;
type Result<T> = BuildIrResult<T>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIr {
    pub kind: String,
    pub schema_version: u32,
    pub project: ProjectSnapshot,
    pub target: TargetSpec,
    pub packs: BuildPacks,
    pub graph: ActionGraph,
    pub artifacts: Vec<BuildArtifact>,
    pub diagnostic_map: DiagnosticMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub files: Vec<ProjectFile>,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub content: String,
    pub language: SourceLanguage,
    pub generated: bool,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProjectFileInput {
    pub path: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<SourceLanguage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProjectInput {
    Snapshot(ProjectSnapshot),
    Files(Vec<ProjectFileInput>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceLanguage {
    #[serde(rename = "ino")]
    Ino,
    #[serde(rename = "c")]
    C,
    #[serde(rename = "c++")]
    Cpp,
    #[serde(rename = "asm")]
    Asm,
    #[serde(rename = "header")]
    Header,
    #[serde(rename = "other")]
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSpec {
    pub fqbn: String,
    pub options: BTreeMap<String, String>,
    pub board_pack: BoardPackRef,
    pub variant: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInput {
    pub fqbn: String,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    pub board_pack: BoardPackRef,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainPackRef {
    pub kind: ToolchainKind,
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub abi: String,
    pub instruction_set: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolchainKind {
    #[serde(rename = "toolchain")]
    Toolchain,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlatformPackRef {
    pub kind: PlatformKind,
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub platform: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlatformKind {
    #[serde(rename = "platform")]
    Platform,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BoardPackRef {
    pub kind: BoardKind,
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub fqbn: String,
    pub variant: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoardKind {
    #[serde(rename = "board")]
    Board,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LibraryDependencyRef {
    pub id: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LibraryPackRef {
    pub kind: LibraryKind,
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub name: String,
    pub architectures: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub manifest: BTreeMap<String, String>,
    pub dependencies: Vec<LibraryDependencyRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LibraryKind {
    #[serde(rename = "library")]
    Library,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LibraryPackSet {
    pub roots: Vec<String>,
    pub packs: Vec<LibraryPackRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LibraryResolutionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<String>>,
    pub packs: Vec<LibraryPackRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildPacks {
    pub toolchain: ToolchainPackRef,
    pub platform: PlatformPackRef,
    pub board: BoardPackRef,
    pub libraries: LibraryPackSet,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DiagnosticMapInput {
    Map(DiagnosticMap),
    Entries(Vec<DiagnosticMapEntry>),
}

impl Default for DiagnosticMapInput {
    fn default() -> Self {
        Self::Entries(Vec::new())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIrInput {
    pub project: ProjectInput,
    pub target: TargetInput,
    pub packs: BuildPacks,
    pub actions: Vec<BuildAction>,
    #[serde(default)]
    pub artifacts: Vec<BuildArtifact>,
    #[serde(default)]
    pub diagnostic_map: DiagnosticMapInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyBuildIrV0 {
    kind: String,
    schema_version: u32,
    project: Vec<LegacyProjectFileV0>,
    target: LegacyTargetV0,
    packs: BuildPacks,
    actions: Vec<BuildAction>,
    #[serde(default)]
    artifacts: Vec<BuildArtifact>,
    #[serde(default)]
    diagnostics: Vec<DiagnosticMapEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyProjectFileV0 {
    name: String,
    content: String,
    #[serde(default)]
    language: Option<SourceLanguage>,
    #[serde(default)]
    generated: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyTargetV0 {
    board: String,
    #[serde(default)]
    options: BTreeMap<String, String>,
    #[serde(default)]
    board_pack: Option<BoardPackRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActionGraph {
    pub actions: Vec<BuildAction>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BuildAction {
    Compile {
        #[serde(flatten)]
        base: ActionBase,
        #[serde(rename = "compileUnit")]
        compile_unit: CompileUnit,
    },
    Archive {
        #[serde(flatten)]
        base: ActionBase,
        archive: ArchiveSpec,
    },
    Link {
        #[serde(flatten)]
        base: ActionBase,
        link: LinkSpec,
    },
    Transform {
        #[serde(flatten)]
        base: ActionBase,
        transform: TransformSpec,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum BuildActionWire {
    Compile {
        #[serde(flatten)]
        base: ActionBase,
        #[serde(rename = "compileUnit")]
        compile_unit: CompileUnit,
    },
    Archive {
        #[serde(flatten)]
        base: ActionBase,
        archive: ArchiveSpec,
    },
    Link {
        #[serde(flatten)]
        base: ActionBase,
        link: LinkSpec,
    },
    Transform {
        #[serde(flatten)]
        base: ActionBase,
        transform: TransformSpec,
    },
}

impl<'de> Deserialize<'de> for BuildAction {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        validate_action_json_fields(&value).map_err(D::Error::custom)?;
        let action = serde_json::from_value::<BuildActionWire>(value).map_err(D::Error::custom)?;
        Ok(match action {
            BuildActionWire::Compile { base, compile_unit } => Self::Compile { base, compile_unit },
            BuildActionWire::Archive { base, archive } => Self::Archive { base, archive },
            BuildActionWire::Link { base, link } => Self::Link { base, link },
            BuildActionWire::Transform { base, transform } => Self::Transform { base, transform },
        })
    }
}

fn validate_action_json_fields(value: &Value) -> std::result::Result<(), String> {
    const BASE_FIELDS: &[&str] = &[
        "id",
        "kind",
        "tool",
        "inputs",
        "outputs",
        "arguments",
        "environment",
        "dependencies",
        "packDependencies",
        "packInputs",
        "resourceLimits",
        "cacheKey",
    ];

    let action = value
        .as_object()
        .ok_or_else(|| "Action must be a JSON object".to_owned())?;
    let kind = action
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Action kind must be a string".to_owned())?;
    let variant_field = match kind {
        "compile" => "compileUnit",
        "archive" => "archive",
        "link" => "link",
        "transform" => "transform",
        _ => return Err(format!("unsupported Action kind {kind}")),
    };
    let action_id = action
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("<unknown>");
    for field in action.keys() {
        if !BASE_FIELDS.contains(&field.as_str()) && field != variant_field {
            return Err(format!("action {action_id} contains unknown field {field}"));
        }
    }
    Ok(())
}

impl BuildAction {
    fn base(&self) -> &ActionBase {
        match self {
            Self::Compile { base, .. }
            | Self::Archive { base, .. }
            | Self::Link { base, .. }
            | Self::Transform { base, .. } => base,
        }
    }

    fn base_mut(&mut self) -> &mut ActionBase {
        match self {
            Self::Compile { base, .. }
            | Self::Archive { base, .. }
            | Self::Link { base, .. }
            | Self::Transform { base, .. } => base,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionBase {
    pub id: String,
    pub tool: String,
    pub inputs: Vec<ActionInput>,
    pub outputs: Vec<ActionOutput>,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub dependencies: Vec<String>,
    pub pack_dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pack_inputs: Vec<ActionPackInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_limits: Option<ActionResourceLimits>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cache_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionPackInputKind {
    #[serde(rename = "pack-artifact")]
    PackArtifact,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionPackInput {
    pub kind: ActionPackInputKind,
    pub pack_id: String,
    pub pack_revision: String,
    #[serde(deserialize_with = "deserialize_u32_integer")]
    pub pack_schema: u32,
    pub artifact_id: String,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

fn deserialize_u32_integer<'de, D>(deserializer: D) -> std::result::Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let number = value
        .as_number()
        .ok_or_else(|| D::Error::custom("expected a 32-bit unsigned integer"))?;
    if let Some(integer) = number.as_u64() {
        return u32::try_from(integer)
            .map_err(|_| D::Error::custom("expected a 32-bit unsigned integer"));
    }
    if let Some(float) = number.as_f64() {
        if float.is_finite() && float.fract() == 0.0 && float >= 0.0 && float <= u32::MAX as f64 {
            return Ok(float as u32);
        }
    }
    Err(D::Error::custom("expected a 32-bit unsigned integer"))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionInput {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionOutput {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionResourceLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileUnit {
    pub language: CompileLanguage,
    pub source: String,
    pub output: String,
    pub macros: BTreeMap<String, MacroValue>,
    pub include_paths: Vec<String>,
    pub flags: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompileLanguage {
    #[serde(rename = "c")]
    C,
    #[serde(rename = "c++")]
    Cpp,
    #[serde(rename = "asm")]
    Asm,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MacroValue {
    String(String),
    Boolean(bool),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveSpec {
    pub objects: Vec<String>,
    pub output: String,
    pub flags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkSpec {
    pub objects: Vec<String>,
    pub archives: Vec<String>,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linker_script: Option<String>,
    pub flags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransformSpec {
    pub input: String,
    pub output: String,
    pub format: TransformFormat,
    pub flags: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransformFormat {
    #[serde(rename = "elf")]
    Elf,
    #[serde(rename = "bin")]
    Bin,
    #[serde(rename = "hex")]
    Hex,
    #[serde(rename = "bootloader")]
    Bootloader,
    #[serde(rename = "partition")]
    Partition,
    #[serde(rename = "boot-app0")]
    BootApp0,
    #[serde(rename = "other")]
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildArtifact {
    pub path: String,
    pub format: TransformFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticMap {
    pub entries: Vec<DiagnosticMapEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticMapEntry {
    pub generated_file: String,
    pub generated_line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_column: Option<u64>,
    pub source_file: String,
    pub source_line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_column: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBuildDiagnostic {
    pub severity: DiagnosticSeverity,
    pub file: String,
    pub line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedBuildDiagnostic {
    #[serde(flatten)]
    pub diagnostic: RawBuildDiagnostic,
    pub source_file: String,
    pub source_line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_column: Option<u64>,
    pub from_generated: bool,
}

/// Resolve a project snapshot without consulting an executor or host filesystem.
pub fn resolve_project(input: ProjectInput) -> Result<ProjectSnapshot> {
    let inputs = match input {
        ProjectInput::Files(files) => files,
        ProjectInput::Snapshot(snapshot) => snapshot
            .files
            .into_iter()
            .map(|file| ProjectFileInput {
                path: file.path,
                content: file.content,
                language: Some(file.language),
                generated: Some(file.generated),
            })
            .collect(),
    };
    let mut files = inputs
        .into_iter()
        .map(|file| {
            let path = normalize_path(&file.path, "project file")?;
            let language = file.language.unwrap_or_else(|| infer_language(&path));
            Ok(ProjectFile {
                path,
                sha256: sha256_hex(file.content.as_bytes()),
                size: file.content.len() as u64,
                content: file.content,
                language,
                generated: file.generated.unwrap_or(false),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    files.sort_by(|left, right| compare_code_units(&left.path, &right.path));
    ensure_unique_case_folded(files.iter().map(|file| file.path.as_str()), "project file")?;
    let identity = Value::Array(
        files
            .iter()
            .map(|file| {
                serde_json::json!({
                    "path": file.path,
                    "content": file.content,
                    "language": file.language,
                    "generated": file.generated,
                })
            })
            .collect(),
    );
    Ok(ProjectSnapshot {
        files,
        sha256: sha256_hex(canonical_json(&identity)?.as_bytes()),
    })
}

/// Resolve FQBN options and bind them to one immutable Board Pack.
pub fn resolve_target(input: TargetInput) -> Result<TargetSpec> {
    validate_pack_ref(
        &input.board_pack.id,
        &input.board_pack.version,
        &input.board_pack.sha256,
        "board pack",
    )?;
    if input.fqbn.trim().is_empty() {
        return validation("target fqbn must not be empty");
    }
    if input.board_pack.fqbn != input.fqbn {
        return validation(format!(
            "target fqbn {} does not match board pack fqbn {}",
            input.fqbn, input.board_pack.fqbn
        ));
    }
    if input.board_pack.variant.trim().is_empty() {
        return validation("board pack variant must not be empty");
    }
    Ok(TargetSpec {
        fqbn: input.fqbn,
        options: input.options,
        variant: input.board_pack.variant.clone(),
        board_pack: input.board_pack,
    })
}

/// Validate and resolve an immutable Platform/Core Pack reference.
pub fn resolve_platform(input: PlatformPackRef) -> Result<PlatformPackRef> {
    validate_pack_ref(&input.id, &input.version, &input.sha256, "platform pack")?;
    if input.platform.trim().is_empty() {
        return validation("platform pack platform must not be empty");
    }
    Ok(input)
}

/// Resolve library roots and recursive dependency identities into deterministic order.
pub fn resolve_libraries(input: LibraryResolutionInput) -> Result<LibraryPackSet> {
    let roots = input
        .roots
        .unwrap_or_else(|| input.packs.iter().map(|pack| pack.id.clone()).collect());
    let mut libraries = LibraryPackSet {
        roots,
        packs: input.packs,
    };
    normalize_libraries(&mut libraries)?;
    Ok(libraries)
}

/// Normalize and validate an executor-independent Action DAG.
pub fn create_action_graph(mut actions: Vec<BuildAction>) -> Result<ActionGraph> {
    normalize_actions(&mut actions)?;
    validate_action_dependencies(&actions)?;
    Ok(ActionGraph { actions })
}

/// Compose all resolution stages into a complete, content-addressed Build IR.
pub fn create_build_ir(input: BuildIrInput) -> Result<BuildIr> {
    let project = resolve_project(input.project)?;
    let target = resolve_target(input.target)?;
    let BuildPacks {
        toolchain,
        platform,
        board,
        libraries,
    } = input.packs;
    validate_pack_ref(
        &toolchain.id,
        &toolchain.version,
        &toolchain.sha256,
        "toolchain pack",
    )?;
    if toolchain.abi.trim().is_empty() || toolchain.instruction_set.trim().is_empty() {
        return validation("toolchain pack abi and instructionSet must not be empty");
    }
    validate_pack_ref(&board.id, &board.version, &board.sha256, "board pack")?;
    let platform = resolve_platform(platform)?;
    let libraries = resolve_libraries(LibraryResolutionInput {
        roots: Some(libraries.roots),
        packs: libraries.packs,
    })?;
    if board != target.board_pack {
        return validation("target and build pack board references do not match");
    }
    let graph = create_action_graph(input.actions)?;
    let diagnostic_map = match input.diagnostic_map {
        DiagnosticMapInput::Map(map) => map,
        DiagnosticMapInput::Entries(entries) => DiagnosticMap { entries },
    };
    let mut ir = BuildIr {
        kind: CK_BUILD_IR_KIND.to_owned(),
        schema_version: CK_BUILD_IR_SCHEMA_VERSION,
        project,
        target,
        packs: BuildPacks {
            toolchain,
            platform,
            board,
            libraries,
        },
        graph,
        artifacts: input.artifacts,
        diagnostic_map,
    };
    normalize_build_ir(&mut ir)?;
    Ok(ir)
}

/// Parse untrusted v0/v1 JSON, migrate it, and return canonical v1 JSON.
pub fn migrate_build_ir_json(input: &str) -> Result<String> {
    let value: Value = serde_json::from_str(input)?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind != CK_BUILD_IR_KIND {
        return validation(format!("expected {CK_BUILD_IR_KIND}"));
    }
    let version = value.get("schemaVersion").and_then(Value::as_u64);
    let mut ir = match version {
        Some(0) => migrate_build_ir_v0(serde_json::from_value(value)?),
        Some(version) if version == CK_BUILD_IR_SCHEMA_VERSION as u64 => {
            Ok(serde_json::from_value(value)?)
        }
        _ => {
            return validation(format!(
                "unsupported schema version {}",
                version.map_or_else(|| "missing".to_owned(), |value| value.to_string())
            ))
        }
    }?;
    normalize_build_ir(&mut ir)?;
    canonical_json(&serde_json::to_value(ir)?)
}

fn migrate_build_ir_v0(value: LegacyBuildIrV0) -> Result<BuildIr> {
    if value.kind != CK_BUILD_IR_KIND || value.schema_version != 0 {
        return validation("invalid Build IR v0 envelope");
    }
    let board_pack = value
        .target
        .board_pack
        .unwrap_or_else(|| value.packs.board.clone());
    create_build_ir(BuildIrInput {
        project: ProjectInput::Files(
            value
                .project
                .into_iter()
                .map(|file| ProjectFileInput {
                    path: file.name,
                    content: file.content,
                    language: file.language,
                    generated: file.generated,
                })
                .collect(),
        ),
        target: TargetInput {
            fqbn: value.target.board,
            options: value.target.options,
            board_pack,
        },
        packs: value.packs,
        actions: value.actions,
        artifacts: value.artifacts,
        diagnostic_map: DiagnosticMapInput::Entries(value.diagnostics),
    })
}

/// Normalize the same serialized structures and Action keys as the TypeScript v1 builder.
pub fn normalize_build_ir(ir: &mut BuildIr) -> Result<()> {
    validate_envelope(ir)?;
    ir.project = resolve_project(ProjectInput::Snapshot(ir.project.clone()))?;
    ir.target = resolve_target(TargetInput {
        fqbn: ir.target.fqbn.clone(),
        options: ir.target.options.clone(),
        board_pack: ir.target.board_pack.clone(),
    })?;
    ir.packs.platform = resolve_platform(ir.packs.platform.clone())?;
    ir.packs.libraries = resolve_libraries(LibraryResolutionInput {
        roots: Some(ir.packs.libraries.roots.clone()),
        packs: ir.packs.libraries.packs.clone(),
    })?;
    ir.graph = create_action_graph(ir.graph.actions.clone())?;
    for artifact in &mut ir.artifacts {
        artifact.path = normalize_path(&artifact.path, "artifact")?;
    }
    ir.artifacts
        .sort_by(|left, right| compare_code_units(&left.path, &right.path));
    ir.diagnostic_map.entries.sort_by(|left, right| {
        compare_code_units(&left.generated_file, &right.generated_file)
            .then(left.generated_line.cmp(&right.generated_line))
            .then(
                optional_number_key(left.generated_column)
                    .cmp(&optional_number_key(right.generated_column)),
            )
            .then(compare_code_units(&left.source_file, &right.source_file))
            .then(left.source_line.cmp(&right.source_line))
    });

    calculate_action_keys(ir)?;
    validate_build_ir(ir)
}

/// Validate a normalized Build IR without invoking an executor.
pub fn validate_build_ir(ir: &BuildIr) -> Result<()> {
    validate_envelope(ir)?;
    validate_pack_ref(
        &ir.packs.toolchain.id,
        &ir.packs.toolchain.version,
        &ir.packs.toolchain.sha256,
        "toolchain pack",
    )?;
    validate_pack_ref(
        &ir.packs.platform.id,
        &ir.packs.platform.version,
        &ir.packs.platform.sha256,
        "platform pack",
    )?;
    validate_pack_ref(
        &ir.packs.board.id,
        &ir.packs.board.version,
        &ir.packs.board.sha256,
        "board pack",
    )?;
    validate_pack_ref(
        &ir.target.board_pack.id,
        &ir.target.board_pack.version,
        &ir.target.board_pack.sha256,
        "target board pack",
    )?;
    if ir.target.fqbn.trim().is_empty() || ir.target.variant.trim().is_empty() {
        return validation("target fqbn and variant must not be empty");
    }
    if ir.target.fqbn != ir.target.board_pack.fqbn
        || ir.target.variant != ir.target.board_pack.variant
        || ir.target.board_pack != ir.packs.board
    {
        return validation("target and build pack board references do not match");
    }
    if ir.packs.toolchain.abi.trim().is_empty()
        || ir.packs.toolchain.instruction_set.trim().is_empty()
    {
        return validation("toolchain pack abi and instructionSet must not be empty");
    }
    if ir.packs.platform.platform.trim().is_empty() {
        return validation("platform pack platform must not be empty");
    }
    validate_libraries(&ir.packs.libraries)?;
    validate_action_graph(ir)?;
    Ok(())
}

#[derive(Clone, Copy)]
struct ImmutablePackIdentity<'a> {
    kind: &'static str,
    sha256: &'a str,
    library: Option<&'a LibraryPackRef>,
}

fn index_immutable_packs<'a>(
    ir: &'a BuildIr,
) -> Result<HashMap<&'a str, ImmutablePackIdentity<'a>>> {
    fn add<'a>(
        by_id: &mut HashMap<&'a str, ImmutablePackIdentity<'a>>,
        kind: &'static str,
        id: &'a str,
        sha256: &'a str,
        library: Option<&'a LibraryPackRef>,
    ) -> Result<()> {
        if let Some(existing) = by_id.get(id) {
            return validation(format!(
                "ambiguous Pack id {id}: used by {} and {kind}",
                existing.kind
            ));
        }
        by_id.insert(
            id,
            ImmutablePackIdentity {
                kind,
                sha256,
                library,
            },
        );
        Ok(())
    }

    let mut by_id = HashMap::new();
    add(
        &mut by_id,
        "toolchain",
        &ir.packs.toolchain.id,
        &ir.packs.toolchain.sha256,
        None,
    )?;
    add(
        &mut by_id,
        "platform",
        &ir.packs.platform.id,
        &ir.packs.platform.sha256,
        None,
    )?;
    add(
        &mut by_id,
        "board",
        &ir.packs.board.id,
        &ir.packs.board.sha256,
        None,
    )?;
    for library in &ir.packs.libraries.packs {
        add(
            &mut by_id,
            "library",
            &library.id,
            &library.sha256,
            Some(library),
        )?;
    }
    Ok(by_id)
}

/// Recalculate every Action key, including transitive Action and Pack identities.
pub fn calculate_action_keys(ir: &mut BuildIr) -> Result<()> {
    normalize_actions(&mut ir.graph.actions)?;
    validate_action_dependencies(&ir.graph.actions)?;
    let action_by_id: HashMap<String, usize> = ir
        .graph
        .actions
        .iter()
        .enumerate()
        .map(|(index, action)| (action.base().id.clone(), index))
        .collect();
    let immutable_pack_by_id = index_immutable_packs(ir)?;
    for action in &ir.graph.actions {
        for input in &action.base().pack_inputs {
            if immutable_pack_by_id
                .get(input.pack_id.as_str())
                .map(|identity| identity.sha256)
                != Some(input.pack_revision.as_str())
            {
                return validation(format!(
                    "action {} Pack input identity does not match {}",
                    action.base().id,
                    input.pack_id
                ));
            }
        }
    }
    let mut keys = HashMap::new();
    let mut visiting = HashSet::new();

    fn key_for(
        id: &str,
        ir: &BuildIr,
        action_by_id: &HashMap<String, usize>,
        immutable_pack_by_id: &HashMap<&str, ImmutablePackIdentity<'_>>,
        keys: &mut HashMap<String, String>,
        visiting: &mut HashSet<String>,
    ) -> Result<String> {
        if let Some(key) = keys.get(id) {
            return Ok(key.clone());
        }
        if !visiting.insert(id.to_owned()) {
            return validation(format!("action graph cycle contains {id}"));
        }
        let index = action_by_id
            .get(id)
            .copied()
            .ok_or_else(|| BuildIrError::Validation(format!("missing action {id}")))?;
        let action = &ir.graph.actions[index];
        let mut dependency_ids = action.base().dependencies.clone();
        dependency_ids.sort_by(|left, right| compare_code_units(left, right));
        let mut dependency_keys = Vec::with_capacity(dependency_ids.len());
        for dependency in dependency_ids {
            dependency_keys.push(key_for(
                &dependency,
                ir,
                action_by_id,
                immutable_pack_by_id,
                keys,
                visiting,
            )?);
        }
        visiting.remove(id);

        let mut library_ids = Vec::new();
        fn visit_pack(
            id: &str,
            action_id: &str,
            packs: &HashMap<&str, ImmutablePackIdentity<'_>>,
            visited: &mut BTreeSet<String>,
            library_ids: &mut Vec<String>,
        ) -> Result<()> {
            if !visited.insert(id.to_owned()) {
                return Ok(());
            }
            let identity = packs.get(id).copied().ok_or_else(|| {
                BuildIrError::Validation(format!(
                    "action {action_id} references missing pack dependency {id}"
                ))
            })?;
            // Fixed Packs use dedicated cache-key slots; libraries add their transitive closure here.
            let Some(library) = identity.library else {
                return Ok(());
            };
            library_ids.push(id.to_owned());
            for dependency in &library.dependencies {
                visit_pack(&dependency.id, action_id, packs, visited, library_ids)?;
            }
            Ok(())
        }
        let mut visited_pack_ids = BTreeSet::new();
        for pack_id in &action.base().pack_dependencies {
            visit_pack(
                pack_id,
                id,
                immutable_pack_by_id,
                &mut visited_pack_ids,
                &mut library_ids,
            )?;
        }
        library_ids.sort_by(|left, right| compare_code_units(left, right));
        let libraries = Value::Array(
            library_ids
                .into_iter()
                .map(|pack_id| {
                    Value::Array(vec![
                        Value::String(pack_id.clone()),
                        Value::String(immutable_pack_by_id[pack_id.as_str()].sha256.to_owned()),
                    ])
                })
                .collect(),
        );
        let mut action_value = serde_json::to_value(action)?;
        action_value
            .as_object_mut()
            .expect("BuildAction serializes to an object")
            .remove("cacheKey");
        let key_input = serde_json::json!({
            "schemaVersion": CK_BUILD_IR_SCHEMA_VERSION,
            "packs": {
                "toolchain": ir.packs.toolchain.sha256,
                "platform": ir.packs.platform.sha256,
                "board": ir.packs.board.sha256,
                "libraries": libraries,
            },
            "action": action_value,
            "dependencyKeys": dependency_keys,
        });
        let key = sha256_hex(canonical_json(&key_input)?.as_bytes());
        keys.insert(id.to_owned(), key.clone());
        Ok(key)
    }

    let action_ids: Vec<String> = ir
        .graph
        .actions
        .iter()
        .map(|action| action.base().id.clone())
        .collect();
    for id in &action_ids {
        key_for(
            id,
            ir,
            &action_by_id,
            &immutable_pack_by_id,
            &mut keys,
            &mut visiting,
        )?;
    }
    for action in &mut ir.graph.actions {
        action.base_mut().cache_key = keys[&action.base().id].clone();
    }
    Ok(())
}

/// Deterministic JSON with lexicographically sorted object keys.
pub fn canonical_json(value: &Value) -> Result<String> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => Ok(serde_json::to_string(value)?),
        Value::Array(values) => {
            let items = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("[{}]", items.join(",")))
        }
        Value::Object(values) => {
            let mut entries: Vec<(&String, &Value)> = values.iter().collect();
            entries.sort_by(|left, right| compare_code_units(left.0, right.0));
            let items = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key)?,
                        canonical_json(value)?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("{{{}}}", items.join(",")))
        }
    }
}

pub fn map_diagnostics(
    diagnostics: &[RawBuildDiagnostic],
    map: &DiagnosticMap,
) -> Vec<MappedBuildDiagnostic> {
    let mut entries = map.entries.clone();
    entries.sort_by(|left, right| {
        compare_code_units(&left.generated_file, &right.generated_file)
            .then(left.generated_line.cmp(&right.generated_line))
            .then(
                optional_number_key(left.generated_column)
                    .cmp(&optional_number_key(right.generated_column)),
            )
            .then(compare_code_units(&left.source_file, &right.source_file))
            .then(left.source_line.cmp(&right.source_line))
    });
    diagnostics
        .iter()
        .map(|diagnostic| {
            let entry = entries.iter().rfind(|entry| {
                entry.generated_file == diagnostic.file
                    && entry.generated_line == diagnostic.line
                    && (entry.generated_column.is_none()
                        || diagnostic.column.is_none()
                        || entry.generated_column <= diagnostic.column)
            });
            match entry {
                Some(entry) => MappedBuildDiagnostic {
                    diagnostic: RawBuildDiagnostic {
                        severity: diagnostic.severity.clone(),
                        file: entry.source_file.clone(),
                        line: entry.source_line,
                        column: entry.source_column,
                        message: diagnostic.message.clone(),
                        raw: diagnostic.raw.clone(),
                    },
                    source_file: entry.source_file.clone(),
                    source_line: entry.source_line,
                    source_column: entry.source_column,
                    generated_file: Some(diagnostic.file.clone()),
                    generated_line: Some(diagnostic.line),
                    generated_column: diagnostic.column,
                    from_generated: true,
                },
                None => MappedBuildDiagnostic {
                    diagnostic: diagnostic.clone(),
                    source_file: diagnostic.file.clone(),
                    source_line: diagnostic.line,
                    source_column: diagnostic.column,
                    generated_file: None,
                    generated_line: None,
                    generated_column: None,
                    from_generated: false,
                },
            }
        })
        .collect()
}

fn validate_envelope(ir: &BuildIr) -> Result<()> {
    if ir.kind != CK_BUILD_IR_KIND {
        return validation(format!("expected {CK_BUILD_IR_KIND}"));
    }
    if ir.schema_version != CK_BUILD_IR_SCHEMA_VERSION {
        return validation(format!("unsupported schema version {}", ir.schema_version));
    }
    Ok(())
}

fn normalize_libraries(libraries: &mut LibraryPackSet) -> Result<()> {
    libraries
        .roots
        .sort_by(|left, right| compare_code_units(left, right));
    libraries.roots.dedup();
    libraries
        .packs
        .sort_by(|left, right| compare_code_units(&left.id, &right.id));
    ensure_unique(
        libraries.packs.iter().map(|pack| pack.id.as_str()),
        "library pack",
    )?;
    for pack in &mut libraries.packs {
        pack.architectures
            .sort_by(|left, right| compare_code_units(left, right));
        pack.dependencies
            .sort_by(|left, right| compare_code_units(&left.id, &right.id));
    }
    validate_libraries(libraries)
}

fn validate_libraries(libraries: &LibraryPackSet) -> Result<()> {
    let by_id: HashMap<&str, &LibraryPackRef> = libraries
        .packs
        .iter()
        .map(|pack| (pack.id.as_str(), pack))
        .collect();
    if by_id.len() != libraries.packs.len() {
        return validation("duplicate library pack");
    }
    let mut by_logical_version: HashMap<(String, String), &LibraryPackRef> = HashMap::new();
    for pack in &libraries.packs {
        validate_pack_ref(&pack.id, &pack.version, &pack.sha256, "library pack")?;
        if pack.name.trim().is_empty() {
            return validation("library pack name must not be empty");
        }
        let logical_key = (pack.name.to_lowercase(), pack.version.clone());
        if let Some(existing) = by_logical_version.get(&logical_key) {
            let detail = if existing.sha256 == pack.sha256 {
                "duplicate identity"
            } else {
                "multiple revisions"
            };
            return validation(format!(
                "ambiguous library pack {}@{}: {detail}",
                pack.name, pack.version
            ));
        }
        by_logical_version.insert(logical_key, pack);
        for dependency in &pack.dependencies {
            validate_sha256(&dependency.sha256, "library dependency")?;
            let resolved = by_id.get(dependency.id.as_str()).copied().ok_or_else(|| {
                BuildIrError::Validation(format!(
                    "library {} references missing dependency {}",
                    pack.id, dependency.id
                ))
            })?;
            if resolved.version != dependency.version || resolved.sha256 != dependency.sha256 {
                return validation(format!(
                    "library {} dependency identity does not match {}",
                    pack.id, dependency.id
                ));
            }
        }
    }
    for root in &libraries.roots {
        if !by_id.contains_key(root.as_str()) {
            return validation(format!("missing library root {root}"));
        }
    }
    Ok(())
}

fn normalize_actions(actions: &mut [BuildAction]) -> Result<()> {
    actions.sort_by(|left, right| compare_code_units(&left.base().id, &right.base().id));
    ensure_unique(
        actions.iter().map(|action| action.base().id.as_str()),
        "action",
    )?;
    for action in actions {
        let base = action.base_mut();
        if base.id.trim().is_empty() || base.tool.trim().is_empty() {
            return validation("action id and tool must not be empty");
        }
        base.inputs.sort_by(|left, right| {
            compare_code_units(&left.path, &right.path).then(compare_code_units(
                left.role.as_deref().unwrap_or(""),
                right.role.as_deref().unwrap_or(""),
            ))
        });
        for input in &mut base.inputs {
            input.path = normalize_path(&input.path, "action input")?;
            if let Some(sha256) = &input.sha256 {
                validate_sha256(sha256, "action input")?;
            }
        }
        base.outputs
            .sort_by(|left, right| compare_code_units(&left.path, &right.path));
        for output in &mut base.outputs {
            output.path = normalize_path(&output.path, "action output")?;
            if let Some(sha256) = &output.sha256 {
                validate_sha256(sha256, "action output")?;
            }
        }
        base.dependencies
            .sort_by(|left, right| compare_code_units(left, right));
        base.dependencies.dedup();
        base.pack_dependencies
            .sort_by(|left, right| compare_code_units(left, right));
        base.pack_dependencies.dedup();
        base.pack_inputs.sort_by(|left, right| {
            compare_code_units(&left.pack_id, &right.pack_id)
                .then(compare_code_units(&left.artifact_id, &right.artifact_id))
                .then(compare_code_units(
                    left.role.as_deref().unwrap_or(""),
                    right.role.as_deref().unwrap_or(""),
                ))
        });
        let mut pack_input_ids = BTreeSet::new();
        for input in &base.pack_inputs {
            if !pack_input_ids.insert((
                input.pack_id.as_str(),
                input.artifact_id.as_str(),
                input.role.as_deref().unwrap_or(""),
            )) {
                return validation("duplicate action Pack input");
            }
            if input.pack_id.trim().is_empty() || input.artifact_id.trim().is_empty() {
                return validation("action Pack input identity must not be empty");
            }
            if input.pack_schema == 0 {
                return validation("action Pack input schema must be a positive integer");
            }
            validate_sha256(&input.pack_revision, "action Pack input revision")?;
            validate_sha256(&input.sha256, "action Pack input artifact")?;
            if input
                .role
                .as_ref()
                .is_some_and(|role| role.trim().is_empty())
            {
                return validation("action Pack input role must not be empty");
            }
        }

        match action {
            BuildAction::Compile { compile_unit, .. } => {
                compile_unit.source = normalize_path(&compile_unit.source, "compile source")?;
                compile_unit.output = normalize_path(&compile_unit.output, "compile output")?;
                for path in &mut compile_unit.include_paths {
                    *path = normalize_path(path, "compile include")?;
                }
            }
            BuildAction::Archive { archive, .. } => {
                for path in &mut archive.objects {
                    *path = normalize_path(path, "archive input")?;
                }
                archive.output = normalize_path(&archive.output, "archive output")?;
            }
            BuildAction::Link { link, .. } => {
                for path in &mut link.objects {
                    *path = normalize_path(path, "link input")?;
                }
                for path in &mut link.archives {
                    *path = normalize_path(path, "link archive")?;
                }
                link.output = normalize_path(&link.output, "link output")?;
                if let Some(path) = &mut link.linker_script {
                    *path = normalize_path(path, "linker script")?;
                }
            }
            BuildAction::Transform { transform, .. } => {
                transform.input = normalize_path(&transform.input, "transform input")?;
                transform.output = normalize_path(&transform.output, "transform output")?;
            }
        }
    }
    Ok(())
}

fn validate_action_graph(ir: &BuildIr) -> Result<()> {
    validate_action_dependencies(&ir.graph.actions)?;
    for action in &ir.graph.actions {
        validate_sha256(&action.base().cache_key, "action cache key")?;
    }
    Ok(())
}

fn validate_action_dependencies(actions: &[BuildAction]) -> Result<()> {
    let by_id: HashMap<&str, &BuildAction> = actions
        .iter()
        .map(|action| (action.base().id.as_str(), action))
        .collect();
    if by_id.len() != actions.len() {
        return validation("duplicate action");
    }
    for action in actions {
        for dependency in &action.base().dependencies {
            if dependency == &action.base().id {
                return validation(format!("action {} depends on itself", action.base().id));
            }
            if !by_id.contains_key(dependency.as_str()) {
                return validation(format!(
                    "action {} references missing dependency {dependency}",
                    action.base().id
                ));
            }
        }
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a BuildAction>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> Result<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return validation(format!("action graph cycle contains {id}"));
        }
        for dependency in &by_id[id].base().dependencies {
            visit(dependency, by_id, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }
    for id in by_id.keys().copied() {
        visit(id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn normalize_path(value: &str, label: &str) -> Result<String> {
    let path = value.replace('\\', "/");
    let has_drive = path.len() >= 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[2] == b'/';
    if path.is_empty()
        || path.starts_with('/')
        || has_drive
        || path.split('/').any(|part| part == "..")
    {
        return validation(format!(
            "{label} path must be relative and must not contain '..': {value}"
        ));
    }
    Ok(path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

fn infer_language(path: &str) -> SourceLanguage {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "ino" => SourceLanguage::Ino,
        "c" => SourceLanguage::C,
        "cc" | "cpp" | "cxx" => SourceLanguage::Cpp,
        "s" | "asm" => SourceLanguage::Asm,
        "h" | "hh" | "hpp" | "hxx" => SourceLanguage::Header,
        _ => SourceLanguage::Other,
    }
}

fn validate_pack_ref(id: &str, version: &str, sha256: &str, label: &str) -> Result<()> {
    if id.trim().is_empty() || version.trim().is_empty() {
        return validation(format!("{label} id and version must not be empty"));
    }
    validate_sha256(sha256, label)
}

fn validate_sha256(value: &str, label: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return validation(format!(
            "{label} sha256 must be 64 lowercase hexadecimal characters"
        ));
    }
    Ok(())
}

fn ensure_unique<'a>(values: impl Iterator<Item = &'a str>, label: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !seen.insert(value) {
            return validation(format!("duplicate {label}: {value}"));
        }
    }
    Ok(())
}

fn ensure_unique_case_folded<'a>(values: impl Iterator<Item = &'a str>, label: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !seen.insert(value.to_lowercase()) {
            return validation(format!("duplicate {label}: {value}"));
        }
    }
    Ok(())
}

fn compare_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn sha256_hex(input: &[u8]) -> String {
    format!("{:x}", Sha256::digest(input))
}

fn optional_number_key(value: Option<u64>) -> (bool, u64) {
    (value.is_some(), value.unwrap_or_default())
}

fn validation<T>(message: impl Into<String>) -> Result<T> {
    Err(BuildIrError::Validation(message.into()))
}

#[cfg(feature = "wasm")]
mod wasm {
    use super::{
        BuildAction, BuildIr, BuildIrInput, BuildPlannerInput, DiagnosticMap,
        LibraryResolutionInput, PlatformPackRef, ProjectInput, RawBuildDiagnostic,
        ResolvePlatformManifestInput, TargetInput,
    };
    use serde::{de::DeserializeOwned, Deserialize, Serialize};
    use wasm_bindgen::prelude::*;

    #[derive(Deserialize)]
    struct MapDiagnosticsInput {
        diagnostics: Vec<RawBuildDiagnostic>,
        map: DiagnosticMap,
    }

    fn decode<T: DeserializeOwned>(input: &str) -> std::result::Result<T, JsValue> {
        serde_json::from_str(input).map_err(js_error)
    }

    fn encode<T: Serialize>(value: T) -> std::result::Result<String, JsValue> {
        let value = serde_json::to_value(value).map_err(js_error)?;
        super::canonical_json(&value).map_err(js_error)
    }

    fn js_error(error: impl ToString) -> JsValue {
        JsValue::from_str(&error.to_string())
    }

    #[wasm_bindgen(js_name = resolveProject)]
    pub fn resolve_project(input: &str) -> std::result::Result<String, JsValue> {
        encode(super::resolve_project(decode::<ProjectInput>(input)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = resolveTarget)]
    pub fn resolve_target(input: &str) -> std::result::Result<String, JsValue> {
        encode(super::resolve_target(decode::<TargetInput>(input)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = resolvePlatform)]
    pub fn resolve_platform(input: &str) -> std::result::Result<String, JsValue> {
        encode(super::resolve_platform(decode::<PlatformPackRef>(input)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = resolvePlatformManifest)]
    pub fn resolve_platform_manifest(input: &str) -> std::result::Result<String, JsValue> {
        encode(
            super::resolve_platform_manifest(decode::<ResolvePlatformManifestInput>(input)?)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name = resolveLibraries)]
    pub fn resolve_libraries(input: &str) -> std::result::Result<String, JsValue> {
        encode(
            super::resolve_libraries(decode::<LibraryResolutionInput>(input)?).map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name = createActionGraph)]
    pub fn create_action_graph(input: &str) -> std::result::Result<String, JsValue> {
        let actions = decode::<Vec<BuildAction>>(input)?;
        encode(super::create_action_graph(actions).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = createBuildIR)]
    pub fn create_build_ir(input: &str) -> std::result::Result<String, JsValue> {
        encode(super::create_build_ir(decode::<BuildIrInput>(input)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = planBuildActions)]
    pub fn plan_build_actions(input: &str) -> std::result::Result<String, JsValue> {
        encode(super::plan_build_actions(decode::<BuildPlannerInput>(input)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = planBuildIR)]
    pub fn plan_build_ir(input: &str) -> std::result::Result<String, JsValue> {
        encode(super::plan_build_ir(decode::<BuildPlannerInput>(input)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = calculateActionKeys)]
    pub fn calculate_action_keys(input: &str) -> std::result::Result<String, JsValue> {
        let mut ir = decode::<BuildIr>(input)?;
        super::calculate_action_keys(&mut ir).map_err(js_error)?;
        encode(ir)
    }

    #[wasm_bindgen(js_name = mapDiagnostics)]
    pub fn map_diagnostics(input: &str) -> std::result::Result<String, JsValue> {
        let input = decode::<MapDiagnosticsInput>(input)?;
        encode(super::map_diagnostics(&input.diagnostics, &input.map))
    }

    #[wasm_bindgen(js_name = migrateBuildIR)]
    pub fn migrate_build_ir(input: &str) -> std::result::Result<String, JsValue> {
        super::migrate_build_ir_json(input).map_err(js_error)
    }

    #[wasm_bindgen(js_name = validateBuildIR)]
    pub fn validate_build_ir(input: &str) -> std::result::Result<(), JsValue> {
        let mut ir = decode::<BuildIr>(input)?;
        super::normalize_build_ir(&mut ir).map_err(js_error)
    }
}
