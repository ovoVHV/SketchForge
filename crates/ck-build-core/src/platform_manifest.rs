use super::{canonical_json, normalize_path, sha256_hex, validate_sha256, validation, Result};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const CK_PLATFORM_PACK_KIND: &str = "ck-platform-pack";
pub const CK_PLATFORM_PACK_SCHEMA_VERSION: u32 = 2;
pub const CK_RECIPE_LOWERING_SCHEMA_VERSION: u32 = 2;

fn deserialize_platform_manifest_schema<'de, D>(
    deserializer: D,
) -> std::result::Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if version != CK_PLATFORM_PACK_SCHEMA_VERSION {
        return Err(serde::de::Error::custom(format!(
            "unsupported platform manifest schema {version}"
        )));
    }
    Ok(version)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformManifest {
    pub kind: String,
    #[serde(deserialize_with = "deserialize_platform_manifest_schema")]
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub vendor: String,
    pub architecture: String,
    pub sha256: String,
    pub platform_properties: BTreeMap<String, String>,
    pub recipes: Vec<PlatformRecipe>,
    pub boards: Vec<PlatformBoard>,
    pub programmers: Vec<PlatformProgrammer>,
    pub tools: Vec<PlatformToolRequirement>,
    pub files: Vec<PlatformFileEntry>,
    pub recipe_lowering: PlatformRecipeLowering,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformRecipeLowering {
    pub schema_version: u32,
    pub sha256: String,
    pub bindings: PlatformRecipeBindings,
    pub paths: PlatformRecipePaths,
    pub response_files: PlatformResponseFiles,
    pub compatibility: PlatformCompatibility,
    pub archive: PlatformArchiveLowering,
    pub publication: PlatformPublicationLowering,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformRecipeBindings {
    pub compile: PlatformCompileRecipeBindings,
    pub archive: String,
    pub link: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCompileRecipeBindings {
    pub c: String,
    pub cxx: String,
    pub asm: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformRecipePaths {
    pub logical_to_action: PlatformLogicalPathLayout,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformLogicalPathLayout {
    pub exact: BTreeMap<String, String>,
    pub prefixes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformResponseFiles {
    pub marker: String,
    pub roles: PlatformResponseFileRoles,
    pub language_files: PlatformLanguageResponseFiles,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformResponseFileRoles {
    pub compiler: String,
    pub linker: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformLanguageResponseFiles {
    pub c: String,
    pub cxx: String,
    pub asm: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCompatibility {
    pub compiler: PlatformCompilerCompatibility,
    pub linker: PlatformLinkerCompatibility,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCompilerCompatibility {
    pub disable_builtin_cxx_includes: bool,
    pub runtime_includes: Vec<PlatformCompilerRuntimeInclude>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCompilerRuntimeInclude {
    pub role: String,
    pub flag: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformLinkerCompatibility {
    pub search_paths: Vec<String>,
    pub response_files: Vec<String>,
    pub runtime_library_directories: String,
    pub force_lld_target_prefixes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformArchiveLowering {
    pub command: String,
    pub operation: String,
    pub argument_order: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformPublicationLowering {
    pub sdk_archive_rewrites: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformRecipe {
    pub id: String,
    pub argv: Vec<String>,
    pub placeholders: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformBoard {
    pub id: String,
    pub fqbn: String,
    pub name: String,
    pub core: String,
    pub variant: String,
    pub properties: BTreeMap<String, String>,
    pub menus: Vec<PlatformMenu>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformMenu {
    pub id: String,
    pub label: String,
    pub default: String,
    pub options: Vec<PlatformMenuOption>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformMenuOption {
    pub id: String,
    pub label: String,
    pub properties: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformProgrammer {
    pub id: String,
    pub name: String,
    pub properties: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlatformFileRole {
    Core,
    Variant,
    Config,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformFileEntry {
    pub path: String,
    pub role: PlatformFileRole,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformToolRequirement {
    pub id: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvePlatformManifestInput {
    pub manifest: PlatformManifest,
    pub fqbn: String,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedPlatformManifest {
    pub manifest_sha256: String,
    pub id: String,
    pub version: String,
    pub vendor: String,
    pub architecture: String,
    pub board: PlatformBoard,
    pub options: BTreeMap<String, String>,
    pub properties: BTreeMap<String, String>,
    pub resolved_recipes: Vec<PlatformRecipe>,
    pub recipe_lowering: PlatformRecipeLowering,
}

/// Validate an immutable schema-2 CK Platform Manifest and resolve one board/menu configuration.
pub fn resolve_platform_manifest(
    input: ResolvePlatformManifestInput,
) -> Result<ResolvedPlatformManifest> {
    validate_manifest(&input.manifest)?;
    if input.fqbn.trim().is_empty() {
        return validation("platform target fqbn must not be empty");
    }
    for (name, value) in &input.options {
        if name.trim().is_empty() || value.is_empty() {
            return validation(format!("platform target option is invalid: {name}"));
        }
    }
    let matches = input
        .manifest
        .boards
        .iter()
        .filter(|board| board.fqbn == input.fqbn)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return validation(format!(
            "platform target must resolve exactly one board: {}",
            input.fqbn
        ));
    }
    let board = matches[0].clone();
    let mut menus_by_alias = BTreeMap::<String, &PlatformMenu>::new();
    let mut property_keys_by_alias = BTreeMap::<String, HashSet<String>>::new();
    let mut register_property = |property: &str| {
        let alias = to_option_name(property.rsplit('.').next().unwrap_or_default());
        if !alias.is_empty() {
            property_keys_by_alias
                .entry(alias)
                .or_default()
                .insert(property.to_string());
        }
    };
    for property in board.properties.keys() {
        register_property(property);
    }
    for menu in &board.menus {
        for option in &menu.options {
            for property in option.properties.keys() {
                register_property(property);
            }
        }
        for alias in platform_menu_aliases(menu) {
            if let Some(existing) = menus_by_alias.get(&alias) {
                if existing.id != menu.id {
                    return validation(format!("platform board menu alias is ambiguous: {alias}"));
                }
            }
            menus_by_alias.insert(alias, menu);
        }
    }
    let mut requested_by_menu = BTreeMap::<String, String>::new();
    let mut property_constraints = Vec::<(String, String, Vec<String>)>::new();
    for (name, value) in input.options {
        let Some(menu) = menus_by_alias.get(&name) else {
            let keys = property_keys_by_alias
                .get(&name)
                .map(|values| values.iter().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            if keys.is_empty() {
                return validation(format!("unknown platform target option: {name}"));
            }
            property_constraints.push((name, value, keys));
            continue;
        };
        if let Some(existing) = requested_by_menu.get(&menu.id) {
            if existing != &value {
                return validation(format!(
                    "conflicting platform target option {}: {existing} != {value}",
                    menu.id
                ));
            }
        }
        requested_by_menu.insert(menu.id.clone(), value);
    }
    let mut options = BTreeMap::new();
    let mut properties = input.manifest.platform_properties.clone();
    properties.extend(board.properties.clone());
    for menu in &board.menus {
        let requested_value = requested_by_menu
            .get(&menu.id)
            .cloned()
            .unwrap_or_else(|| menu.default.clone());
        let selected = resolve_platform_menu_option(menu, &requested_value).ok_or_else(|| {
            super::BuildIrError::Validation(format!(
                "unknown platform menu option {}={requested_value}",
                menu.id
            ))
        })?;
        options.insert(menu.id.clone(), selected.id.clone());
        properties.extend(selected.properties.clone());
    }
    for (name, value, keys) in property_constraints {
        if !keys.iter().any(|key| {
            properties
                .get(key)
                .is_some_and(|candidate| candidate == &value)
        }) {
            return validation(format!(
                "unknown platform target option value {name}={value}"
            ));
        }
    }
    let resolved_recipes = resolve_platform_recipes(&input.manifest.recipes, &properties)?;
    Ok(ResolvedPlatformManifest {
        manifest_sha256: input.manifest.sha256.clone(),
        id: input.manifest.id,
        version: input.manifest.version,
        vendor: input.manifest.vendor,
        architecture: input.manifest.architecture,
        board,
        options,
        properties,
        resolved_recipes,
        recipe_lowering: input.manifest.recipe_lowering,
    })
}

fn resolve_platform_recipes(
    recipes: &[PlatformRecipe],
    properties: &BTreeMap<String, String>,
) -> Result<Vec<PlatformRecipe>> {
    let mut resolver = PlatformRecipeResolver {
        properties,
        cache: BTreeMap::new(),
    };
    recipes
        .iter()
        .map(|recipe| resolver.resolve_recipe(recipe))
        .collect()
}

struct PlatformRecipeResolver<'a> {
    properties: &'a BTreeMap<String, String>,
    cache: BTreeMap<String, String>,
}

impl PlatformRecipeResolver<'_> {
    fn resolve_recipe(&mut self, recipe: &PlatformRecipe) -> Result<PlatformRecipe> {
        let mut argv = Vec::new();
        for raw in &recipe.argv {
            let exact_property =
                exact_placeholder(raw).is_some_and(|key| self.properties.contains_key(key));
            let expanded = self.expand(raw, &mut Vec::new(), &recipe.id)?;
            if expanded.trim().is_empty() {
                continue;
            }
            if exact_property {
                argv.extend(tokenize_recipe(&expanded)?);
            } else {
                argv.push(expanded);
            }
        }
        if argv.is_empty() {
            return validation(format!(
                "platform recipe expands to an empty command: {}",
                recipe.id
            ));
        }
        let mut placeholders = BTreeMap::<String, ()>::new();
        for token in &argv {
            for (_, _, key) in innermost_placeholders(token, &recipe.id)? {
                if !is_ck_dynamic_recipe_placeholder(&key) {
                    return validation(format!(
                        "unknown platform recipe placeholder {key} in {}",
                        recipe.id
                    ));
                }
                placeholders.insert(key, ());
            }
        }
        Ok(PlatformRecipe {
            id: recipe.id.clone(),
            argv,
            placeholders: placeholders.into_keys().collect(),
        })
    }

    fn resolve_property(
        &mut self,
        key: &str,
        stack: &mut Vec<String>,
        recipe_id: &str,
    ) -> Result<String> {
        if let Some(cached) = self.cache.get(key) {
            return Ok(cached.clone());
        }
        if let Some(index) = stack.iter().position(|item| item == key) {
            let mut cycle = stack[index..].to_vec();
            cycle.push(key.to_string());
            return validation(format!(
                "cyclic platform property placeholder: {}",
                cycle.join(" -> ")
            ));
        }
        let Some(raw) = self.properties.get(key).cloned() else {
            if is_ck_dynamic_recipe_placeholder(key) {
                return Ok(format!("{{{key}}}"));
            }
            return validation(format!(
                "unknown platform recipe placeholder {key} in {recipe_id}"
            ));
        };
        stack.push(key.to_string());
        let resolved = self.expand(&raw, stack, recipe_id)?;
        stack.pop();
        self.cache.insert(key.to_string(), resolved.clone());
        Ok(resolved)
    }

    fn expand(&mut self, raw: &str, stack: &mut Vec<String>, recipe_id: &str) -> Result<String> {
        let mut value = raw.to_string();
        loop {
            let matches = innermost_placeholders(&value, recipe_id)?;
            if matches.is_empty() {
                return Ok(value);
            }
            let mut changed = false;
            let mut next = String::new();
            let mut offset = 0;
            for (start, end, key) in matches {
                next.push_str(&value[offset..start]);
                let replacement = self.resolve_property(&key, stack, recipe_id)?;
                next.push_str(&replacement);
                changed |= replacement != value[start..end];
                offset = end;
            }
            next.push_str(&value[offset..]);
            value = next;
            if !changed {
                return Ok(value);
            }
        }
    }
}

fn is_ck_dynamic_recipe_placeholder(key: &str) -> bool {
    matches!(
        key,
        "archive_file_path"
            | "build.arch"
            | "build.fqbn"
            | "build.opt.path"
            | "build.path"
            | "build.project_name"
            | "build.source.path"
            | "build.variant.path"
            | "compiler.path"
            | "compiler.prefix"
            | "compiler.sdk.path"
            | "file_opts.path"
            | "includes"
            | "object_file"
            | "object_files"
            | "runtime.hardware.path"
            | "runtime.ide.version"
            | "runtime.os"
            | "runtime.platform.path"
            | "sketch_path"
            | "source_file"
    ) || (key.starts_with("runtime.tools.") && key.ends_with(".path"))
}

fn exact_placeholder(value: &str) -> Option<&str> {
    value
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .filter(|value| !value.is_empty() && !value.contains(['{', '}']))
}

fn innermost_placeholders(value: &str, recipe_id: &str) -> Result<Vec<(usize, usize, String)>> {
    let mut stack = Vec::<usize>::new();
    let mut result = Vec::new();
    for (index, current) in value.char_indices() {
        if current == '{' {
            stack.push(index);
        } else if current == '}' {
            let Some(start) = stack.pop() else {
                return validation(format!(
                    "invalid platform recipe placeholder syntax in {recipe_id}"
                ));
            };
            let key = &value[start + 1..index];
            if !key.is_empty() && !key.contains(['{', '}']) {
                result.push((start, index + 1, key.to_string()));
            }
        }
    }
    if !stack.is_empty() {
        return validation(format!(
            "invalid platform recipe placeholder syntax in {recipe_id}"
        ));
    }
    result.sort_by_key(|(start, _, _)| *start);
    Ok(result)
}

fn tokenize_recipe(pattern: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in pattern.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if character == active {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return validation("unterminated quote in Arduino recipe");
    }
    if !current.is_empty() {
        result.push(current);
    }
    if result.is_empty() {
        return validation("Arduino recipe must not be empty");
    }
    Ok(result)
}

fn platform_menu_aliases(menu: &PlatformMenu) -> Vec<String> {
    let mut aliases = HashSet::from([menu.id.clone(), to_option_name(&menu.id)]);
    let canonical = to_option_name(&menu.id);
    if canonical.starts_with("cdc_")
        || canonical.starts_with("msc_")
        || canonical.starts_with("dfu_")
    {
        aliases.insert(format!("usb_{canonical}"));
    }
    if canonical == "events_core" {
        aliases.insert("event_core".into());
    }
    if canonical == "core_debug_level" {
        aliases.insert("debug_level".into());
    }
    aliases
        .into_iter()
        .filter(|alias| !alias.is_empty())
        .collect()
}

fn resolve_platform_menu_option<'a>(
    menu: &'a PlatformMenu,
    value: &str,
) -> Option<&'a PlatformMenuOption> {
    if let Some(exact) = menu.options.iter().find(|option| option.id == value) {
        return Some(exact);
    }
    let folded = menu
        .options
        .iter()
        .filter(|option| option.id.eq_ignore_ascii_case(value))
        .collect::<Vec<_>>();
    if folded.len() == 1 {
        return folded.first().copied();
    }
    let by_label = menu
        .options
        .iter()
        .filter(|option| option.label.eq_ignore_ascii_case(value))
        .collect::<Vec<_>>();
    if by_label.len() == 1 {
        return by_label.first().copied();
    }
    let by_property = menu
        .options
        .iter()
        .filter(|option| {
            option
                .properties
                .values()
                .any(|candidate| candidate == value)
        })
        .collect::<Vec<_>>();
    if by_property.len() == 1 {
        by_property.first().copied()
    } else {
        None
    }
}

fn to_option_name(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut result = String::new();
    let mut underscore = false;
    for (index, current) in chars.iter().copied().enumerate() {
        if !current.is_ascii_alphanumeric() {
            underscore = !result.is_empty();
            continue;
        }
        let previous = index
            .checked_sub(1)
            .and_then(|offset| chars.get(offset))
            .copied();
        let next = chars.get(index + 1).copied();
        let boundary = current.is_ascii_uppercase()
            && previous.is_some_and(|value| {
                value.is_ascii_lowercase()
                    || value.is_ascii_digit()
                    || (value.is_ascii_uppercase()
                        && next.is_some_and(|value| value.is_ascii_lowercase()))
            });
        if (underscore || boundary) && !result.ends_with('_') {
            result.push('_');
        }
        result.push(current.to_ascii_lowercase());
        underscore = false;
    }
    result.trim_matches('_').to_string()
}

fn validate_manifest(manifest: &PlatformManifest) -> Result<()> {
    if manifest.kind != CK_PLATFORM_PACK_KIND {
        return validation(format!("expected {CK_PLATFORM_PACK_KIND}"));
    }
    if manifest.schema_version != CK_PLATFORM_PACK_SCHEMA_VERSION {
        return validation(format!(
            "unsupported platform manifest schema {}",
            manifest.schema_version
        ));
    }
    validate_recipe_lowering(&manifest.recipe_lowering)?;
    validate_recipe_bindings(&manifest.recipe_lowering, &manifest.recipes)?;
    validate_sha256(&manifest.sha256, "platform manifest")?;
    for (label, value) in [
        ("id", manifest.id.as_str()),
        ("version", manifest.version.as_str()),
        ("vendor", manifest.vendor.as_str()),
        ("architecture", manifest.architecture.as_str()),
    ] {
        if value.trim().is_empty() {
            return validation(format!("platform {label} must not be empty"));
        }
    }
    let mut value = serde_json::to_value(manifest)?;
    value
        .as_object_mut()
        .expect("serialized Platform Manifest must be an object")
        .remove("sha256");
    let expected = sha256_hex(canonical_json(&value)?.as_bytes());
    if expected != manifest.sha256 {
        return validation("platform manifest sha256 mismatch");
    }

    ensure_unique(
        manifest.recipes.iter().map(|item| item.id.as_str()),
        "platform recipe",
    )?;
    for recipe in &manifest.recipes {
        if recipe.id.trim().is_empty()
            || recipe.argv.is_empty()
            || recipe.argv.iter().any(|arg| arg.is_empty())
        {
            return validation(format!("platform recipe is invalid: {}", recipe.id));
        }
        ensure_unique(
            recipe.placeholders.iter().map(String::as_str),
            "platform recipe placeholder",
        )?;
    }
    ensure_unique(
        manifest.boards.iter().map(|item| item.id.as_str()),
        "platform board",
    )?;
    ensure_unique(
        manifest.boards.iter().map(|item| item.fqbn.as_str()),
        "platform board fqbn",
    )?;
    for board in &manifest.boards {
        validate_board(board)?;
    }
    ensure_unique(
        manifest.programmers.iter().map(|item| item.id.as_str()),
        "platform programmer",
    )?;
    for programmer in &manifest.programmers {
        if programmer.id.trim().is_empty() || programmer.name.trim().is_empty() {
            return validation("platform programmer is invalid");
        }
    }
    ensure_unique(
        manifest.tools.iter().map(|item| item.id.as_str()),
        "platform tool",
    )?;
    for tool in &manifest.tools {
        if tool.id.trim().is_empty() || tool.version.trim().is_empty() {
            return validation("platform tool id and version must not be empty");
        }
        validate_sha256(&tool.sha256, "platform tool")?;
    }
    ensure_unique(
        manifest.files.iter().map(|item| item.path.as_str()),
        "platform file",
    )?;
    for file in &manifest.files {
        let normalized = normalize_path(&file.path, "platform file")?;
        if normalized != file.path {
            return validation(format!(
                "platform file path is not normalized: {}",
                file.path
            ));
        }
        validate_sha256(&file.sha256, "platform file")?;
    }
    Ok(())
}

fn validate_recipe_lowering(lowering: &PlatformRecipeLowering) -> Result<()> {
    if lowering.schema_version != CK_RECIPE_LOWERING_SCHEMA_VERSION {
        return validation(format!(
            "unsupported recipe lowering schema {}",
            lowering.schema_version
        ));
    }
    validate_sha256(&lowering.sha256, "platform recipe lowering")?;
    let mut value = serde_json::to_value(lowering)?;
    value
        .as_object_mut()
        .expect("serialized recipe lowering contract must be an object")
        .remove("sha256");
    let expected = sha256_hex(canonical_json(&value)?.as_bytes());
    if expected != lowering.sha256 {
        return validation("platform recipe lowering sha256 mismatch");
    }
    for (label, binding) in [
        ("compile.c", lowering.bindings.compile.c.as_str()),
        ("compile.cxx", lowering.bindings.compile.cxx.as_str()),
        ("compile.asm", lowering.bindings.compile.asm.as_str()),
        ("archive", lowering.bindings.archive.as_str()),
        ("link", lowering.bindings.link.as_str()),
    ] {
        if binding.trim().is_empty() {
            return validation(format!(
                "platform recipe lowering {label} binding is invalid"
            ));
        }
    }

    let mut destinations = HashSet::new();
    for (source, destination) in &lowering.paths.logical_to_action.exact {
        validate_lowering_path(source, "logical path")?;
        validate_lowering_path(destination, "Action path")?;
        if !destinations.insert(destination.as_str()) {
            return validation("platform recipe lowering path destinations are duplicated");
        }
    }
    for (source, destination) in &lowering.paths.logical_to_action.prefixes {
        let Some(source) = source.strip_suffix('/') else {
            return validation("platform path prefix must end with /");
        };
        let Some(destination_path) = destination.strip_suffix('/') else {
            return validation("platform path prefix must end with /");
        };
        validate_lowering_path(source, "logical path prefix")?;
        validate_lowering_path(destination_path, "Action path prefix")?;
        if !destinations.insert(destination.as_str()) {
            return validation("platform recipe lowering path destinations are duplicated");
        }
    }

    if lowering.response_files.marker != "@"
        || lowering.response_files.roles.compiler.trim().is_empty()
        || lowering.response_files.roles.linker.trim().is_empty()
        || lowering.response_files.language_files.c.trim().is_empty()
        || lowering.response_files.language_files.cxx.trim().is_empty()
        || lowering.response_files.language_files.asm.trim().is_empty()
    {
        return validation("platform recipe lowering response files are invalid");
    }

    let mut runtime_roles = HashSet::new();
    for include in &lowering.compatibility.compiler.runtime_includes {
        if !matches!(
            include.role.as_str(),
            "cxx" | "cxx-target" | "cxx-backward" | "gcc" | "gcc-fixed" | "sysroot"
        ) || include.flag != "-isystem"
        {
            return validation("platform recipe lowering compiler runtime include is invalid");
        }
        if !runtime_roles.insert(include.role.as_str()) {
            return validation(format!(
                "duplicate platform runtime include role: {}",
                include.role
            ));
        }
    }
    let linker = &lowering.compatibility.linker;
    if !matches!(linker.runtime_library_directories.as_str(), "all" | "none") {
        return validation("platform recipe lowering linker compatibility is invalid");
    }
    ensure_unique(
        linker.search_paths.iter().map(String::as_str),
        "linker search path",
    )?;
    ensure_unique(
        linker.response_files.iter().map(String::as_str),
        "linker response file",
    )?;
    ensure_unique(
        linker.force_lld_target_prefixes.iter().map(String::as_str),
        "lld target prefix",
    )?;
    for path in linker.search_paths.iter().chain(&linker.response_files) {
        validate_lowering_path(path, "linker compatibility path")?;
    }
    if linker
        .force_lld_target_prefixes
        .iter()
        .any(|prefix| prefix.trim().is_empty() || prefix.contains(['/', '\\']))
    {
        return validation("platform recipe lowering lld target prefix is invalid");
    }

    if lowering.archive.command != "ar"
        || lowering.archive.operation != "rcs"
        || lowering.archive.argument_order != ["operation", "output", "inputs", "flags"]
    {
        return validation("platform recipe lowering archive is invalid");
    }
    ensure_unique(
        lowering
            .publication
            .sdk_archive_rewrites
            .iter()
            .map(String::as_str),
        "SDK archive rewrite",
    )?;
    if lowering
        .publication
        .sdk_archive_rewrites
        .iter()
        .any(|rewrite| !matches!(rewrite.as_str(), "strip-debug" | "deterministic-archives"))
    {
        return validation("platform recipe lowering SDK archive rewrite is invalid");
    }
    Ok(())
}

fn validate_recipe_bindings(
    lowering: &PlatformRecipeLowering,
    recipes: &[PlatformRecipe],
) -> Result<()> {
    for (label, binding) in [
        ("compile.c", lowering.bindings.compile.c.as_str()),
        ("compile.cxx", lowering.bindings.compile.cxx.as_str()),
        ("compile.asm", lowering.bindings.compile.asm.as_str()),
        ("archive", lowering.bindings.archive.as_str()),
        ("link", lowering.bindings.link.as_str()),
    ] {
        if recipes.iter().filter(|recipe| recipe.id == binding).count() != 1 {
            return validation(format!(
                "platform recipe lowering {label} binding must resolve exactly one recipe: {binding}"
            ));
        }
    }
    Ok(())
}

fn validate_lowering_path(path: &str, label: &str) -> Result<()> {
    let normalized = normalize_path(path, label)?;
    if normalized != path {
        return validation(format!("platform {label} is not normalized: {path}"));
    }
    Ok(())
}

fn validate_board(board: &PlatformBoard) -> Result<()> {
    if board.id.trim().is_empty()
        || board.fqbn.trim().is_empty()
        || board.name.trim().is_empty()
        || board.core.trim().is_empty()
        || board.variant.trim().is_empty()
    {
        return validation(format!("platform board is incomplete: {}", board.fqbn));
    }
    ensure_unique(
        board.menus.iter().map(|menu| menu.id.as_str()),
        "platform board menu",
    )?;
    for menu in &board.menus {
        if menu.id.trim().is_empty() || menu.options.is_empty() {
            return validation(format!("platform board menu is invalid: {}", menu.id));
        }
        ensure_unique(
            menu.options.iter().map(|option| option.id.as_str()),
            "platform board menu option",
        )?;
        if !menu.options.iter().any(|option| option.id == menu.default) {
            return validation(format!(
                "platform board menu default is invalid: {}",
                menu.id
            ));
        }
        for option in &menu.options {
            if option.id.trim().is_empty() || option.label.trim().is_empty() {
                return validation(format!(
                    "platform board menu option is invalid: {}",
                    option.id
                ));
            }
        }
    }
    Ok(())
}

fn ensure_unique<'a>(values: impl IntoIterator<Item = &'a str>, label: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !seen.insert(value) {
            return validation(format!("duplicate {label}: {value}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ESP32_PROFILE_RECIPE_LOWERING_SHA256: &str =
        "e87b3e0dad526a331f7ce5808d060db5e7e8829f2c12f6cc1d1111199bfd4559";

    fn manifest() -> PlatformManifest {
        let mut value = serde_json::json!({
            "kind": "ck-platform-pack",
            "schemaVersion": CK_PLATFORM_PACK_SCHEMA_VERSION,
            "id": "espressif-arduino",
            "version": "3.3.7",
            "vendor": "esp32",
            "architecture": "esp32",
            "platformProperties": { "compiler.warning_flags": "-Wall" },
            "recipes": [
                { "id": "recipe.cpp.o", "argv": ["g++", "-c"], "placeholders": [] },
                { "id": "recipe.c.o", "argv": ["gcc", "-c"], "placeholders": [] },
                { "id": "recipe.S.o", "argv": ["gcc", "-c"], "placeholders": [] },
                { "id": "recipe.ar", "argv": ["ar", "rcs"], "placeholders": [] },
                { "id": "recipe.c.combine", "argv": ["g++"], "placeholders": [] }
            ],
            "boards": [{
                "id": "esp32c3", "fqbn": "esp32:esp32:esp32c3", "name": "ESP32-C3",
                "core": "esp32", "variant": "esp32c3", "properties": { "build.mcu": "esp32c3" },
                "menus": [{
                    "id": "PartitionScheme", "label": "Partition Scheme", "default": "default",
                    "options": [
                        { "id": "default", "label": "Default", "properties": { "build.partitions": "default" } },
                        { "id": "minimal", "label": "Minimal", "properties": { "build.partitions": "min_spiffs" } }
                    ]
                }]
            }],
            "programmers": [], "tools": [], "files": [],
            "recipeLowering": esp32_recipe_lowering()
        });
        let hash = sha256_hex(canonical_json(&value).unwrap().as_bytes());
        value
            .as_object_mut()
            .unwrap()
            .insert("sha256".into(), serde_json::Value::String(hash));
        serde_json::from_value(value).unwrap()
    }

    fn rehash(mut manifest: PlatformManifest) -> PlatformManifest {
        let mut value = serde_json::to_value(&manifest).unwrap();
        value.as_object_mut().unwrap().remove("sha256");
        manifest.sha256 = sha256_hex(canonical_json(&value).unwrap().as_bytes());
        manifest
    }

    fn esp32_recipe_lowering() -> PlatformRecipeLowering {
        let mut value = serde_json::json!({
            "schemaVersion": CK_RECIPE_LOWERING_SCHEMA_VERSION,
            "bindings": {
                "compile": {
                    "c": "recipe.c.o",
                    "cxx": "recipe.cpp.o",
                    "asm": "recipe.S.o"
                },
                "archive": "recipe.ar",
                "link": "recipe.c.combine"
            },
            "paths": {
                "logicalToAction": {
                    "exact": {
                        "core.a": "packs/platform/core.a",
                        "core": "packs/platform/core",
                        "variant": "packs/board/variant"
                    },
                    "prefixes": {
                        "sdk/": "packs/platform/sdk/",
                        "core/": "packs/platform/core/",
                        "variant/": "packs/board/variant/",
                        "runtime/": "packs/toolchain/runtime/"
                    }
                }
            },
            "responseFiles": {
                "marker": "@",
                "roles": {
                    "compiler": "compiler-response-file",
                    "linker": "linker-response-file"
                },
                "languageFiles": {
                    "c": "c_flags",
                    "cxx": "cpp_flags",
                    "asm": "S_flags"
                }
            },
            "compatibility": {
                "compiler": {
                    "disableBuiltinCxxIncludes": true,
                    "runtimeIncludes": [
                        { "role": "cxx", "flag": "-isystem" },
                        { "role": "cxx-target", "flag": "-isystem" },
                        { "role": "cxx-backward", "flag": "-isystem" },
                        { "role": "gcc", "flag": "-isystem" },
                        { "role": "gcc-fixed", "flag": "-isystem" },
                        { "role": "sysroot", "flag": "-isystem" }
                    ]
                },
                "linker": {
                    "searchPaths": ["sdk/lld-compat"],
                    "responseFiles": ["sdk/lld-compat/ld_flags"],
                    "runtimeLibraryDirectories": "all",
                    "forceLldTargetPrefixes": ["xtensa-"]
                }
            },
            "archive": {
                "command": "ar",
                "operation": "rcs",
                "argumentOrder": ["operation", "output", "inputs", "flags"]
            },
            "publication": {
                "sdkArchiveRewrites": ["strip-debug", "deterministic-archives"]
            }
        });
        let hash = sha256_hex(canonical_json(&value).unwrap().as_bytes());
        value
            .as_object_mut()
            .unwrap()
            .insert("sha256".into(), serde_json::Value::String(hash));
        serde_json::from_value(value).unwrap()
    }

    fn rehash_recipe_lowering(mut lowering: PlatformRecipeLowering) -> PlatformRecipeLowering {
        let mut value = serde_json::to_value(&lowering).unwrap();
        value.as_object_mut().unwrap().remove("sha256");
        lowering.sha256 = sha256_hex(canonical_json(&value).unwrap().as_bytes());
        lowering
    }

    fn schema_v2_manifest() -> PlatformManifest {
        manifest()
    }

    fn resolve(manifest: PlatformManifest) -> Result<ResolvedPlatformManifest> {
        resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest,
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::new(),
        })
    }

    #[test]
    fn schema_v2_resolves_recipe_lowering_and_matches_profile_binding() {
        let input = schema_v2_manifest();
        let expected_manifest_sha256 = input.sha256.clone();
        let resolved = resolve(input).unwrap();
        let lowering = &resolved.recipe_lowering;
        let profile_binding = serde_json::json!({
            "status": "manifest-defined",
            "schemaVersion": CK_RECIPE_LOWERING_SCHEMA_VERSION,
            "sha256": ESP32_PROFILE_RECIPE_LOWERING_SHA256
        });

        assert_eq!(resolved.manifest_sha256, expected_manifest_sha256);
        assert_eq!(lowering.schema_version, CK_RECIPE_LOWERING_SCHEMA_VERSION);
        assert_eq!(lowering.sha256, ESP32_PROFILE_RECIPE_LOWERING_SHA256);
        assert_eq!(profile_binding["status"], "manifest-defined");
        assert_eq!(
            profile_binding["schemaVersion"].as_u64(),
            Some(u64::from(lowering.schema_version))
        );
        assert_eq!(
            profile_binding["sha256"].as_str(),
            Some(lowering.sha256.as_str())
        );
        assert_eq!(lowering.bindings.compile.c, "recipe.c.o");
        assert_eq!(lowering.bindings.compile.cxx, "recipe.cpp.o");
        assert_eq!(lowering.bindings.compile.asm, "recipe.S.o");
        assert_eq!(
            lowering.paths.logical_to_action.exact["core"],
            "packs/platform/core"
        );
    }

    #[test]
    fn schema_v2_compile_bindings_are_exact_and_nonempty() {
        let mut empty_binding = schema_v2_manifest();
        let mut lowering = empty_binding.recipe_lowering;
        lowering.bindings.compile.asm.clear();
        empty_binding.recipe_lowering = rehash_recipe_lowering(lowering);
        let error = resolve(rehash(empty_binding)).unwrap_err();
        assert!(error
            .to_string()
            .contains("platform recipe lowering compile.asm binding is invalid"));

        let mut legacy_scalar = serde_json::to_value(esp32_recipe_lowering()).unwrap();
        legacy_scalar["bindings"]["compile"] = serde_json::json!("recipe.cpp.o");
        assert!(serde_json::from_value::<PlatformRecipeLowering>(legacy_scalar).is_err());

        let mut extra_language = serde_json::to_value(esp32_recipe_lowering()).unwrap();
        extra_language["bindings"]["compile"]["ino"] = serde_json::json!("recipe.cpp.o");
        assert!(serde_json::from_value::<PlatformRecipeLowering>(extra_language).is_err());
    }

    #[test]
    fn schema_v2_rejects_legacy_lowering_schema() {
        let mut changed = schema_v2_manifest();
        let mut lowering = changed.recipe_lowering;
        lowering.schema_version = 1;
        changed.recipe_lowering = rehash_recipe_lowering(lowering);

        let error = resolve(rehash(changed)).unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported recipe lowering schema 1"));
    }

    #[test]
    fn schema_v2_rejects_noncanonical_archive_policy() {
        for (command, operation, argument_order) in [
            ("llvm-ar", "rcs", ["operation", "output", "inputs", "flags"]),
            ("ar", "crs", ["operation", "output", "inputs", "flags"]),
            ("ar", "rcs", ["operation", "flags", "output", "inputs"]),
        ] {
            let mut changed = schema_v2_manifest();
            let mut lowering = changed.recipe_lowering;
            lowering.archive.command = command.into();
            lowering.archive.operation = operation.into();
            lowering.archive.argument_order = argument_order.map(str::to_string).to_vec();
            changed.recipe_lowering = rehash_recipe_lowering(lowering);

            let error = resolve(rehash(changed)).unwrap_err();
            assert!(error
                .to_string()
                .contains("platform recipe lowering archive is invalid"));
        }
    }

    #[test]
    fn schema_v2_requires_each_bound_recipe_exactly_once() {
        let bindings = [
            ("compile.c", "recipe.c.o"),
            ("compile.cxx", "recipe.cpp.o"),
            ("compile.asm", "recipe.S.o"),
            ("archive", "recipe.ar"),
            ("link", "recipe.c.combine"),
        ];

        for (label, recipe_id) in bindings {
            let mut missing = schema_v2_manifest();
            missing.recipes.retain(|recipe| recipe.id != recipe_id);
            let error = resolve(rehash(missing)).unwrap_err();
            assert!(error.to_string().contains(&format!(
                "platform recipe lowering {label} binding must resolve exactly one recipe: {recipe_id}"
            )));

            let mut duplicate = schema_v2_manifest();
            let repeated = duplicate
                .recipes
                .iter()
                .find(|recipe| recipe.id == recipe_id)
                .unwrap()
                .clone();
            duplicate.recipes.push(repeated);
            let error = resolve(rehash(duplicate)).unwrap_err();
            assert!(error.to_string().contains(&format!(
                "platform recipe lowering {label} binding must resolve exactly one recipe: {recipe_id}"
            )));
        }
    }

    #[test]
    fn schema_v2_rejects_contract_tampering_after_manifest_rehash() {
        let mut changed = schema_v2_manifest();
        changed.recipe_lowering.archive.command = "llvm-ar".into();

        let error = resolve(rehash(changed)).unwrap_err();
        assert!(error
            .to_string()
            .contains("platform recipe lowering sha256 mismatch"));
    }

    #[test]
    fn schema_v2_rejects_tampered_path_layout() {
        let mut stale_hash = schema_v2_manifest();
        stale_hash
            .recipe_lowering
            .paths
            .logical_to_action
            .exact
            .insert("core".into(), "packs/platform/replaced-core".into());
        let error = resolve(rehash(stale_hash)).unwrap_err();
        assert!(error
            .to_string()
            .contains("platform recipe lowering sha256 mismatch"));

        let mut invalid_prefix = schema_v2_manifest();
        let mut lowering = invalid_prefix.recipe_lowering;
        let destination = lowering
            .paths
            .logical_to_action
            .prefixes
            .remove("sdk/")
            .unwrap();
        lowering
            .paths
            .logical_to_action
            .prefixes
            .insert("sdk".into(), destination);
        invalid_prefix.recipe_lowering = rehash_recipe_lowering(lowering);
        let error = resolve(rehash(invalid_prefix)).unwrap_err();
        assert!(error
            .to_string()
            .contains("platform path prefix must end with /"));
    }

    #[test]
    fn schema_v1_is_rejected() {
        let mut legacy = manifest();
        legacy.schema_version = 1;
        let error = resolve(rehash(legacy)).unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported platform manifest schema 1"));

        let mut legacy_without_lowering = serde_json::to_value(manifest()).unwrap();
        legacy_without_lowering["schemaVersion"] = serde_json::json!(1);
        legacy_without_lowering
            .as_object_mut()
            .unwrap()
            .remove("recipeLowering");
        let error =
            serde_json::from_value::<PlatformManifest>(legacy_without_lowering).unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported platform manifest schema 1"));
    }

    #[test]
    fn resolves_defaults_and_explicit_menu_options() {
        let resolved = resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: manifest(),
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::from([
                ("partition_scheme".into(), "min_spiffs".into()),
                ("mcu".into(), "esp32c3".into()),
            ]),
        })
        .unwrap();
        assert_eq!(resolved.board.variant, "esp32c3");
        assert_eq!(resolved.options["PartitionScheme"], "minimal");
        assert_eq!(resolved.properties["build.partitions"], "min_spiffs");
        assert_eq!(resolved.properties["compiler.warning_flags"], "-Wall");
        assert!(!resolved.options.contains_key("mcu"));
    }

    #[test]
    fn rejects_hash_changes_and_unknown_options() {
        let mut changed = manifest();
        changed.version = "3.3.8".into();
        assert!(resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: changed,
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::new(),
        })
        .unwrap_err()
        .to_string()
        .contains("sha256 mismatch"));

        assert!(resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: manifest(),
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::from([("PartitionScheme".into(), "missing".into())]),
        })
        .unwrap_err()
        .to_string()
        .contains("unknown platform menu option"));

        assert!(resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: manifest(),
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::from([("made_up_option".into(), "enabled".into())]),
        })
        .unwrap_err()
        .to_string()
        .contains("unknown platform target option"));
    }

    #[test]
    fn maps_ck_stable_option_aliases_to_arduino_menu_ids() {
        let menu = |id: &str| PlatformMenu {
            id: id.into(),
            label: id.into(),
            default: "default".into(),
            options: vec![PlatformMenuOption {
                id: "default".into(),
                label: "Disabled".into(),
                properties: BTreeMap::new(),
            }],
        };
        assert!(platform_menu_aliases(&menu("EventsCore")).contains(&"event_core".into()));
        assert!(platform_menu_aliases(&menu("DFUOnBoot")).contains(&"usb_dfu_on_boot".into()));
        assert!(platform_menu_aliases(&menu("CoreDebugLevel")).contains(&"debug_level".into()));
    }

    #[test]
    fn resolves_recipe_properties_and_preserves_ck_dynamic_placeholders() {
        let mut input = manifest();
        input.platform_properties.extend(BTreeMap::from([
            ("compiler.path".into(), "toolchain/bin/".into()),
            ("compiler.cpp.cmd".into(), "g++".into()),
            ("compiler.warning_flags".into(), "-Wall".into()),
            (
                "compiler.common.flags".into(),
                "-Os {compiler.warning_flags}".into(),
            ),
        ]));
        input.recipes[0] = PlatformRecipe {
            id: "recipe.cpp.o".into(),
            argv: vec![
                "{compiler.path}{compiler.cpp.cmd}".into(),
                "{compiler.common.flags}".into(),
                "-DMCU={build.mcu}".into(),
                "-DPART={build.partitions}".into(),
                "{source_file}".into(),
                "-o".into(),
                "{object_file}".into(),
            ],
            placeholders: vec![
                "build.mcu".into(),
                "build.partitions".into(),
                "compiler.common.flags".into(),
                "compiler.cpp.cmd".into(),
                "compiler.path".into(),
                "object_file".into(),
                "source_file".into(),
            ],
        };
        let resolved = resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: rehash(input),
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::from([("partition_scheme".into(), "minimal".into())]),
        })
        .unwrap();
        assert_eq!(resolved.resolved_recipes.len(), 5);
        assert_eq!(
            resolved
                .resolved_recipes
                .iter()
                .find(|recipe| recipe.id == "recipe.cpp.o")
                .unwrap(),
            &PlatformRecipe {
                id: "recipe.cpp.o".into(),
                argv: vec![
                    "toolchain/bin/g++".into(),
                    "-Os".into(),
                    "-Wall".into(),
                    "-DMCU=esp32c3".into(),
                    "-DPART=min_spiffs".into(),
                    "{source_file}".into(),
                    "-o".into(),
                    "{object_file}".into(),
                ],
                placeholders: vec!["object_file".into(), "source_file".into()],
            }
        );
    }

    #[test]
    fn rejects_unknown_and_cyclic_recipe_placeholders() {
        let mut unknown = manifest();
        unknown.recipes[0].argv.push("{missing.value}".into());
        let error = resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: rehash(unknown),
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::new(),
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("unknown platform recipe placeholder missing.value in recipe.cpp.o"));

        let mut cyclic = manifest();
        cyclic
            .platform_properties
            .insert("alpha".into(), "{beta}".into());
        cyclic
            .platform_properties
            .insert("beta".into(), "{alpha}".into());
        cyclic.recipes[0].argv.push("{alpha}".into());
        let error = resolve_platform_manifest(ResolvePlatformManifestInput {
            manifest: rehash(cyclic),
            fqbn: "esp32:esp32:esp32c3".into(),
            options: BTreeMap::new(),
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("cyclic platform property placeholder: alpha -> beta -> alpha"));
    }
}
