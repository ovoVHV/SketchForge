use super::{
    create_build_ir, normalize_path, resolve_libraries, resolve_project, resolve_target,
    sha256_hex, ActionBase, ActionInput, ActionOutput, ActionPackInput, ActionResourceLimits,
    ArchiveSpec, BuildAction, BuildArtifact, BuildIr, BuildIrInput, BuildPacks, CompileLanguage,
    CompileUnit, DiagnosticMapEntry, DiagnosticMapInput, LibraryPackRef, LibraryResolutionInput,
    MacroValue, ProjectFile, ProjectInput, Result, SourceLanguage, TargetInput, TargetSpec,
    TransformFormat, TransformSpec,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlannerCompilerFlags {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub c: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cxx: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asm: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub common: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerSourceTree {
    pub files: ProjectInput,
    #[serde(default)]
    pub include_paths: Vec<String>,
    #[serde(default)]
    pub macros: BTreeMap<String, MacroValue>,
    #[serde(default)]
    pub flags: PlannerCompilerFlags,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerPlatformInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core: Option<PlannerSourceTree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<PlannerSourceTree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<ProjectInput>,
    #[serde(default)]
    pub include_paths: Vec<String>,
    #[serde(default)]
    pub macros: BTreeMap<String, MacroValue>,
    #[serde(default)]
    pub flags: PlannerCompilerFlags,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linker_script: Option<String>,
    #[serde(default)]
    pub linker_flags: Vec<String>,
    #[serde(default)]
    pub linker_inputs: Vec<ActionInput>,
    #[serde(default)]
    pub prebuilt_archives: Vec<ActionInput>,
    #[serde(default)]
    pub linker_tail_flags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_operation: Option<String>,
    #[serde(default)]
    pub archive_flags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerLibraryInput {
    pub pack: LibraryPackRef,
    pub files: ProjectInput,
    #[serde(default)]
    pub include_paths: Vec<String>,
    #[serde(default)]
    pub macros: BTreeMap<String, MacroValue>,
    #[serde(default)]
    pub flags: PlannerCompilerFlags,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlannerToolNames {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preprocess: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cxx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ld: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objcopy: Option<String>,
}

#[derive(Clone, Debug)]
struct ResolvedTools {
    preprocess: String,
    c: String,
    cxx: String,
    asm: String,
    ar: String,
    ld: String,
    objcopy: String,
}

impl From<PlannerToolNames> for ResolvedTools {
    fn from(value: PlannerToolNames) -> Self {
        Self {
            preprocess: value.preprocess.unwrap_or_else(|| "ck:preprocess".into()),
            c: value.c.unwrap_or_else(|| "toolchain:cc".into()),
            cxx: value.cxx.unwrap_or_else(|| "toolchain:cxx".into()),
            asm: value.asm.unwrap_or_else(|| "toolchain:as".into()),
            ar: value.ar.unwrap_or_else(|| "toolchain:ar".into()),
            ld: value.ld.unwrap_or_else(|| "toolchain:ld".into()),
            objcopy: value.objcopy.unwrap_or_else(|| "toolchain:objcopy".into()),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlannerResourceLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compile: Option<ActionResourceLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<ActionResourceLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<ActionResourceLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<ActionResourceLimits>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTransformSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_project_transform_lifecycle")]
    pub lifecycle: PlannerTransformLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_dependencies: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pack_inputs: Vec<ActionPackInput>,
    pub format: TransformFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<ActionInput>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_sha256: Option<String>,
    #[serde(default)]
    pub flags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<Option<String>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlannerTransformLifecycle {
    #[default]
    Project,
    Configuration,
}

fn is_project_transform_lifecycle(value: &PlannerTransformLifecycle) -> bool {
    *value == PlannerTransformLifecycle::Project
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlannerTransformInput {
    Format(TransformFormat),
    Spec(PlannerTransformSpec),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildPlannerInput {
    pub project: ProjectInput,
    #[serde(default)]
    pub project_compile_paths: Vec<String>,
    pub target: TargetInput,
    pub packs: BuildPacks,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<PlannerPlatformInput>,
    #[serde(default, alias = "librarySources")]
    pub libraries: Vec<PlannerLibraryInput>,
    #[serde(default)]
    pub tools: PlannerToolNames,
    #[serde(default)]
    pub macros: BTreeMap<String, MacroValue>,
    #[serde(default)]
    pub include_paths: Vec<String>,
    #[serde(default)]
    pub flags: PlannerCompilerFlags,
    #[serde(default)]
    pub compiler_inputs: Vec<ActionInput>,
    #[serde(default)]
    pub compiler_pack_inputs: Vec<ActionPackInput>,
    #[serde(default)]
    pub linker_flags: Vec<String>,
    #[serde(default)]
    pub linker_inputs: Vec<ActionInput>,
    #[serde(default)]
    pub linker_pack_inputs: Vec<ActionPackInput>,
    #[serde(default)]
    pub linker_tail_flags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_operation: Option<String>,
    #[serde(default)]
    pub archive_flags: Vec<String>,
    #[serde(default)]
    pub preprocess_flags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linker_script: Option<String>,
    #[serde(default)]
    pub transforms: Vec<PlannerTransformInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_root: Option<String>,
    #[serde(default)]
    pub resource_limits: PlannerResourceLimits,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildActionPlan {
    pub actions: Vec<BuildAction>,
    pub artifacts: Vec<BuildArtifact>,
    pub diagnostic_map: Vec<DiagnosticMapEntry>,
}

#[derive(Clone)]
struct SourceUnit {
    file: ProjectFile,
    sketch_files: Vec<ProjectFile>,
    path: String,
    include_paths: Vec<String>,
    macros: BTreeMap<String, MacroValue>,
    flags: PlannerCompilerFlags,
    group: SourceGroup,
}

#[derive(Clone, Copy)]
enum SourceGroup {
    Project,
    Core,
    Library,
}

#[derive(Clone)]
struct ObjectRef {
    path: String,
    action_id: String,
}

#[derive(Clone)]
struct ArchiveRef {
    path: String,
    action_id: String,
    pack_id: Option<String>,
}

struct CompileContext<'a> {
    output_root: &'a str,
    tools: &'a ResolvedTools,
    preprocess_flags: &'a [String],
    library_ids: &'a [String],
    additional_inputs: &'a [ActionInput],
    pack_inputs: &'a [ActionPackInput],
    limits: Option<ActionResourceLimits>,
    preprocess_limits: Option<ActionResourceLimits>,
}

pub fn plan_build_actions(input: BuildPlannerInput) -> Result<BuildActionPlan> {
    let project = resolve_project(input.project.clone())?;
    let target = resolve_target(input.target.clone())?;
    let libraries = resolve_libraries(LibraryResolutionInput {
        roots: Some(input.packs.libraries.roots.clone()),
        packs: input.packs.libraries.packs.clone(),
    })?;
    let output_root = normalize_path(
        input.output_root.as_deref().unwrap_or("build"),
        "output root",
    )?;
    let tools = ResolvedTools::from(input.tools.clone());
    let archive_operation = normalize_archive_operation(
        input
            .platform
            .as_ref()
            .and_then(|platform| platform.archive_operation.as_deref())
            .or(input.archive_operation.as_deref()),
    )?;
    let global_includes = unique_paths(&input.include_paths)?;
    let project_compile_paths: BTreeSet<String> = if input.project_compile_paths.is_empty() {
        project.files.iter().map(|file| file.path.clone()).collect()
    } else {
        input
            .project_compile_paths
            .iter()
            .map(|path| normalize_path(path, "project compile path"))
            .collect::<Result<_>>()?
    };
    let project_inputs = project
        .files
        .iter()
        .filter(|file| project_compile_paths.contains(&file.path))
        .map(|file| ActionInput {
            path: file.path.clone(),
            sha256: Some(file.sha256.clone()),
            role: Some(
                if file.language == SourceLanguage::Header {
                    "project-header"
                } else {
                    "project-file"
                }
                .into(),
            ),
        })
        .collect::<Vec<_>>();
    let mut project_sketches = project
        .files
        .iter()
        .filter(|file| {
            project_compile_paths.contains(&file.path)
                && file.language == SourceLanguage::Ino
                && !file.path.contains('/')
        })
        .cloned()
        .collect::<Vec<_>>();
    project_sketches.sort_by(|left, right| compare_code_units(&left.path, &right.path));
    if let Some(index) = project_sketches
        .iter()
        .position(|file| file.path.eq_ignore_ascii_case("main.ino"))
    {
        let main = project_sketches.remove(index);
        project_sketches.insert(0, main);
    }
    let project_sketch_paths = project_sketches
        .iter()
        .map(|file| file.path.clone())
        .collect::<HashSet<_>>();
    let project_library_ids = libraries
        .packs
        .iter()
        .map(|pack| pack.id.clone())
        .collect::<Vec<_>>();

    let mut platform_trees: Vec<(PlannerSourceTree, &'static str)> = Vec::new();
    if let Some(platform) = &input.platform {
        if let Some(core) = &platform.core {
            platform_trees.push((core.clone(), "core"));
        }
        if let Some(variant) = &platform.variant {
            platform_trees.push((variant.clone(), "variant"));
        }
        if platform_trees.is_empty() {
            if let Some(files) = &platform.files {
                platform_trees.push((
                    PlannerSourceTree {
                        files: files.clone(),
                        include_paths: Vec::new(),
                        macros: BTreeMap::new(),
                        flags: PlannerCompilerFlags::default(),
                        root_path: Some(format!("packs/platform/{}", slug(&target.fqbn))),
                    },
                    "core",
                ));
            }
        }
    }
    let mut platform_includes = input
        .platform
        .as_ref()
        .map(|p| p.include_paths.clone())
        .unwrap_or_default();
    for (tree, role) in &platform_trees {
        let root = tree_root(
            tree.root_path.as_deref(),
            &format!("packs/platform/{}/{role}", slug(&target.fqbn)),
        )?;
        platform_includes.push(root.clone());
        for path in &tree.include_paths {
            platform_includes.push(join_path(&root, path)?);
        }
    }
    let platform_includes = unique_paths(&platform_includes)?;
    let platform_macros = merge_macros(&input.macros, input.platform.as_ref().map(|p| &p.macros));
    let platform_flags = merge_flags(&input.flags, input.platform.as_ref().map(|p| &p.flags));

    let mut library_by_id = HashMap::new();
    for library in &input.libraries {
        if library_by_id
            .insert(library.pack.id.clone(), library.clone())
            .is_some()
        {
            return super::validation(format!(
                "duplicate library source tree: {}",
                library.pack.id
            ));
        }
        let resolved = libraries
            .packs
            .iter()
            .find(|pack| pack.id == library.pack.id);
        if resolved.is_none_or(|pack| {
            pack.version != library.pack.version || pack.sha256 != library.pack.sha256
        }) {
            return super::validation(format!(
                "library source Pack does not match resolved Pack: {}",
                library.pack.id
            ));
        }
    }

    let mut all_library_includes = Vec::new();
    let mut library_file_inputs: HashMap<String, Vec<ActionInput>> = HashMap::new();
    let mut text_included_by_id: HashMap<String, HashSet<String>> = HashMap::new();
    for library in &input.libraries {
        let root = tree_root(
            library.root_path.as_deref(),
            &format!("packs/libraries/{}", slug(&library.pack.id)),
        )?;
        all_library_includes.push(root.clone());
        for path in &library.include_paths {
            all_library_includes.push(join_path(&root, path)?);
        }
        let snapshot = resolve_project(library.files.clone())?;
        let text_included = find_text_included_sources(&snapshot.files, &library.include_paths);
        let files = snapshot
            .files
            .iter()
            .map(|file| ActionInput {
                path: join_path(&root, &file.path).expect("normalized source tree path"),
                sha256: Some(file.sha256.clone()),
                role: Some(
                    if file.language == SourceLanguage::Header {
                        "library-header"
                    } else if is_include_fragment(&file.path) || text_included.contains(&file.path)
                    {
                        "library-include-fragment"
                    } else {
                        "library-file"
                    }
                    .into(),
                ),
            })
            .collect();
        library_file_inputs.insert(library.pack.id.clone(), files);
        text_included_by_id.insert(library.pack.id.clone(), text_included);
    }
    let all_library_includes = unique_paths(&all_library_includes)?;
    let private_library_includes = resolve_private_library_include_paths(&input.libraries)?;
    let mut all_library_inputs = library_file_inputs
        .values()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    all_library_inputs.sort_by(|a, b| compare_code_units(&a.path, &b.path));
    let project_library_inputs = all_library_inputs
        .iter()
        .filter(|item| {
            matches!(
                item.role.as_deref(),
                Some("library-header" | "library-include-fragment")
            )
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut actions = Vec::new();
    let mut objects = Vec::new();
    let mut archives = Vec::new();
    let mut diagnostic_map = Vec::new();

    for file in &project.files {
        if !project_compile_paths.contains(&file.path) || !is_compilable(file.language) {
            continue;
        }
        if project_sketch_paths.contains(&file.path)
            && project_sketches
                .first()
                .is_some_and(|main| main.path != file.path)
        {
            continue;
        }
        let mut includes = global_includes.clone();
        if let Some(directory) = source_directory(&file.path) {
            includes.push(directory);
        }
        includes.extend(all_library_includes.clone());
        includes.extend(platform_includes.clone());
        let includes = unique_paths(&includes)?;
        let mut additional = project_inputs.clone();
        additional.extend(project_library_inputs.clone());
        additional.extend(input.compiler_inputs.clone());
        let context = CompileContext {
            output_root: &output_root,
            tools: &tools,
            preprocess_flags: &input.preprocess_flags,
            library_ids: &project_library_ids,
            additional_inputs: &additional,
            pack_inputs: &input.compiler_pack_inputs,
            limits: input.resource_limits.compile.clone(),
            preprocess_limits: input.resource_limits.transform.clone(),
        };
        let object = add_compile_unit(
            SourceUnit {
                file: file.clone(),
                sketch_files: if project_sketches
                    .first()
                    .is_some_and(|main| main.path == file.path)
                {
                    project_sketches.clone()
                } else {
                    Vec::new()
                },
                path: file.path.clone(),
                include_paths: includes,
                macros: input.macros.clone(),
                flags: input.flags.clone(),
                group: SourceGroup::Project,
            },
            &context,
            &mut actions,
            &mut diagnostic_map,
        )?;
        objects.push(object);
    }

    let mut core_objects = Vec::new();
    for (tree, role) in &platform_trees {
        let snapshot = resolve_project(tree.files.clone())?;
        let root = tree_root(
            tree.root_path.as_deref(),
            &format!("packs/platform/{}/{role}", slug(&target.fqbn)),
        )?;
        let mut includes = platform_includes.clone();
        includes.push(root.clone());
        for path in &tree.include_paths {
            includes.push(join_path(&root, path)?);
        }
        includes.extend(all_library_includes.clone());
        let includes = unique_paths(&includes)?;
        for file in snapshot.files {
            if !is_compilable(file.language) {
                continue;
            }
            let context = CompileContext {
                output_root: &output_root,
                tools: &tools,
                preprocess_flags: &input.preprocess_flags,
                library_ids: &[],
                additional_inputs: &input.compiler_inputs,
                pack_inputs: &input.compiler_pack_inputs,
                limits: input.resource_limits.compile.clone(),
                preprocess_limits: input.resource_limits.transform.clone(),
            };
            let object = add_compile_unit(
                SourceUnit {
                    path: join_path(&root, &file.path)?,
                    file,
                    sketch_files: Vec::new(),
                    include_paths: includes.clone(),
                    macros: merge_macros(&platform_macros, Some(&tree.macros)),
                    flags: merge_flags(&platform_flags, Some(&tree.flags)),
                    group: SourceGroup::Core,
                },
                &context,
                &mut actions,
                &mut diagnostic_map,
            )?;
            core_objects.push(object);
        }
    }
    if !core_objects.is_empty() {
        let archive_path = join_path(&output_root, "lib/core.a")?;
        let flags = input
            .platform
            .as_ref()
            .filter(|p| !p.archive_flags.is_empty())
            .map(|p| p.archive_flags.clone())
            .unwrap_or_else(|| input.archive_flags.clone());
        let archive = create_archive_action(
            "archive-core",
            &tools.ar,
            &archive_operation,
            &archive_path,
            &core_objects,
            &flags,
            &[],
            input.resource_limits.archive.clone(),
        );
        actions.push(archive);
        archives.push(ArchiveRef {
            path: archive_path,
            action_id: "archive-core".into(),
            pack_id: None,
        });
    }

    for pack in &libraries.packs {
        let Some(source_tree) = library_by_id.get(&pack.id) else {
            continue;
        };
        let snapshot = resolve_project(source_tree.files.clone())?;
        let text_included = text_included_by_id
            .get(&pack.id)
            .cloned()
            .unwrap_or_default();
        let root = tree_root(
            source_tree.root_path.as_deref(),
            &format!("packs/libraries/{}", slug(&pack.id)),
        )?;
        let mut includes = global_includes.clone();
        includes.push(root.clone());
        for path in &source_tree.include_paths {
            includes.push(join_path(&root, path)?);
        }
        includes.extend(all_library_includes.clone());
        includes.extend(platform_includes.clone());
        let includes = unique_paths(&includes)?;
        let closure = library_dependency_closure(&pack.id, &libraries.packs)?;
        let mut additional = closure
            .iter()
            .flat_map(|id| library_file_inputs.get(id).into_iter().flatten().cloned())
            .collect::<Vec<_>>();
        additional.extend(referenced_project_headers(&snapshot.files, &project.files));
        additional.extend(input.compiler_inputs.clone());
        additional.sort_by(|a, b| compare_code_units(&a.path, &b.path));
        let mut private_flags = PlannerCompilerFlags::default();
        for path in private_library_includes.get(&pack.id).into_iter().flatten() {
            private_flags.common.push("-idirafter".into());
            private_flags.common.push(path.clone());
        }
        let library_flags = merge_flags(
            &merge_flags(&input.flags, Some(&source_tree.flags)),
            Some(&private_flags),
        );
        let mut library_objects = Vec::new();
        for file in snapshot.files {
            if !is_compilable(file.language) || text_included.contains(&file.path) {
                continue;
            }
            let context = CompileContext {
                output_root: &output_root,
                tools: &tools,
                preprocess_flags: &input.preprocess_flags,
                library_ids: &closure,
                additional_inputs: &additional,
                pack_inputs: &input.compiler_pack_inputs,
                limits: input.resource_limits.compile.clone(),
                preprocess_limits: input.resource_limits.transform.clone(),
            };
            let object = add_compile_unit(
                SourceUnit {
                    path: join_path(&root, &file.path)?,
                    file,
                    sketch_files: Vec::new(),
                    include_paths: includes.clone(),
                    macros: merge_macros(&input.macros, Some(&source_tree.macros)),
                    flags: library_flags.clone(),
                    group: SourceGroup::Library,
                },
                &context,
                &mut actions,
                &mut diagnostic_map,
            )?;
            library_objects.push(object);
        }
        if library_objects.is_empty() {
            continue;
        }
        let archive_path = join_path(&output_root, &format!("lib/{}.a", slug(&pack.id)))?;
        let flags = input.archive_flags.clone();
        let id = format!("archive-library-{}", slug(&pack.id));
        actions.push(create_archive_action(
            &id,
            &tools.ar,
            &archive_operation,
            &archive_path,
            &library_objects,
            &flags,
            &closure,
            input.resource_limits.archive.clone(),
        ));
        archives.push(ArchiveRef {
            path: archive_path,
            action_id: id,
            pack_id: Some(pack.id.clone()),
        });
    }

    archives = order_archives(archives, &libraries.packs);
    let elf_path = join_path(&output_root, "firmware.elf")?;
    let platform = input.platform.as_ref();
    let link_flags = platform
        .filter(|p| !p.linker_flags.is_empty())
        .map(|p| p.linker_flags.clone())
        .unwrap_or_else(|| input.linker_flags.clone());
    let tail_flags = platform
        .filter(|p| !p.linker_tail_flags.is_empty())
        .map(|p| p.linker_tail_flags.clone())
        .unwrap_or_else(|| input.linker_tail_flags.clone());
    let linker_script = platform
        .and_then(|p| p.linker_script.clone())
        .or(input.linker_script.clone());
    let linker_inputs = platform
        .filter(|p| !p.linker_inputs.is_empty())
        .map(|p| p.linker_inputs.clone())
        .unwrap_or_else(|| input.linker_inputs.clone());
    let prebuilt = platform
        .map(|p| p.prebuilt_archives.clone())
        .unwrap_or_default();
    actions.push(create_link_action(
        &tools.ld,
        &elf_path,
        &objects,
        &archives,
        &prebuilt,
        linker_script.as_deref(),
        &link_flags,
        &tail_flags,
        &linker_inputs,
        &project_library_ids,
        &input.linker_pack_inputs,
        input.resource_limits.link.clone(),
    ));

    let mut artifacts = vec![BuildArtifact {
        path: elf_path.clone(),
        format: TransformFormat::Elf,
        offset: None,
    }];
    let transforms = normalize_transforms(&input.transforms, &target, &output_root)?;
    let mut action_ids = actions
        .iter()
        .map(|action| action_id(action).to_owned())
        .collect::<HashSet<_>>();
    let mut producer_by_output = HashMap::<String, String>::new();
    for action in &actions {
        let id = action_id(action).to_owned();
        let outputs = match action {
            BuildAction::Compile { base, .. }
            | BuildAction::Archive { base, .. }
            | BuildAction::Link { base, .. }
            | BuildAction::Transform { base, .. } => &base.outputs,
        };
        for output in outputs {
            producer_by_output.insert(output.path.clone(), id.clone());
        }
    }
    let mut transform_plans = Vec::new();
    for spec in transforms {
        if spec.format == TransformFormat::Elf {
            if let Some(offset) = spec.offset {
                artifacts[0].offset = offset;
            }
            continue;
        }
        let product_id = spec
            .product_id
            .clone()
            .unwrap_or_else(|| transform_name(spec.format).into());
        let product_id = normalize_transform_product_id(&product_id)?;
        let transform_id = spec
            .id
            .clone()
            .unwrap_or_else(|| format!("transform-{product_id}"));
        let transform_id = normalize_transform_action_id(&transform_id)?;
        if !action_ids.insert(transform_id.clone()) {
            return super::validation(format!("duplicate transform action id: {transform_id}"));
        }
        let (transform_input, transform_inputs) = resolve_transform_inputs(&spec, &elf_path)?;
        let output = spec
            .output
            .clone()
            .unwrap_or(default_transform_output(&output_root, spec.format)?);
        let output = normalize_path(&output, "transform output")?;
        if producer_by_output.contains_key(&output) {
            return super::validation(format!("transform output has multiple owners: {output}"));
        }
        producer_by_output.insert(output.clone(), transform_id.clone());
        transform_plans.push((
            spec,
            product_id,
            transform_id,
            transform_input,
            transform_inputs,
            output,
        ));
    }

    for (spec, product_id, transform_id, transform_input, transform_inputs, output) in
        transform_plans
    {
        let mut dependency_set = spec
            .dependencies
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();
        for transform_input_item in &transform_inputs {
            if let Some(producer) = producer_by_output.get(&transform_input_item.path) {
                if producer == &transform_id {
                    return super::validation(format!(
                        "transform {transform_id} consumes its own output: {}",
                        transform_input_item.path
                    ));
                }
                dependency_set.insert(producer.clone());
            } else if transform_input_item.sha256.is_none() {
                return super::validation(format!(
                    "transform {transform_id} input has neither an immutable sha256 nor a producing Action: {}",
                    transform_input_item.path
                ));
            }
        }
        let dependencies = dependency_set.into_iter().collect::<Vec<_>>();
        let arguments = spec.arguments.clone().unwrap_or_else(|| {
            transform_arguments(spec.format, &transform_input, &output, &spec.flags)
        });
        let base = ActionBase {
            id: transform_id,
            tool: spec.tool.clone().unwrap_or_else(|| tools.objcopy.clone()),
            inputs: transform_inputs,
            outputs: vec![ActionOutput {
                path: output.clone(),
                kind: Some(product_id),
                sha256: spec.output_sha256.clone(),
            }],
            arguments,
            environment: BTreeMap::new(),
            dependencies,
            pack_dependencies: spec.pack_dependencies.clone().unwrap_or_else(|| {
                if spec.lifecycle == PlannerTransformLifecycle::Configuration {
                    Vec::new()
                } else {
                    project_library_ids.clone()
                }
            }),
            pack_inputs: spec.pack_inputs.clone(),
            resource_limits: input.resource_limits.transform.clone(),
            cache_key: String::new(),
        };
        actions.push(BuildAction::Transform {
            base,
            transform: TransformSpec {
                input: transform_input,
                output: output.clone(),
                format: spec.format,
                flags: spec.flags.clone(),
            },
        });
        artifacts.push(BuildArtifact {
            path: output,
            format: spec.format,
            offset: spec.offset.unwrap_or(None),
        });
    }

    actions.sort_by(|a, b| compare_code_units(action_id(a), action_id(b)));
    artifacts.sort_by(|a, b| compare_code_units(&a.path, &b.path));
    diagnostic_map.sort_by(|a, b| {
        compare_code_units(&a.generated_file, &b.generated_file)
            .then(a.generated_line.cmp(&b.generated_line))
            .then(a.generated_column.cmp(&b.generated_column))
            .then(compare_code_units(&a.source_file, &b.source_file))
            .then(a.source_line.cmp(&b.source_line))
    });
    Ok(BuildActionPlan {
        actions,
        artifacts,
        diagnostic_map,
    })
}

pub fn plan_build_ir(input: BuildPlannerInput) -> Result<BuildIr> {
    let plan = plan_build_actions(input.clone())?;
    create_build_ir(BuildIrInput {
        project: input.project,
        target: input.target,
        packs: input.packs,
        actions: plan.actions,
        artifacts: plan.artifacts,
        diagnostic_map: DiagnosticMapInput::Entries(plan.diagnostic_map),
    })
}

fn add_compile_unit(
    unit: SourceUnit,
    context: &CompileContext<'_>,
    actions: &mut Vec<BuildAction>,
    diagnostic_map: &mut Vec<DiagnosticMapEntry>,
) -> Result<ObjectRef> {
    let mut source = unit.path.clone();
    let mut dependencies = Vec::new();
    if unit.file.language == SourceLanguage::Ino {
        let sketches = if unit.sketch_files.is_empty() {
            vec![unit.file.clone()]
        } else {
            unit.sketch_files.clone()
        };
        let composition = compose_arduino_sketch(&sketches)?;
        for (index, line) in sketch_function_lines(&composition.source)
            .into_iter()
            .enumerate()
        {
            let Some((source_file, source_line)) = composition.line_origins.get(&line) else {
                return super::validation(format!(
                    "preprocessed sketch function has no source origin at line {line}"
                ));
            };
            diagnostic_map.push(DiagnosticMapEntry {
                generated_file: "<generated>".into(),
                generated_line: (index + 1) as u64,
                generated_column: Some(1),
                source_file: source_file.clone(),
                source_line: *source_line,
                source_column: Some(1),
            });
        }
        source = join_path(
            context.output_root,
            &format!("generated/{}.cpp", without_extension(&unit.path)),
        )?;
        let preprocess_id = format!("preprocess-{}", slug(&unit.path));
        let mut arguments = sketches
            .iter()
            .map(|sketch| sketch.path.clone())
            .collect::<Vec<_>>();
        arguments.extend(["-o".into(), source.clone()]);
        arguments.extend(context.preprocess_flags.to_vec());
        let base = ActionBase {
            id: preprocess_id.clone(),
            tool: context.tools.preprocess.clone(),
            inputs: sketches
                .iter()
                .enumerate()
                .map(|(index, sketch)| ActionInput {
                    path: sketch.path.clone(),
                    sha256: Some(sketch.sha256.clone()),
                    role: Some(
                        if index == 0 {
                            "sketch-main"
                        } else {
                            "sketch-tab"
                        }
                        .into(),
                    ),
                })
                .collect(),
            outputs: vec![ActionOutput {
                path: source.clone(),
                kind: Some("generated-source".into()),
                sha256: None,
            }],
            arguments,
            environment: BTreeMap::new(),
            dependencies: Vec::new(),
            pack_dependencies: context.library_ids.to_vec(),
            pack_inputs: Vec::new(),
            resource_limits: context.preprocess_limits.clone(),
            cache_key: String::new(),
        };
        actions.push(BuildAction::Transform {
            base,
            transform: TransformSpec {
                input: unit.path.clone(),
                output: source.clone(),
                format: TransformFormat::Other,
                flags: context.preprocess_flags.to_vec(),
            },
        });
        dependencies.push(preprocess_id);
    }
    let group = match unit.group {
        SourceGroup::Project => "project",
        SourceGroup::Core => "core",
        SourceGroup::Library => "library",
    };
    let prefix = match unit.group {
        SourceGroup::Project => "compile-project",
        SourceGroup::Core => "compile-core",
        SourceGroup::Library => "compile-library",
    };
    let output = join_path(
        context.output_root,
        &format!("obj/{group}/{}.o", slug(&unit.path)),
    )?;
    let flags = compile_flags(unit.file.language, &unit.flags);
    let mut macro_entries = unit.macros.iter().collect::<Vec<_>>();
    macro_entries.sort_by(|left, right| compare_code_units(left.0, right.0));
    let macro_args = macro_entries
        .into_iter()
        .map(|(key, value)| match value {
            MacroValue::Boolean(true) => format!("-D{key}"),
            MacroValue::Boolean(false) => format!("-D{key}=false"),
            MacroValue::String(value) => format!("-D{key}={value}"),
        })
        .collect::<Vec<_>>();
    let include_paths = unique_paths(&unit.include_paths)?;
    let include_args = include_paths
        .iter()
        .map(|path| format!("-I{path}"))
        .collect::<Vec<_>>();
    let compiler = match unit.file.language {
        SourceLanguage::C => &context.tools.c,
        SourceLanguage::Asm => &context.tools.asm,
        _ => &context.tools.cxx,
    };
    let source_input = if unit.file.language == SourceLanguage::Ino {
        ActionInput {
            path: source.clone(),
            sha256: None,
            role: Some("generated-source".into()),
        }
    } else {
        ActionInput {
            path: unit.path.clone(),
            sha256: Some(unit.file.sha256.clone()),
            role: Some("source".into()),
        }
    };
    let mut inputs = vec![source_input.clone()];
    inputs.extend(
        context
            .additional_inputs
            .iter()
            .filter(|item| {
                if item.path == source_input.path {
                    return false;
                }
                item.role.as_deref() != Some("compiler-response-file")
                    || flags.iter().any(|flag| flag == &format!("@{}", item.path))
            })
            .cloned(),
    );
    let mut arguments = flags.clone();
    arguments.extend(macro_args);
    arguments.extend(include_args);
    arguments.extend(["-c".into(), source.clone(), "-o".into(), output.clone()]);
    let base = ActionBase {
        id: format!("{prefix}-{}", slug(&unit.path)),
        tool: compiler.clone(),
        inputs,
        outputs: vec![ActionOutput {
            path: output.clone(),
            kind: Some("object".into()),
            sha256: None,
        }],
        arguments,
        environment: BTreeMap::new(),
        dependencies,
        pack_dependencies: context.library_ids.to_vec(),
        pack_inputs: context.pack_inputs.to_vec(),
        resource_limits: context.limits.clone(),
        cache_key: String::new(),
    };
    let action_id = base.id.clone();
    actions.push(BuildAction::Compile {
        base,
        compile_unit: CompileUnit {
            language: match unit.file.language {
                SourceLanguage::C => CompileLanguage::C,
                SourceLanguage::Asm => CompileLanguage::Asm,
                _ => CompileLanguage::Cpp,
            },
            source,
            output: output.clone(),
            macros: unit.macros,
            include_paths,
            flags,
        },
    });
    Ok(ObjectRef {
        path: output,
        action_id,
    })
}

fn normalize_archive_operation(value: Option<&str>) -> Result<String> {
    let operation = value.unwrap_or("rcs");
    if operation.is_empty() || !operation.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return super::validation(format!("archive operation is invalid: {operation}"));
    }
    Ok(operation.into())
}

fn create_archive_action(
    id: &str,
    tool: &str,
    operation: &str,
    output: &str,
    objects: &[ObjectRef],
    flags: &[String],
    pack_dependencies: &[String],
    limits: Option<ActionResourceLimits>,
) -> BuildAction {
    let paths = objects
        .iter()
        .map(|object| object.path.clone())
        .collect::<Vec<_>>();
    let mut arguments = vec![operation.into(), output.into()];
    arguments.extend(paths.clone());
    arguments.extend(flags.to_vec());
    BuildAction::Archive {
        base: ActionBase {
            id: id.into(),
            tool: tool.into(),
            inputs: paths
                .iter()
                .map(|path| ActionInput {
                    path: path.clone(),
                    sha256: None,
                    role: Some("object".into()),
                })
                .collect(),
            outputs: vec![ActionOutput {
                path: output.into(),
                kind: Some("static-library".into()),
                sha256: None,
            }],
            arguments,
            environment: BTreeMap::new(),
            dependencies: objects
                .iter()
                .map(|object| object.action_id.clone())
                .collect(),
            pack_dependencies: pack_dependencies.to_vec(),
            pack_inputs: Vec::new(),
            resource_limits: limits,
            cache_key: String::new(),
        },
        archive: ArchiveSpec {
            objects: paths,
            output: output.into(),
            flags: flags.to_vec(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn create_link_action(
    tool: &str,
    elf_path: &str,
    objects: &[ObjectRef],
    archives: &[ArchiveRef],
    prebuilt: &[ActionInput],
    linker_script: Option<&str>,
    link_flags: &[String],
    tail_flags: &[String],
    linker_inputs: &[ActionInput],
    library_ids: &[String],
    pack_inputs: &[ActionPackInput],
    limits: Option<ActionResourceLimits>,
) -> BuildAction {
    let object_paths = objects
        .iter()
        .map(|object| object.path.clone())
        .collect::<Vec<_>>();
    let mut archive_paths = archives
        .iter()
        .map(|archive| archive.path.clone())
        .collect::<Vec<_>>();
    archive_paths.extend(prebuilt.iter().map(|item| item.path.clone()));
    let mut inputs = objects
        .iter()
        .map(|object| ActionInput {
            path: object.path.clone(),
            sha256: None,
            role: Some("object".into()),
        })
        .collect::<Vec<_>>();
    inputs.extend(archives.iter().map(|archive| ActionInput {
        path: archive.path.clone(),
        sha256: None,
        role: Some("static-library".into()),
    }));
    inputs.extend(prebuilt.iter().map(|item| {
        let mut item = item.clone();
        item.role.get_or_insert_with(|| "static-library".into());
        item
    }));
    if let Some(path) = linker_script {
        inputs.push(ActionInput {
            path: path.into(),
            sha256: None,
            role: Some("linker-script".into()),
        });
    }
    inputs.extend(linker_inputs.to_vec());
    let mut arguments = link_flags.to_vec();
    if let Some(path) = linker_script {
        arguments.extend(["-T".into(), path.into()]);
    }
    arguments.extend(object_paths.clone());
    arguments.extend(archives.iter().map(|archive| archive.path.clone()));
    arguments.extend(prebuilt.iter().map(|item| item.path.clone()));
    arguments.extend(tail_flags.to_vec());
    arguments.extend(["-o".into(), elf_path.into()]);
    let mut flags = link_flags.to_vec();
    flags.extend(tail_flags.to_vec());
    BuildAction::Link {
        base: ActionBase {
            id: "link-firmware".into(),
            tool: tool.into(),
            inputs,
            outputs: vec![ActionOutput {
                path: elf_path.into(),
                kind: Some("elf".into()),
                sha256: None,
            }],
            arguments,
            environment: BTreeMap::new(),
            dependencies: objects
                .iter()
                .map(|object| object.action_id.clone())
                .chain(archives.iter().map(|archive| archive.action_id.clone()))
                .collect(),
            pack_dependencies: library_ids.to_vec(),
            pack_inputs: pack_inputs.to_vec(),
            resource_limits: limits,
            cache_key: String::new(),
        },
        link: super::LinkSpec {
            objects: object_paths,
            archives: archive_paths,
            output: elf_path.into(),
            linker_script: linker_script.map(str::to_owned),
            flags,
        },
    }
}

fn order_archives(archives: Vec<ArchiveRef>, packs: &[LibraryPackRef]) -> Vec<ArchiveRef> {
    let by_archive = archives
        .iter()
        .filter_map(|archive| {
            archive
                .pack_id
                .as_ref()
                .map(|id| (id.clone(), archive.clone()))
        })
        .collect::<HashMap<_, _>>();
    let by_pack = packs
        .iter()
        .map(|pack| (pack.id.as_str(), pack))
        .collect::<HashMap<_, _>>();
    let mut visited = HashSet::new();
    let mut ordered = Vec::new();
    fn visit(
        id: &str,
        by_pack: &HashMap<&str, &LibraryPackRef>,
        by_archive: &HashMap<String, ArchiveRef>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<ArchiveRef>,
    ) {
        if !visited.insert(id.into()) {
            return;
        }
        if let Some(pack) = by_pack.get(id) {
            let mut deps = pack
                .dependencies
                .iter()
                .map(|dep| dep.id.as_str())
                .collect::<Vec<_>>();
            deps.sort_by(|left, right| compare_code_units(left, right));
            for dep in deps {
                visit(dep, by_pack, by_archive, visited, ordered);
            }
        }
        if let Some(archive) = by_archive.get(id) {
            ordered.push(archive.clone());
        }
    }
    for pack in packs {
        visit(&pack.id, &by_pack, &by_archive, &mut visited, &mut ordered);
    }
    if let Some(core) = archives
        .into_iter()
        .find(|archive| archive.pack_id.is_none())
    {
        ordered.push(core);
    }
    ordered
}

fn library_dependency_closure(id: &str, packs: &[LibraryPackRef]) -> Result<Vec<String>> {
    let by_id = packs
        .iter()
        .map(|pack| (pack.id.as_str(), pack))
        .collect::<HashMap<_, _>>();
    let mut ids = BTreeSet::new();
    fn visit(
        id: &str,
        by_id: &HashMap<&str, &LibraryPackRef>,
        ids: &mut BTreeSet<String>,
    ) -> Result<()> {
        if ids.contains(id) {
            return Ok(());
        }
        let Some(pack) = by_id.get(id) else {
            return super::validation(format!(
                "library source Pack references missing dependency: {id}"
            ));
        };
        ids.insert(id.into());
        for dependency in &pack.dependencies {
            visit(&dependency.id, by_id, ids)?;
        }
        Ok(())
    }
    visit(id, &by_id, &mut ids)?;
    let mut result = ids.into_iter().collect::<Vec<_>>();
    result.sort_by(|left, right| compare_code_units(left, right));
    Ok(result)
}

fn normalize_transforms(
    values: &[PlannerTransformInput],
    target: &TargetSpec,
    output_root: &str,
) -> Result<Vec<PlannerTransformSpec>> {
    if !values.is_empty() {
        return Ok(values
            .iter()
            .map(|value| match value {
                PlannerTransformInput::Format(format) => PlannerTransformSpec {
                    id: None,
                    product_id: None,
                    lifecycle: PlannerTransformLifecycle::Project,
                    pack_dependencies: None,
                    pack_inputs: Vec::new(),
                    format: *format,
                    input: None,
                    input_sha256: None,
                    inputs: None,
                    output: None,
                    output_sha256: None,
                    flags: Vec::new(),
                    tool: None,
                    arguments: None,
                    dependencies: None,
                    offset: None,
                },
                PlannerTransformInput::Spec(spec) => spec.clone(),
            })
            .collect());
    }
    let architecture = target
        .fqbn
        .split(':')
        .nth(1)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let format = if architecture.contains("avr") {
        TransformFormat::Hex
    } else {
        TransformFormat::Bin
    };
    Ok(vec![PlannerTransformSpec {
        id: None,
        product_id: None,
        lifecycle: PlannerTransformLifecycle::Project,
        pack_dependencies: None,
        pack_inputs: Vec::new(),
        format,
        input: None,
        input_sha256: None,
        inputs: None,
        output: Some(default_transform_output(output_root, format)?),
        output_sha256: None,
        flags: Vec::new(),
        tool: None,
        arguments: None,
        dependencies: None,
        offset: None,
    }])
}

fn resolve_transform_inputs(
    spec: &PlannerTransformSpec,
    elf_path: &str,
) -> Result<(String, Vec<ActionInput>)> {
    let mut inputs = match &spec.inputs {
        Some(inputs) if inputs.is_empty() => {
            return super::validation(format!(
                "transform {} inputs must not be empty",
                spec.id
                    .as_deref()
                    .unwrap_or_else(|| transform_name(spec.format))
            ));
        }
        Some(inputs) => inputs.clone(),
        None => Vec::new(),
    };
    let primary = spec
        .input
        .clone()
        .or_else(|| inputs.first().map(|input| input.path.clone()))
        .unwrap_or_else(|| elf_path.to_owned());
    let primary = normalize_path(&primary, "transform input")?;

    let mut paths = HashSet::new();
    for input in &mut inputs {
        input.path = normalize_path(&input.path, "transform input")?;
        if !paths.insert(input.path.clone()) {
            return super::validation(format!("transform has duplicate input: {}", input.path));
        }
    }
    let primary_index = inputs.iter().position(|input| input.path == primary);
    match primary_index {
        Some(index) => {
            if let Some(legacy_sha256) = &spec.input_sha256 {
                match &inputs[index].sha256 {
                    Some(sha256) if sha256 != legacy_sha256 => {
                        return super::validation(format!(
                            "transform input SHA-256 conflicts for {primary}"
                        ));
                    }
                    Some(_) => {}
                    None => inputs[index].sha256 = Some(legacy_sha256.clone()),
                }
            }
        }
        None if inputs.is_empty() => inputs.push(ActionInput {
            path: primary.clone(),
            sha256: spec.input_sha256.clone(),
            role: None,
        }),
        None => {
            return super::validation(format!(
                "transform inputs do not contain primary input: {primary}"
            ));
        }
    }

    for input in &mut inputs {
        if input.role.is_none() {
            input.role = Some(
                if input.path == elf_path {
                    "elf"
                } else {
                    "transform-input"
                }
                .into(),
            );
        }
    }
    Ok((primary, inputs))
}

fn normalize_transform_product_id(value: &str) -> Result<String> {
    normalize_transform_identity(value, true, "product id")
}

fn normalize_transform_action_id(value: &str) -> Result<String> {
    normalize_transform_identity(value, false, "action id")
}

fn normalize_transform_identity(value: &str, allow_digit: bool, label: &str) -> Result<String> {
    let normalized = value.trim();
    let mut characters = normalized.chars();
    let valid_first = matches!(characters.next(), Some(first)
        if first.is_ascii_lowercase() || (allow_digit && first.is_ascii_digit()));
    let valid_rest = characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')
    });
    if !valid_first || !valid_rest {
        return super::validation(format!("transform {label} is invalid: {value}"));
    }
    Ok(normalized.to_owned())
}

fn default_transform_output(root: &str, format: TransformFormat) -> Result<String> {
    let extension = match format {
        TransformFormat::BootApp0 => "boot_app0.bin",
        TransformFormat::Bootloader => "bootloader.bin",
        TransformFormat::Partition => "partitions.bin",
        _ => transform_name(format),
    };
    join_path(root, &format!("firmware.{extension}"))
}

fn transform_arguments(
    format: TransformFormat,
    input: &str,
    output: &str,
    flags: &[String],
) -> Vec<String> {
    let output_format = match format {
        TransformFormat::Hex => "ihex",
        TransformFormat::Bin => "binary",
        _ => transform_name(format),
    };
    let mut arguments = vec![
        "-O".into(),
        output_format.into(),
        input.into(),
        output.into(),
    ];
    arguments.extend(flags.to_vec());
    arguments
}

fn transform_name(format: TransformFormat) -> &'static str {
    match format {
        TransformFormat::Elf => "elf",
        TransformFormat::Bin => "bin",
        TransformFormat::Hex => "hex",
        TransformFormat::Bootloader => "bootloader",
        TransformFormat::Partition => "partition",
        TransformFormat::BootApp0 => "boot-app0",
        TransformFormat::Other => "other",
    }
}

fn compile_flags(language: SourceLanguage, flags: &PlannerCompilerFlags) -> Vec<String> {
    let mut result = flags.common.clone();
    result.extend(match language {
        SourceLanguage::C => flags.c.clone(),
        SourceLanguage::Asm => flags.asm.clone(),
        _ => flags.cxx.clone(),
    });
    result
}

fn merge_flags(
    left: &PlannerCompilerFlags,
    right: Option<&PlannerCompilerFlags>,
) -> PlannerCompilerFlags {
    let right = right.cloned().unwrap_or_default();
    PlannerCompilerFlags {
        c: [left.c.clone(), right.c].concat(),
        cxx: [left.cxx.clone(), right.cxx].concat(),
        asm: [left.asm.clone(), right.asm].concat(),
        common: [left.common.clone(), right.common].concat(),
    }
}

fn merge_macros(
    left: &BTreeMap<String, MacroValue>,
    right: Option<&BTreeMap<String, MacroValue>>,
) -> BTreeMap<String, MacroValue> {
    let mut result = left.clone();
    if let Some(right) = right {
        result.extend(right.clone());
    }
    result
}

fn tree_root(value: Option<&str>, fallback: &str) -> Result<String> {
    normalize_path(value.unwrap_or(fallback), "pack root")
}
fn join_path(left: &str, right: &str) -> Result<String> {
    normalize_path(&format!("{left}/{right}"), "logical path")
}
fn source_directory(path: &str) -> Option<String> {
    path.rsplit_once('/')
        .map(|(dir, _)| dir.to_owned())
        .filter(|dir| !dir.is_empty())
}
fn compare_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
fn without_extension(path: &str) -> &str {
    path.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(path)
}
fn is_compilable(language: SourceLanguage) -> bool {
    matches!(
        language,
        SourceLanguage::Ino | SourceLanguage::C | SourceLanguage::Cpp | SourceLanguage::Asm
    )
}
fn is_include_fragment(path: &str) -> bool {
    matches!(
        path.rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .as_deref(),
        Some("inc" | "ipp" | "tpp")
    )
}
fn unique_paths(paths: &[String]) -> Result<Vec<String>> {
    let mut paths = paths
        .iter()
        .map(|path| normalize_path(path, "path"))
        .collect::<Result<BTreeSet<_>>>()?
        .into_iter()
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| compare_code_units(left, right));
    Ok(paths)
}
fn action_id(action: &BuildAction) -> &str {
    match action {
        BuildAction::Compile { base, .. }
        | BuildAction::Archive { base, .. }
        | BuildAction::Link { base, .. }
        | BuildAction::Transform { base, .. } => &base.id,
    }
}

fn slug(value: &str) -> String {
    let clean = value
        .replace('\\', "/")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let clean = clean.trim_matches('.');
    format!(
        "{}-{}",
        if clean.is_empty() { "source" } else { clean },
        &sha256_hex(value.as_bytes())[..8]
    )
}

/// Resolve legacy private headers by their full include path.
///
/// Only uniquely referenced nested directories become low-priority include
/// roots. This avoids exposing every private directory as `-I`, where names
/// such as `assert.h` could shadow platform or standard headers.
/// Qualified paths compete by their complete suffix; bare filenames still
/// require a globally unique basename.
fn resolve_private_library_include_paths(
    libraries: &[PlannerLibraryInput],
) -> Result<HashMap<String, Vec<String>>> {
    struct Tree {
        pack_id: String,
        root: String,
        files: Vec<ProjectFile>,
        visible_roots: Vec<String>,
    }

    let mut trees = Vec::new();
    for library in libraries {
        let root = tree_root(
            library.root_path.as_deref(),
            &format!("packs/libraries/{}", slug(&library.pack.id)),
        )?;
        let files = resolve_project(library.files.clone())?.files;
        let mut visible_roots = vec![root.clone()];
        for path in &library.include_paths {
            visible_roots.push(join_path(&root, path)?);
        }
        trees.push(Tree {
            pack_id: library.pack.id.clone(),
            root,
            files,
            visible_roots: unique_paths(&visible_roots)?,
        });
    }

    let all_files = trees
        .iter()
        .flat_map(|tree| {
            tree.files.iter().map(move |file| {
                (
                    tree,
                    file,
                    join_path(&tree.root, &file.path).expect("normalized library path"),
                )
            })
        })
        .collect::<Vec<_>>();
    let paths = all_files
        .iter()
        .map(|(_, _, path)| path.as_str())
        .collect::<HashSet<_>>();
    let visible_roots = unique_paths(
        &trees
            .iter()
            .flat_map(|tree| tree.visible_roots.clone())
            .collect::<Vec<_>>(),
    )?;
    let mut result: HashMap<String, BTreeSet<String>> = HashMap::new();

    for tree in &trees {
        for owner in &tree.files {
            for (quoted, include) in source_includes(&owner.content) {
                let include = include.strip_prefix("./").unwrap_or(&include);
                if include.is_empty()
                    || include.starts_with('/')
                    || include.contains('\0')
                    || include.split('/').any(|segment| segment == "..")
                {
                    continue;
                }

                if quoted {
                    let owner_root = source_directory(&owner.path)
                        .map(|directory| join_path(&tree.root, &directory))
                        .transpose()?
                        .unwrap_or_else(|| tree.root.clone());
                    if resolve_include(&owner_root, include)
                        .is_some_and(|candidate| paths.contains(candidate.as_str()))
                    {
                        continue;
                    }
                }

                if visible_roots.iter().any(|root| {
                    resolve_include(root, include)
                        .is_some_and(|candidate| paths.contains(candidate.as_str()))
                }) {
                    continue;
                }

                let suffix = format!("/{include}");
                let matches = all_files
                    .iter()
                    .filter_map(|(_, _, path)| path.strip_suffix(&suffix))
                    .collect::<Vec<_>>();
                if matches.len() != 1
                    || matches[0].is_empty()
                    || visible_roots.iter().any(|root| root == matches[0])
                {
                    continue;
                }
                result
                    .entry(tree.pack_id.clone())
                    .or_default()
                    .insert(matches[0].to_owned());
            }
        }
    }

    Ok(result
        .into_iter()
        .map(|(pack_id, paths)| {
            let mut paths = paths.into_iter().collect::<Vec<_>>();
            paths.sort_by(|left, right| compare_code_units(left, right));
            (pack_id, paths)
        })
        .collect())
}

fn find_text_included_sources(files: &[ProjectFile], include_paths: &[String]) -> HashSet<String> {
    let by_path = files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<HashMap<_, _>>();
    let mut included = HashSet::new();
    for owner in files {
        for (quoted, include) in source_includes(&owner.content) {
            let lower = include.to_ascii_lowercase();
            if ![".c", ".cc", ".cpp", ".cxx"]
                .iter()
                .any(|ext| lower.ends_with(ext))
            {
                continue;
            }
            let mut candidates = Vec::new();
            if quoted {
                candidates.push(resolve_include(
                    source_directory(&owner.path).as_deref().unwrap_or(""),
                    &include,
                ));
            }
            candidates.push(resolve_include("", &include));
            candidates.extend(
                include_paths
                    .iter()
                    .map(|root| resolve_include(root, &include)),
            );
            if let Some(path) = candidates
                .into_iter()
                .flatten()
                .find(|path| by_path.contains_key(path.as_str()))
            {
                if path != owner.path {
                    included.insert(path);
                }
            }
        }
    }
    included
}

fn referenced_project_headers(
    library_files: &[ProjectFile],
    project_files: &[ProjectFile],
) -> Vec<ActionInput> {
    let headers = project_files
        .iter()
        .filter(|file| file.language == SourceLanguage::Header)
        .collect::<Vec<_>>();
    let mut referenced = BTreeSet::new();
    for file in library_files {
        for (_, include) in source_includes(&file.content) {
            let matches = headers
                .iter()
                .filter(|header| {
                    header.path == include || header.path.ends_with(&format!("/{include}"))
                })
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                referenced.insert(matches[0].path.clone());
            }
        }
    }
    headers
        .into_iter()
        .filter(|header| referenced.contains(&header.path))
        .map(|header| ActionInput {
            path: header.path.clone(),
            sha256: Some(header.sha256.clone()),
            role: Some("project-header".into()),
        })
        .collect()
}

fn source_includes(source: &str) -> Vec<(bool, String)> {
    let mut result = Vec::new();
    for line in strip_comments(source).lines() {
        let line = line.trim_start();
        let Some(rest) = line
            .strip_prefix('#')
            .map(str::trim_start)
            .and_then(|line| line.strip_prefix("include"))
            .map(str::trim_start)
        else {
            continue;
        };
        let (quoted, end) = if rest.starts_with('"') {
            (true, '"')
        } else if rest.starts_with('<') {
            (false, '>')
        } else {
            continue;
        };
        if let Some(index) = rest[1..].find(end) {
            result.push((quoted, rest[1..index + 1].replace('\\', "/")));
        }
    }
    result
}

fn strip_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut block = false;
    while let Some(ch) = chars.next() {
        if block {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                output.push_str("  ");
                block = false;
            } else {
                output.push(if ch == '\n' { '\n' } else { ' ' });
            }
        } else if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            output.push_str("  ");
            while let Some(ch) = chars.next() {
                if ch == '\n' {
                    output.push('\n');
                    break;
                } else {
                    output.push(' ');
                }
            }
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            output.push_str("  ");
            block = true;
        } else {
            output.push(ch);
        }
    }
    output
}

fn resolve_include(root: &str, include: &str) -> Option<String> {
    if include.is_empty() || include.starts_with('/') || include.contains('\0') {
        return None;
    }
    let mut segments = root
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for segment in include.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            _ => segments.push(segment.into()),
        }
    }
    Some(segments.join("/"))
}

fn sketch_function_lines(source: &str) -> Vec<u64> {
    let source = source.chars().collect::<Vec<_>>();
    let scanned = scan_sketch_source(&source);
    let mut lines = Vec::new();
    let mut brace_depth = 0_u64;
    let mut index = 0;

    while index < scanned.masked.len() {
        let character = scanned.masked[index];
        if character == '{' {
            brace_depth += 1;
            index += 1;
            continue;
        }
        if character == '}' {
            brace_depth = brace_depth.saturating_sub(1);
            index += 1;
            continue;
        }
        if brace_depth != 0 || !is_sketch_ident_start(character) {
            index += 1;
            continue;
        }

        let mut ident_end = index;
        while ident_end < scanned.masked.len() && is_sketch_ident_char(scanned.masked[ident_end]) {
            ident_end += 1;
        }
        let ident = scanned.masked[index..ident_end].iter().collect::<String>();
        let mut open = ident_end;
        while open < scanned.masked.len() && scanned.masked[open].is_whitespace() {
            open += 1;
        }
        if scanned.masked.get(open) != Some(&'(') || is_control_keyword(&ident) {
            index = ident_end;
            continue;
        }
        let Some(close) = match_sketch_paren(&scanned.masked, open) else {
            index = ident_end;
            continue;
        };
        if classify_after_sketch_params(&scanned.masked, close + 1)
            != Some(SketchFunctionKind::Definition)
        {
            index = ident_end;
            continue;
        }

        let declaration_start =
            find_sketch_declaration_start(&scanned.masked, index, &scanned.directive_ends);
        let return_type = scanned.masked[declaration_start..index]
            .iter()
            .collect::<String>();
        let trimmed_return_type = return_type.trim();
        let params = &scanned.masked[open..=close];
        if trimmed_return_type.is_empty()
            || rejected_sketch_return_type(&return_type)
            || ends_with_auto_keyword(trimmed_return_type)
            || has_sketch_default_args(params)
            || ident == "main"
        {
            index = ident_end;
            continue;
        }

        lines.push(offset_to_sketch_line(&scanned.line_starts, declaration_start) as u64);
        index = ident_end;
    }
    lines
}

struct SketchScan {
    masked: Vec<char>,
    line_starts: Vec<usize>,
    directive_ends: Vec<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SketchFunctionKind {
    Definition,
    Declaration,
}

fn scan_sketch_source(source: &[char]) -> SketchScan {
    let mut masked = source.to_vec();
    let mut line_starts = vec![0];
    for (index, character) in source.iter().enumerate() {
        if *character == '\n' {
            line_starts.push(index + 1);
        }
    }
    let mut directive_ends = Vec::new();
    let mut index = 0;
    let mut at_line_start = true;

    while index < source.len() {
        let character = source[index];
        let next = source.get(index + 1).copied().unwrap_or('\0');

        if character == '/' && next == '/' {
            let start = index;
            index += 2;
            while index < source.len() {
                if source[index] == '\\' {
                    let mut continuation = index + 1;
                    if source.get(continuation) == Some(&'\r') {
                        continuation += 1;
                    }
                    if source.get(continuation) == Some(&'\n') {
                        index = continuation + 1;
                        continue;
                    }
                }
                if source[index] == '\n' {
                    break;
                }
                index += 1;
            }
            mask_sketch_range(&mut masked, source, start, index);
            at_line_start = false;
            continue;
        }

        if character == '/' && next == '*' {
            let start = index;
            index += 2;
            while index < source.len()
                && !(source[index] == '*' && source.get(index + 1).copied().unwrap_or('\0') == '/')
            {
                index += 1;
            }
            index = (index + 2).min(source.len());
            mask_sketch_range(&mut masked, source, start, index);
            at_line_start = false;
            continue;
        }

        let raw_prefix = character == 'R'
            || (matches!(character, 'u' | 'U' | 'L') && next == 'R')
            || (character == 'u'
                && next == '8'
                && source.get(index + 2).copied().unwrap_or('\0') == 'R');
        if raw_prefix {
            let r_position = if character == 'R' {
                Some(index)
            } else {
                source[index..]
                    .iter()
                    .position(|candidate| *candidate == 'R')
                    .map(|offset| index + offset)
            };
            if let Some(r_position) = r_position {
                let quote_position = r_position + 1;
                let previous = index
                    .checked_sub(1)
                    .and_then(|position| source.get(position))
                    .copied()
                    .unwrap_or('\0');
                if source.get(quote_position) == Some(&'"') && !is_sketch_ident_char(previous) {
                    let delimiter_start = quote_position + 1;
                    let mut delimiter_end = delimiter_start;
                    while delimiter_end < source.len()
                        && source[delimiter_end] != '('
                        && delimiter_end - delimiter_start <= 16
                    {
                        delimiter_end += 1;
                    }
                    if source.get(delimiter_end) == Some(&'(') {
                        let mut terminator = vec![')'];
                        terminator.extend_from_slice(&source[delimiter_start..delimiter_end]);
                        terminator.push('"');
                        let stop = find_sketch_sequence(source, &terminator, delimiter_end + 1)
                            .map(|position| position + terminator.len())
                            .unwrap_or(source.len());
                        mask_sketch_range(&mut masked, source, index, stop);
                        index = stop;
                        at_line_start = false;
                        continue;
                    }
                }
            }
        }

        if matches!(character, '"' | '\'') {
            let quote = character;
            let start = index;
            index += 1;
            while index < source.len() {
                let current = source[index];
                if current == '\\' {
                    index = (index + 2).min(source.len());
                    continue;
                }
                if current == quote {
                    index += 1;
                    break;
                }
                if current == '\n' {
                    break;
                }
                index += 1;
            }
            mask_sketch_range(&mut masked, source, start, index);
            at_line_start = false;
            continue;
        }

        if character == '#' && at_line_start {
            let start = index;
            let mut end = index + 1;
            while end < source.len() && matches!(source[end], ' ' | '\t') {
                end += 1;
            }
            while end < source.len() && is_sketch_ident_char(source[end]) {
                end += 1;
            }
            while end < source.len() {
                if source[end] == '\\' {
                    let mut continuation = end + 1;
                    if source.get(continuation) == Some(&'\r') {
                        continuation += 1;
                    }
                    if source.get(continuation) == Some(&'\n') {
                        end = continuation + 1;
                        continue;
                    }
                }
                if source[end] == '\n' {
                    break;
                }
                end += 1;
            }
            directive_ends.push(end);
            mask_sketch_range(&mut masked, source, start, end);
            index = end;
            at_line_start = false;
            continue;
        }

        if character == '\n' {
            at_line_start = true;
        } else if !matches!(character, ' ' | '\t' | '\r') {
            at_line_start = false;
        }
        index += 1;
    }

    SketchScan {
        masked,
        line_starts,
        directive_ends,
    }
}

fn mask_sketch_range(masked: &mut [char], source: &[char], start: usize, end: usize) {
    for index in start..end {
        masked[index] = if source[index] == '\n' { '\n' } else { ' ' };
    }
}

fn find_sketch_sequence(source: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty()
        || needle.len() > source.len()
        || from > source.len().saturating_sub(needle.len())
    {
        return None;
    }
    (from..=source.len() - needle.len())
        .find(|position| &source[*position..*position + needle.len()] == needle)
}

fn is_sketch_ident_start(character: char) -> bool {
    character.is_ascii_alphabetic() || matches!(character, '_' | '$')
}

fn is_sketch_ident_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '$')
}

fn is_control_keyword(value: &str) -> bool {
    matches!(
        value,
        "if" | "else"
            | "for"
            | "while"
            | "do"
            | "switch"
            | "case"
            | "default"
            | "return"
            | "sizeof"
            | "catch"
            | "try"
            | "throw"
            | "new"
            | "delete"
            | "alignof"
            | "decltype"
            | "typeid"
            | "static_assert"
            | "noexcept"
            | "and"
            | "or"
            | "not"
            | "xor"
            | "bitand"
            | "bitor"
            | "compl"
    )
}

fn match_sketch_paren(masked: &[char], open: usize) -> Option<usize> {
    let mut depth = 0_u64;
    for (index, character) in masked.iter().enumerate().skip(open) {
        if *character == '(' {
            depth += 1;
        } else if *character == ')' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn classify_after_sketch_params(masked: &[char], from: usize) -> Option<SketchFunctionKind> {
    let mut index = from;
    loop {
        while index < masked.len() && masked[index].is_whitespace() {
            index += 1;
        }
        let character = *masked.get(index)?;
        if character == '{' {
            return Some(SketchFunctionKind::Definition);
        }
        if character == ';' {
            return Some(SketchFunctionKind::Declaration);
        }
        if character == '-' && masked.get(index + 1) == Some(&'>') {
            return None;
        }
        if sketch_starts_with(masked, index, "__attribute__") {
            let open = masked[index..]
                .iter()
                .position(|candidate| *candidate == '(')
                .map(|offset| index + offset)?;
            index = match_sketch_paren(masked, open)? + 1;
            continue;
        }
        if character == '[' && masked.get(index + 1) == Some(&'[') {
            index = find_sketch_sequence(masked, &[']', ']'], index)? + 2;
            continue;
        }

        let mut end = index;
        while end < masked.len() && is_sketch_ident_char(masked[end]) {
            end += 1;
        }
        let word = masked[index..end].iter().collect::<String>();
        if matches!(
            word.as_str(),
            "const" | "volatile" | "noexcept" | "override" | "final" | "mutable"
        ) {
            index = end;
            if word == "noexcept" {
                let mut expression = index;
                while expression < masked.len() && masked[expression].is_whitespace() {
                    expression += 1;
                }
                if masked.get(expression) == Some(&'(') {
                    index = match_sketch_paren(masked, expression)? + 1;
                }
            }
            continue;
        }
        return None;
    }
}

fn sketch_starts_with(source: &[char], from: usize, value: &str) -> bool {
    source
        .get(from..from + value.chars().count())
        .is_some_and(|candidate| candidate.iter().copied().eq(value.chars()))
}

fn find_sketch_declaration_start(
    masked: &[char],
    ident_start: usize,
    directive_ends: &[usize],
) -> usize {
    let barrier = directive_ends
        .iter()
        .copied()
        .filter(|end| *end <= ident_start)
        .max()
        .unwrap_or(0);
    let mut start = barrier;
    let mut cursor = ident_start;
    while cursor > barrier {
        cursor -= 1;
        if matches!(masked[cursor], ';' | '}' | '{' | ':') {
            start = cursor + 1;
            break;
        }
    }
    while start < ident_start && masked[start].is_whitespace() {
        start += 1;
    }
    start
}

fn rejected_sketch_return_type(value: &str) -> bool {
    [
        "template",
        "extern",
        "typedef",
        "using",
        "namespace",
        "class",
        "struct",
        "union",
        "enum",
        "operator",
        "friend",
        "::",
        "~",
    ]
    .iter()
    .any(|keyword| value.contains(keyword))
}

fn ends_with_auto_keyword(value: &str) -> bool {
    let Some(prefix) = value.strip_suffix("auto") else {
        return false;
    };
    match prefix.chars().next_back() {
        Some(character) => !(character.is_ascii_alphanumeric() || character == '_'),
        None => true,
    }
}

fn has_sketch_default_args(params: &[char]) -> bool {
    let mut start = 0;
    while start < params.len() && params[start].is_whitespace() {
        start += 1;
    }
    if params.get(start) == Some(&'(') {
        start += 1;
    }
    let mut end = params.len();
    while end > start && params[end - 1].is_whitespace() {
        end -= 1;
    }
    if end > start && params[end - 1] == ')' {
        end -= 1;
    }

    let mut depth = 0_i64;
    for index in start..end {
        match params[index] {
            '(' | '[' | '<' => depth += 1,
            ')' | ']' | '>' => depth -= 1,
            '=' if depth == 0 => {
                let previous = index
                    .checked_sub(1)
                    .and_then(|position| params.get(position))
                    .copied();
                let next = params.get(index + 1);
                if !matches!(previous, Some('=' | '!' | '<' | '>')) && next != Some(&'=') {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn offset_to_sketch_line(line_starts: &[usize], offset: usize) -> usize {
    match line_starts.binary_search(&offset) {
        Ok(index) => index + 1,
        Err(index) => index,
    }
}

struct ArduinoSketchComposition {
    source: String,
    line_origins: HashMap<u64, (String, u64)>,
}

fn compose_arduino_sketch(sketches: &[ProjectFile]) -> Result<ArduinoSketchComposition> {
    if sketches.is_empty() {
        return super::validation("Arduino sketch bundle must not be empty");
    }
    let normalized = sketches
        .iter()
        .map(|sketch| {
            (
                sketch.path.clone(),
                normalize_sketch_source(&sketch.content),
            )
        })
        .collect::<Vec<_>>();
    if normalized
        .iter()
        .all(|(_, source)| source.trim().is_empty())
    {
        return Ok(ArduinoSketchComposition {
            source: String::new(),
            line_origins: HashMap::new(),
        });
    }

    let mut source = normalized[0].1.clone();
    let mut line_origins = HashMap::new();
    add_sketch_line_origins(&mut line_origins, 1, &normalized[0].0, &normalized[0].1);
    for (path, content) in normalized.iter().skip(1) {
        if !source.is_empty() && !source.ends_with('\n') {
            source.push('\n');
        }
        let content_start_line = source.bytes().filter(|byte| *byte == b'\n').count() as u64 + 2;
        source.push_str(&format!(
            "#line 1 \"{}\"\n{}",
            escape_line_file(path),
            content
        ));
        add_sketch_line_origins(&mut line_origins, content_start_line, path, content);
    }
    Ok(ArduinoSketchComposition {
        source,
        line_origins,
    })
}

fn normalize_sketch_source(source: &str) -> String {
    source
        .strip_prefix('\u{feff}')
        .unwrap_or(source)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn escape_line_file(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

fn add_sketch_line_origins(
    origins: &mut HashMap<u64, (String, u64)>,
    generated_start_line: u64,
    source_file: &str,
    source: &str,
) {
    for index in 0..source.split('\n').count() as u64 {
        origins.insert(
            generated_start_line + index,
            (source_file.to_owned(), index + 1),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ActionPackInputKind, BoardKind, BoardPackRef, LibraryKind, LibraryPackSet, PlatformKind,
        PlatformPackRef, ToolchainKind, ToolchainPackRef,
    };

    fn planner_input() -> BuildPlannerInput {
        let board = BoardPackRef {
            kind: BoardKind::Board,
            id: "board:test".into(),
            version: "1".into(),
            sha256: "b".repeat(64),
            fqbn: "esp32:esp32:test".into(),
            variant: "test".into(),
        };
        let library = LibraryPackRef {
            kind: LibraryKind::Library,
            id: "library:demo".into(),
            version: "1".into(),
            sha256: "d".repeat(64),
            name: "Demo".into(),
            architectures: vec!["*".into()],
            license: None,
            manifest: BTreeMap::new(),
            dependencies: Vec::new(),
        };
        BuildPlannerInput {
            project: ProjectInput::Files(vec![super::super::ProjectFileInput {
                path: "main.ino".into(),
                content: "void setup() {}\nvoid loop() {}\n".into(),
                language: None,
                generated: None,
            }]),
            project_compile_paths: Vec::new(),
            target: TargetInput {
                fqbn: board.fqbn.clone(),
                options: BTreeMap::new(),
                board_pack: board.clone(),
            },
            packs: BuildPacks {
                toolchain: ToolchainPackRef {
                    kind: ToolchainKind::Toolchain,
                    id: "toolchain:test".into(),
                    version: "1".into(),
                    sha256: "a".repeat(64),
                    abi: "test".into(),
                    instruction_set: "test".into(),
                },
                platform: PlatformPackRef {
                    kind: PlatformKind::Platform,
                    id: "platform:test".into(),
                    version: "1".into(),
                    sha256: "c".repeat(64),
                    platform: "test".into(),
                },
                board,
                libraries: LibraryPackSet {
                    roots: vec![library.id.clone()],
                    packs: vec![library.clone()],
                },
            },
            platform: None,
            libraries: Vec::new(),
            tools: PlannerToolNames::default(),
            macros: BTreeMap::new(),
            include_paths: Vec::new(),
            flags: PlannerCompilerFlags::default(),
            compiler_inputs: Vec::new(),
            compiler_pack_inputs: Vec::new(),
            linker_flags: Vec::new(),
            linker_inputs: Vec::new(),
            linker_pack_inputs: Vec::new(),
            linker_tail_flags: Vec::new(),
            archive_operation: None,
            archive_flags: Vec::new(),
            preprocess_flags: Vec::new(),
            linker_script: None,
            transforms: Vec::new(),
            output_root: None,
            resource_limits: PlannerResourceLimits::default(),
        }
    }

    fn project_file(path: &str, content: &str) -> super::super::ProjectFileInput {
        super::super::ProjectFileInput {
            path: path.into(),
            content: content.into(),
            language: None,
            generated: None,
        }
    }

    fn path_qualified_private_include_fixture(decoy_header_path: &str) -> Vec<PlannerLibraryInput> {
        let input = planner_input();
        let primary = input.packs.libraries.packs[0].clone();
        let mut decoy = primary.clone();
        decoy.id = "library:private-header-decoy".into();
        decoy.name = "Private Header Decoy".into();
        decoy.sha256 = "e".repeat(64);

        vec![
            PlannerLibraryInput {
                pack: primary,
                files: ProjectInput::Files(vec![
                    project_file("src/Demo.cpp", "#include <drivers/Foo.h>\n"),
                    project_file("src/private/drivers/Foo.h", "#pragma once\n"),
                ]),
                include_paths: vec!["src".into()],
                macros: BTreeMap::new(),
                flags: PlannerCompilerFlags::default(),
                root_path: Some("packs/libraries/demo".into()),
            },
            PlannerLibraryInput {
                pack: decoy,
                files: ProjectInput::Files(vec![
                    project_file("src/Decoy.cpp", "int decoy = 0;\n"),
                    project_file(decoy_header_path, "#pragma once\n"),
                ]),
                include_paths: vec!["src".into()],
                macros: BTreeMap::new(),
                flags: PlannerCompilerFlags::default(),
                root_path: Some("packs/libraries/decoy".into()),
            },
        ]
    }

    #[test]
    fn plans_and_keys_a_complete_sketch_graph() {
        let ir = plan_build_ir(planner_input()).unwrap();
        assert_eq!(ir.graph.actions.len(), 4);
        assert!(ir
            .graph
            .actions
            .iter()
            .all(|action| action_id(action).len() > 3));
        assert!(ir.graph.actions.iter().all(|action| match action {
            BuildAction::Compile { base, .. }
            | BuildAction::Archive { base, .. }
            | BuildAction::Link { base, .. }
            | BuildAction::Transform { base, .. } => base.cache_key.len() == 64,
        }));
        assert_eq!(ir.diagnostic_map.entries.len(), 2);
    }

    #[test]
    fn uses_the_planned_archive_operation_without_leaking_compile_flags() {
        let mut input = planner_input();
        let pack = input.packs.libraries.packs[0].clone();
        input.archive_operation = Some("crs".into());
        input.archive_flags = vec!["D".into()];
        input.libraries.push(PlannerLibraryInput {
            pack,
            files: ProjectInput::Files(vec![project_file(
                "src/Demo.cpp",
                "int demo() { return 1; }\n",
            )]),
            include_paths: vec!["src".into()],
            macros: BTreeMap::new(),
            flags: PlannerCompilerFlags {
                common: vec!["-fdata-sections".into()],
                ..PlannerCompilerFlags::default()
            },
            root_path: None,
        });

        let plan = plan_build_actions(input).unwrap();
        let archive = plan
            .actions
            .iter()
            .find_map(|action| match action {
                BuildAction::Archive { base, archive } => Some((base, archive)),
                _ => None,
            })
            .unwrap();
        assert_eq!(archive.0.arguments.first().map(String::as_str), Some("crs"));
        assert_eq!(archive.1.flags, ["D"]);
        assert!(!archive
            .0
            .arguments
            .iter()
            .any(|flag| flag == "-fdata-sections"));
    }

    #[test]
    fn plans_arduino_tabs_as_one_keyed_translation_unit() {
        let mut input = planner_input();
        input.project = ProjectInput::Files(vec![
            super::super::ProjectFileInput {
                path: "Zulu.ino".into(),
                content: "void loop() {}\n".into(),
                language: None,
                generated: None,
            },
            super::super::ProjectFileInput {
                path: "main.ino".into(),
                content: "void setup() {}\n".into(),
                language: None,
                generated: None,
            },
            super::super::ProjectFileInput {
                path: "Alpha.ino".into(),
                content: "int alpha() { return 1; }\n".into(),
                language: None,
                generated: None,
            },
        ]);

        let baseline = plan_build_ir(input.clone()).unwrap();
        let preprocesses = baseline
            .graph
            .actions
            .iter()
            .filter_map(|action| match action {
                BuildAction::Transform { base, transform } if base.tool == "ck:preprocess" => {
                    Some((base, transform))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let compiles = baseline
            .graph
            .actions
            .iter()
            .filter(|action| matches!(action, BuildAction::Compile { .. }))
            .count();

        assert_eq!(preprocesses.len(), 1);
        assert_eq!(compiles, 1);
        assert_eq!(preprocesses[0].1.input, "main.ino");
        assert_eq!(
            preprocesses[0].0.arguments[..3],
            ["main.ino", "Alpha.ino", "Zulu.ino"]
        );
        assert_eq!(
            preprocesses[0]
                .0
                .inputs
                .iter()
                .map(|item| (item.path.as_str(), item.role.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("Alpha.ino", Some("sketch-tab")),
                ("Zulu.ino", Some("sketch-tab")),
                ("main.ino", Some("sketch-main")),
            ]
        );
        assert_eq!(
            baseline
                .diagnostic_map
                .entries
                .iter()
                .map(|entry| (entry.generated_line, entry.source_file.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "main.ino"), (2, "Alpha.ino"), (3, "Zulu.ino")]
        );

        if let ProjectInput::Files(files) = &mut input.project {
            files
                .iter_mut()
                .find(|file| file.path == "Zulu.ino")
                .unwrap()
                .content = "void loop() { delay(1); }\n".into();
        }
        let changed = plan_build_ir(input).unwrap();
        let key_for = |ir: &BuildIr, tool: &str| {
            ir.graph
                .actions
                .iter()
                .find_map(|action| match action {
                    BuildAction::Transform { base, .. } if base.tool == tool => {
                        Some(base.cache_key.clone())
                    }
                    _ => None,
                })
                .unwrap()
        };
        assert_ne!(
            key_for(&baseline, "ck:preprocess"),
            key_for(&changed, "ck:preprocess")
        );
    }

    #[test]
    fn maps_only_real_preprocess_prototypes_across_complex_tabs() {
        let mut input = planner_input();
        input.project = ProjectInput::Files(vec![
            super::super::ProjectFileInput {
                path: "main.ino".into(),
                content: concat!(
                    "template <typename T>\n",
                    "T ignored_template(T value) { return value; }\n",
                    "\n",
                    "void setup(\n",
                    ")\n",
                    "{\n",
                    "}\n",
                )
                .into(),
                language: None,
                generated: None,
            },
            super::super::ProjectFileInput {
                path: "Auxiliary.ino".into(),
                content: concat!(
                    "int\n",
                    "helper(\n",
                    "  int value\n",
                    ")\n",
                    "{\n",
                    "  return value;\n",
                    "}\n",
                    "void loop() {}\n",
                )
                .into(),
                language: None,
                generated: None,
            },
        ]);

        let ir = plan_build_ir(input).unwrap();
        assert_eq!(
            ir.diagnostic_map
                .entries
                .iter()
                .map(|entry| (
                    entry.generated_line,
                    entry.source_file.as_str(),
                    entry.source_line,
                ))
                .collect::<Vec<_>>(),
            vec![
                (1, "main.ino", 4),
                (2, "Auxiliary.ino", 1),
                (3, "Auxiliary.ino", 8),
            ]
        );
    }

    #[test]
    fn adds_only_uniquely_referenced_private_header_roots() {
        let mut input = planner_input();
        let pack = input.packs.libraries.packs[0].clone();
        input.libraries.push(PlannerLibraryInput {
            pack,
            files: ProjectInput::Files(vec![
                super::super::ProjectFileInput {
                    path: "src/Demo.cpp".into(),
                    content: "#include <PrivateDriver.h>\n".into(),
                    language: None,
                    generated: None,
                },
                super::super::ProjectFileInput {
                    path: "src/utility/PrivateDriver.cpp".into(),
                    content: "#include <PrivateDriver.h>\n".into(),
                    language: None,
                    generated: None,
                },
                super::super::ProjectFileInput {
                    path: "src/utility/PrivateDriver.h".into(),
                    content: "#pragma once\n".into(),
                    language: None,
                    generated: None,
                },
                super::super::ProjectFileInput {
                    path: "src/private/Codec.cpp".into(),
                    content: "#include \"assert.h\"\n".into(),
                    language: None,
                    generated: None,
                },
                super::super::ProjectFileInput {
                    path: "src/private/assert.h".into(),
                    content: "#pragma once\n".into(),
                    language: None,
                    generated: None,
                },
            ]),
            include_paths: vec!["src".into()],
            macros: BTreeMap::new(),
            flags: PlannerCompilerFlags::default(),
            root_path: None,
        });

        let plan = plan_build_actions(input).unwrap();
        let compiles = plan
            .actions
            .iter()
            .filter_map(|action| match action {
                BuildAction::Compile { compile_unit, .. }
                    if compile_unit.source.starts_with("packs/libraries/") =>
                {
                    Some(compile_unit)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(compiles.len(), 3);
        for compile in compiles {
            assert!(compile
                .flags
                .windows(2)
                .any(|pair| { pair[0] == "-idirafter" && pair[1].ends_with("/src/utility") }));
            assert!(!compile
                .flags
                .iter()
                .any(|flag| flag.ends_with("/src/private")));
            assert!(!compile
                .include_paths
                .iter()
                .any(|path| path.ends_with("/src/utility") || path.ends_with("/src/private")));
        }
    }

    #[test]
    fn resolves_path_qualified_private_include_despite_same_basename_elsewhere() {
        let libraries = path_qualified_private_include_fixture("src/unrelated/Foo.h");
        let resolved = resolve_private_library_include_paths(&libraries).unwrap();

        assert_eq!(
            resolved.get("library:demo"),
            Some(&vec!["packs/libraries/demo/src/private".into()])
        );
    }

    #[test]
    fn rejects_truly_ambiguous_path_qualified_private_include() {
        let libraries = path_qualified_private_include_fixture("src/alternate/drivers/Foo.h");
        let resolved = resolve_private_library_include_paths(&libraries).unwrap();

        assert!(!resolved.contains_key("library:demo"));
    }

    #[test]
    fn plans_same_format_transforms_with_stable_action_and_product_ids() {
        let mut input = planner_input();
        input.transforms = vec![
            PlannerTransformInput::Spec(PlannerTransformSpec {
                id: Some("transform-application".into()),
                product_id: Some("application-image".into()),
                lifecycle: PlannerTransformLifecycle::Project,
                pack_dependencies: None,
                pack_inputs: Vec::new(),
                format: TransformFormat::Bin,
                input: None,
                input_sha256: None,
                inputs: None,
                output: Some("build/application.bin".into()),
                output_sha256: None,
                flags: Vec::new(),
                tool: None,
                arguments: None,
                dependencies: None,
                offset: None,
            }),
            PlannerTransformInput::Spec(PlannerTransformSpec {
                id: Some("transform-recovery".into()),
                product_id: Some("recovery-image".into()),
                lifecycle: PlannerTransformLifecycle::Project,
                pack_dependencies: None,
                pack_inputs: Vec::new(),
                format: TransformFormat::Bin,
                input: None,
                input_sha256: None,
                inputs: None,
                output: Some("build/recovery.bin".into()),
                output_sha256: None,
                flags: Vec::new(),
                tool: None,
                arguments: None,
                dependencies: None,
                offset: None,
            }),
        ];

        let plan = plan_build_actions(input).unwrap();
        let products = plan
            .actions
            .iter()
            .filter_map(|action| match action {
                BuildAction::Transform { base, .. } if base.id.starts_with("transform-") => {
                    Some((base.id.as_str(), base.outputs[0].kind.as_deref().unwrap()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            products,
            vec![
                ("transform-application", "application-image"),
                ("transform-recovery", "recovery-image"),
            ]
        );
    }

    #[test]
    fn preserves_legacy_transform_serde_and_single_input_provenance() {
        let shorthand: PlannerTransformInput = serde_json::from_str("\"hex\"").unwrap();
        assert_eq!(
            shorthand,
            PlannerTransformInput::Format(TransformFormat::Hex)
        );

        let legacy: PlannerTransformInput = serde_json::from_value(serde_json::json!({
            "format": "bin",
            "input": "packs/platform/images/application.elf",
            "inputSha256": "6".repeat(64),
            "output": "build/application.bin",
            "dependencies": []
        }))
        .unwrap();
        let PlannerTransformInput::Spec(spec) = &legacy else {
            panic!("legacy object must deserialize as a transform spec");
        };
        assert_eq!(spec.id, None);
        assert_eq!(spec.product_id, None);
        assert!(spec.inputs.is_none());

        let mut input = planner_input();
        input.transforms = vec![legacy];
        let ir = plan_build_ir(input).unwrap();
        let (base, transform) = ir
            .graph
            .actions
            .iter()
            .find_map(|action| match action {
                BuildAction::Transform { base, transform } if base.id == "transform-bin" => {
                    Some((base, transform))
                }
                _ => None,
            })
            .unwrap();

        assert_eq!(transform.input, "packs/platform/images/application.elf");
        assert_eq!(base.outputs[0].kind.as_deref(), Some("bin"));
        assert_eq!(
            base.inputs,
            vec![ActionInput {
                path: "packs/platform/images/application.elf".into(),
                sha256: Some("6".repeat(64)),
                role: Some("transform-input".into()),
            }]
        );
    }

    #[test]
    fn keys_every_multi_input_transform_digest_and_preserves_provenance() {
        let build = |first_sha256: char, second_sha256: char| {
            let mut input = planner_input();
            input.transforms = vec![PlannerTransformInput::Spec(PlannerTransformSpec {
                id: Some("transform-merged-image".into()),
                product_id: Some("merged-image".into()),
                lifecycle: PlannerTransformLifecycle::Project,
                pack_dependencies: None,
                pack_inputs: Vec::new(),
                format: TransformFormat::Bin,
                input: None,
                input_sha256: None,
                inputs: Some(vec![
                    ActionInput {
                        path: "packs/platform/images/header.bin".into(),
                        sha256: Some(first_sha256.to_string().repeat(64)),
                        role: Some("image-header".into()),
                    },
                    ActionInput {
                        path: "packs/platform/images/payload.bin".into(),
                        sha256: Some(second_sha256.to_string().repeat(64)),
                        role: Some("image-payload".into()),
                    },
                ]),
                output: Some("build/merged.bin".into()),
                output_sha256: None,
                flags: Vec::new(),
                tool: Some("toolchain:image-merge".into()),
                arguments: Some(vec![
                    "packs/platform/images/header.bin".into(),
                    "packs/platform/images/payload.bin".into(),
                    "-o".into(),
                    "build/merged.bin".into(),
                ]),
                dependencies: Some(Vec::new()),
                offset: None,
            })];
            plan_build_ir(input).unwrap()
        };
        let baseline = build('6', '7');
        let changed_first = build('8', '7');
        let changed_second = build('6', '9');
        let (base, spec) = baseline
            .graph
            .actions
            .iter()
            .find_map(|action| match action {
                BuildAction::Transform { base, transform }
                    if base.id == "transform-merged-image" =>
                {
                    Some((base, transform))
                }
                _ => None,
            })
            .unwrap();
        let cache_key = |ir: &BuildIr| {
            ir.graph
                .actions
                .iter()
                .find_map(|action| match action {
                    BuildAction::Transform { base, .. } if base.id == "transform-merged-image" => {
                        Some(base.cache_key.clone())
                    }
                    _ => None,
                })
                .unwrap()
        };

        assert_eq!(spec.input, "packs/platform/images/header.bin");
        assert_eq!(base.outputs[0].kind.as_deref(), Some("merged-image"));
        assert_eq!(
            base.inputs
                .iter()
                .map(|input| (
                    input.path.as_str(),
                    input.sha256.as_deref().unwrap(),
                    input.role.as_deref().unwrap(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "packs/platform/images/header.bin",
                    "6666666666666666666666666666666666666666666666666666666666666666",
                    "image-header",
                ),
                (
                    "packs/platform/images/payload.bin",
                    "7777777777777777777777777777777777777777777777777777777777777777",
                    "image-payload",
                ),
            ]
        );
        assert_ne!(base.cache_key, cache_key(&changed_first));
        assert_ne!(base.cache_key, cache_key(&changed_second));
    }

    #[test]
    fn rejects_duplicate_stable_transform_action_ids() {
        let mut input = planner_input();
        let spec = |output: &str| {
            PlannerTransformInput::Spec(PlannerTransformSpec {
                id: Some("transform-duplicate".into()),
                product_id: Some(output.into()),
                lifecycle: PlannerTransformLifecycle::Project,
                pack_dependencies: None,
                pack_inputs: Vec::new(),
                format: TransformFormat::Bin,
                input: None,
                input_sha256: None,
                inputs: None,
                output: Some(format!("build/{output}.bin")),
                output_sha256: None,
                flags: Vec::new(),
                tool: None,
                arguments: None,
                dependencies: None,
                offset: None,
            })
        };
        input.transforms = vec![spec("application"), spec("recovery")];

        let error = plan_build_actions(input).unwrap_err().to_string();
        assert!(error.contains("duplicate transform action id: transform-duplicate"));
    }

    #[test]
    fn rejects_explicit_empty_transform_inputs() {
        let transform = serde_json::from_value(serde_json::json!({
            "id": "transform-application",
            "format": "bin",
            "inputs": [],
            "output": "build/application.bin"
        }))
        .unwrap();
        let mut input = planner_input();
        input.transforms = vec![transform];

        let error = plan_build_actions(input).unwrap_err().to_string();
        assert!(error.contains("transform transform-application inputs must not be empty"));
    }

    #[test]
    fn normalizes_transform_ids_with_typescript_identity_rules() {
        let mut input = planner_input();
        input.transforms = vec![PlannerTransformInput::Spec(PlannerTransformSpec {
            id: Some("  transform-application  ".into()),
            product_id: Some("  2nd-image  ".into()),
            lifecycle: PlannerTransformLifecycle::Project,
            pack_dependencies: None,
            pack_inputs: Vec::new(),
            format: TransformFormat::Bin,
            input: None,
            input_sha256: None,
            inputs: None,
            output: Some("build/application.bin".into()),
            output_sha256: None,
            flags: Vec::new(),
            tool: None,
            arguments: None,
            dependencies: None,
            offset: None,
        })];

        let actions = plan_build_actions(input).unwrap();
        let action = actions
            .actions
            .iter()
            .find(|action| action_id(action) == "transform-application")
            .unwrap();
        let BuildAction::Transform { base, .. } = action else {
            panic!("normalized transform action is missing");
        };
        assert_eq!(base.outputs[0].kind.as_deref(), Some("2nd-image"));
    }

    #[test]
    fn keeps_configuration_transforms_independent_of_project_library_packs() {
        let mut input = planner_input();
        input.transforms = vec![PlannerTransformInput::Spec(PlannerTransformSpec {
            id: Some("transform-bootloader".into()),
            product_id: Some("bootloader".into()),
            lifecycle: PlannerTransformLifecycle::Configuration,
            pack_dependencies: Some(vec!["board:test".into()]),
            pack_inputs: vec![ActionPackInput {
                kind: ActionPackInputKind::PackArtifact,
                pack_id: "board:test".into(),
                pack_revision: "b".repeat(64),
                pack_schema: 2,
                artifact_id: "bootloader-default".into(),
                sha256: "8".repeat(64),
                role: Some("bootloader-source".into()),
            }],
            format: TransformFormat::Bootloader,
            input: Some("packs/board/bootloader.bin".into()),
            input_sha256: Some("8".repeat(64)),
            inputs: None,
            output: Some("build/bootloader.bin".into()),
            output_sha256: None,
            flags: Vec::new(),
            tool: None,
            arguments: None,
            dependencies: None,
            offset: None,
        })];

        let actions = plan_build_actions(input).unwrap();
        let action = actions
            .actions
            .iter()
            .find(|action| action_id(action) == "transform-bootloader")
            .unwrap();
        let BuildAction::Transform { base, .. } = action else {
            panic!("configuration transform action is missing");
        };
        assert_eq!(base.pack_dependencies, vec!["board:test"]);
        assert_eq!(base.pack_inputs.len(), 1);
        assert_eq!(base.pack_inputs[0].artifact_id, "bootloader-default");
    }

    #[test]
    fn infers_forward_transform_dependencies_from_every_input() {
        let mut input = planner_input();
        input.transforms = vec![
            PlannerTransformInput::Spec(PlannerTransformSpec {
                id: Some("transform-merged".into()),
                product_id: Some("merged".into()),
                lifecycle: PlannerTransformLifecycle::Project,
                pack_dependencies: None,
                pack_inputs: Vec::new(),
                format: TransformFormat::Bin,
                input: Some("build/application.bin".into()),
                input_sha256: None,
                inputs: Some(vec![
                    ActionInput {
                        path: "build/application.bin".into(),
                        sha256: None,
                        role: Some("application-image".into()),
                    },
                    ActionInput {
                        path: "packs/board/bootloader.bin".into(),
                        sha256: Some("8".repeat(64)),
                        role: Some("bootloader-image".into()),
                    },
                ]),
                output: Some("build/merged.bin".into()),
                output_sha256: None,
                flags: Vec::new(),
                tool: Some("toolchain:image-merge".into()),
                arguments: None,
                dependencies: None,
                offset: None,
            }),
            PlannerTransformInput::Spec(PlannerTransformSpec {
                id: Some("transform-application".into()),
                product_id: Some("application".into()),
                lifecycle: PlannerTransformLifecycle::Project,
                pack_dependencies: None,
                pack_inputs: Vec::new(),
                format: TransformFormat::Bin,
                input: None,
                input_sha256: None,
                inputs: None,
                output: Some("build/application.bin".into()),
                output_sha256: None,
                flags: Vec::new(),
                tool: None,
                arguments: None,
                dependencies: None,
                offset: None,
            }),
        ];

        let actions = plan_build_actions(input).unwrap();
        let merged = actions
            .actions
            .iter()
            .find(|action| action_id(action) == "transform-merged")
            .unwrap();
        let BuildAction::Transform { base, .. } = merged else {
            panic!("merged transform action is missing");
        };
        assert!(base
            .dependencies
            .iter()
            .any(|dependency| dependency == "transform-application"));
    }
}
