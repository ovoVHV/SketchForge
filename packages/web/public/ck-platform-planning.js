// Generated from @sketchforge/core platform-planning. Do not maintain a browser-specific planner.

// packages/core/src/build-ir/canonical.ts
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (value === void 0) throw new TypeError("canonical JSON cannot contain undefined");
  if (typeof value !== "object") throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value;
  const keys = Object.keys(object).sort(compareText);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function sha256Hex(input) {
  const bytes = typeof input === "string" ? utf8(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = bytes.length + 9 + 63 >> 6 << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 128;
  const high = Math.floor(bitLength / 4294967296);
  const low = bitLength >>> 0;
  padded[padded.length - 8] = high >>> 24 & 255;
  padded[padded.length - 7] = high >>> 16 & 255;
  padded[padded.length - 6] = high >>> 8 & 255;
  padded[padded.length - 5] = high & 255;
  padded[padded.length - 4] = low >>> 24 & 255;
  padded[padded.length - 3] = low >>> 16 & 255;
  padded[padded.length - 2] = low >>> 8 & 255;
  padded[padded.length - 1] = low & 255;
  const h = [
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ];
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = (padded[at] << 24 | padded[at + 1] << 16 | padded[at + 2] << 8 | padded[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = (rotateRight(x, 7) ^ rotateRight(x, 18) ^ x >>> 3) >>> 0;
      const s1 = (rotateRight(y, 17) ^ rotateRight(y, 19) ^ y >>> 10) >>> 0;
      words[i] = words[i - 16] + s0 + words[i - 7] + s1 >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const ch = (e & f ^ ~e & g) >>> 0;
      const temp1 = hh + s1 + ch + SHA256_K[i] + words[i] >>> 0;
      const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const maj = (a & b ^ a & c ^ b & c) >>> 0;
      const temp2 = s0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  return h.map((part) => part.toString(16).padStart(8, "0")).join("");
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function rotateRight(value, amount) {
  return value >>> amount | value << 32 - amount;
}
function utf8(value) {
  const result = [];
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 55296 && codePoint < 56320) {
      if (index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 56320 && next <= 57343) {
          codePoint = 65536 + (codePoint - 55296 << 10) + next - 56320;
          index++;
        } else codePoint = 65533;
      } else codePoint = 65533;
    } else if (codePoint >= 56320 && codePoint <= 57343) codePoint = 65533;
    if (codePoint <= 127) result.push(codePoint);
    else if (codePoint <= 2047) result.push(
      192 | codePoint >> 6,
      128 | codePoint & 63
    );
    else if (codePoint <= 65535) result.push(
      224 | codePoint >> 12,
      128 | codePoint >> 6 & 63,
      128 | codePoint & 63
    );
    else result.push(
      240 | codePoint >> 18,
      128 | codePoint >> 12 & 63,
      128 | codePoint >> 6 & 63,
      128 | codePoint & 63
    );
  }
  return Uint8Array.from(result);
}
var SHA256_K = Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);

// packages/core/src/platform-pack/types.ts
var CK_PLATFORM_PACK_KIND = "ck-platform-pack";
var CK_PLATFORM_PACK_SCHEMA_VERSION = 2;
var CK_RECIPE_LOWERING_SCHEMA_VERSION = 2;

// packages/core/src/platform-pack/builder.ts
var SHA256 = /^[a-f0-9]{64}$/;
var CK_DYNAMIC_RECIPE_PLACEHOLDERS = /* @__PURE__ */ new Set([
  "archive_file_path",
  "build.arch",
  "build.fqbn",
  "build.opt.path",
  "build.path",
  "build.project_name",
  "build.source.path",
  "build.variant.path",
  "compiler.path",
  "compiler.prefix",
  "compiler.sdk.path",
  "file_opts.path",
  "includes",
  "object_file",
  "object_files",
  "runtime.hardware.path",
  "runtime.ide.version",
  "runtime.os",
  "runtime.platform.path",
  "sketch_path",
  "source_file"
]);
var ARCHIVE_ARGUMENT_ORDER = Object.freeze([
  "operation",
  "output",
  "inputs",
  "flags"
]);
var DEFAULT_RECIPE_LOWERING_INPUT = Object.freeze({
  schemaVersion: CK_RECIPE_LOWERING_SCHEMA_VERSION,
  bindings: Object.freeze({
    compile: Object.freeze({
      c: "recipe.c.o",
      cxx: "recipe.cpp.o",
      asm: "recipe.S.o"
    }),
    archive: "recipe.ar",
    link: "recipe.c.combine"
  }),
  paths: Object.freeze({
    logicalToAction: Object.freeze({
      exact: Object.freeze({}),
      prefixes: Object.freeze({})
    })
  }),
  responseFiles: Object.freeze({
    marker: "@",
    roles: Object.freeze({
      compiler: "compiler-response-file",
      linker: "linker-response-file"
    }),
    languageFiles: Object.freeze({ c: "c_flags", cxx: "cpp_flags", asm: "S_flags" })
  }),
  compatibility: Object.freeze({
    compiler: Object.freeze({ disableBuiltinCxxIncludes: false, runtimeIncludes: Object.freeze([]) }),
    linker: Object.freeze({
      searchPaths: Object.freeze([]),
      responseFiles: Object.freeze([]),
      runtimeLibraryDirectories: "none",
      forceLldTargetPrefixes: Object.freeze([])
    })
  }),
  archive: Object.freeze({
    command: "ar",
    operation: "rcs",
    argumentOrder: ARCHIVE_ARGUMENT_ORDER
  }),
  publication: Object.freeze({ sdkArchiveRewrites: Object.freeze([]) })
});
var ESP32_RECIPE_LOWERING_INPUT = Object.freeze({
  ...DEFAULT_RECIPE_LOWERING_INPUT,
  paths: Object.freeze({
    logicalToAction: Object.freeze({
      exact: Object.freeze({
        "core.a": "packs/platform/core.a",
        core: "packs/platform/core",
        variant: "packs/board/variant"
      }),
      prefixes: Object.freeze({
        "sdk/": "packs/platform/sdk/",
        "core/": "packs/platform/core/",
        "variant/": "packs/board/variant/",
        "runtime/": "packs/toolchain/runtime/"
      })
    })
  }),
  compatibility: Object.freeze({
    compiler: Object.freeze({
      disableBuiltinCxxIncludes: true,
      runtimeIncludes: Object.freeze([
        Object.freeze({ role: "cxx", flag: "-isystem" }),
        Object.freeze({ role: "cxx-target", flag: "-isystem" }),
        Object.freeze({ role: "cxx-backward", flag: "-isystem" }),
        Object.freeze({ role: "gcc", flag: "-isystem" }),
        Object.freeze({ role: "gcc-fixed", flag: "-isystem" }),
        Object.freeze({ role: "sysroot", flag: "-isystem" })
      ])
    }),
    linker: Object.freeze({
      searchPaths: Object.freeze(["sdk/lld-compat"]),
      responseFiles: Object.freeze(["sdk/lld-compat/ld_flags"]),
      runtimeLibraryDirectories: "all",
      forceLldTargetPrefixes: Object.freeze(["xtensa-"])
    })
  }),
  publication: Object.freeze({
    sdkArchiveRewrites: Object.freeze([
      "strip-debug",
      "deterministic-archives"
    ])
  })
});
function validatePlatformManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("platform manifest must be an object");
  const candidate = value;
  if (candidate.kind !== CK_PLATFORM_PACK_KIND) throw new TypeError(`expected ${CK_PLATFORM_PACK_KIND}`);
  if (candidate.schemaVersion !== CK_PLATFORM_PACK_SCHEMA_VERSION) {
    throw new TypeError(`unsupported platform manifest schema ${String(candidate.schemaVersion)}`);
  }
  const recipeLowering = validateRecipeLowering(candidate.recipeLowering);
  assertRecipeLoweringBindings(candidate.recipes, recipeLowering);
  if (!Array.isArray(candidate.tools)) throw new TypeError("platform manifest tools must be an array");
  const toolIds = /* @__PURE__ */ new Set();
  candidate.tools.forEach((tool) => {
    validateTool(tool);
    if (toolIds.has(tool.id)) throw new TypeError(`platform tool ${tool.id} is duplicated`);
    toolIds.add(tool.id);
  });
  if (!SHA256.test(candidate.sha256)) throw new TypeError("platform manifest sha256 is invalid");
  const { sha256, ...withoutHash } = candidate;
  if (sha256Hex(canonicalJson(withoutHash)) !== sha256) throw new TypeError("platform manifest sha256 mismatch");
  return candidate;
}
function assertRecipeLoweringBindings(recipes, lowering) {
  if (!Array.isArray(recipes)) throw new TypeError("platform manifest recipes must be an array");
  const counts = /* @__PURE__ */ new Map();
  for (const recipe of recipes) {
    if (!isRecord(recipe) || typeof recipe.id !== "string") continue;
    counts.set(recipe.id, (counts.get(recipe.id) ?? 0) + 1);
  }
  const bindings = [
    ["compile.c", lowering.bindings.compile.c],
    ["compile.cxx", lowering.bindings.compile.cxx],
    ["compile.asm", lowering.bindings.compile.asm],
    ["archive", lowering.bindings.archive],
    ["link", lowering.bindings.link]
  ];
  for (const [name, recipeId] of bindings) {
    const count = counts.get(recipeId) ?? 0;
    if (count !== 1) {
      throw new TypeError(
        `platform recipe lowering ${name} binding must resolve exactly one recipe: ${recipeId} (found ${count})`
      );
    }
  }
}
function validateRecipeLowering(value) {
  if (!isRecord(value)) throw new TypeError("platform recipe lowering contract must be an object");
  const candidate = value;
  const { sha256, ...body } = candidate;
  if (!SHA256.test(sha256)) throw new TypeError("platform recipe lowering sha256 is invalid");
  const normalized = normalizeRecipeLoweringBody(body);
  if (sha256Hex(canonicalJson(normalized)) !== sha256) {
    throw new TypeError("platform recipe lowering sha256 mismatch");
  }
  return candidate;
}
function resolvePlatformManifest(input) {
  const manifest = validatePlatformManifest(input.manifest);
  if (typeof input.fqbn !== "string" || !input.fqbn.trim()) {
    throw new TypeError("platform target fqbn must not be empty");
  }
  if (!Array.isArray(manifest.boards)) throw new TypeError("platform manifest boards must be an array");
  const matches = manifest.boards.filter((board2) => board2?.fqbn === input.fqbn);
  if (matches.length !== 1) {
    throw new TypeError(`platform target must resolve exactly one board: ${input.fqbn}`);
  }
  const board = matches[0];
  if (!board.core?.trim() || !board.variant?.trim() || !Array.isArray(board.menus)) {
    throw new TypeError(`platform board is incomplete: ${input.fqbn}`);
  }
  const requested = input.options ?? {};
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
    throw new TypeError("platform target options must be an object");
  }
  const requestedOptions = /* @__PURE__ */ new Map();
  for (const [name, value] of Object.entries(requested)) {
    if (!name || typeof value !== "string" || !value) {
      throw new TypeError(`platform target option is invalid: ${name}`);
    }
    requestedOptions.set(name, value);
  }
  const properties = { ...manifest.platformProperties, ...board.properties };
  const menuIds = /* @__PURE__ */ new Set();
  const menusByAlias = /* @__PURE__ */ new Map();
  const propertyKeysByAlias = /* @__PURE__ */ new Map();
  const registerProperty = (property) => {
    const alias = toOptionName(property.split(".").at(-1) ?? "");
    if (!alias) return;
    let keys = propertyKeysByAlias.get(alias);
    if (!keys) {
      keys = /* @__PURE__ */ new Set();
      propertyKeysByAlias.set(alias, keys);
    }
    keys.add(property);
  };
  for (const property of Object.keys(board.properties)) registerProperty(property);
  for (const menu of board.menus) {
    if (!menu?.id || menuIds.has(menu.id) || !Array.isArray(menu.options) || !menu.options.length) {
      throw new TypeError(`platform board menu is invalid: ${String(menu?.id)}`);
    }
    menuIds.add(menu.id);
    const optionIds = /* @__PURE__ */ new Set();
    for (const option of menu.options) {
      if (!option?.id || optionIds.has(option.id)) {
        throw new TypeError(`platform board menu option is invalid: ${String(option?.id)}`);
      }
      optionIds.add(option.id);
      for (const property of Object.keys(option.properties)) registerProperty(property);
    }
    for (const alias of platformMenuAliases(menu)) {
      const existing = menusByAlias.get(alias);
      if (existing && existing.id !== menu.id) {
        throw new TypeError(`platform board menu alias is ambiguous: ${alias}`);
      }
      menusByAlias.set(alias, menu);
    }
  }
  const requestedByMenu = /* @__PURE__ */ new Map();
  const propertyConstraints = [];
  for (const [name, value] of requestedOptions) {
    const menu = menusByAlias.get(name);
    if (!menu) {
      const keys = [...propertyKeysByAlias.get(name) ?? []];
      if (!keys.length) throw new TypeError(`unknown platform target option: ${name}`);
      propertyConstraints.push({ name, value, keys });
      continue;
    }
    const existing = requestedByMenu.get(menu.id);
    if (existing !== void 0 && existing !== value) {
      throw new TypeError(`conflicting platform target option ${menu.id}: ${existing} != ${value}`);
    }
    requestedByMenu.set(menu.id, value);
  }
  const options = {};
  for (const menu of board.menus) {
    const requestedValue = requestedByMenu.get(menu.id) ?? menu.default;
    const selected = resolvePlatformMenuOption(menu, requestedValue);
    if (!selected) throw new TypeError(`unknown platform menu option ${menu.id}=${requestedValue}`);
    options[menu.id] = selected.id;
    Object.assign(properties, selected.properties);
  }
  for (const constraint of propertyConstraints) {
    if (!constraint.keys.some((key) => properties[key] === constraint.value)) {
      throw new TypeError(`unknown platform target option value ${constraint.name}=${constraint.value}`);
    }
  }
  const sortedProperties = sortRecord(properties);
  return {
    manifestSha256: manifest.sha256,
    id: manifest.id,
    version: manifest.version,
    vendor: manifest.vendor,
    architecture: manifest.architecture,
    board,
    options: sortRecord(options),
    properties: sortedProperties,
    resolvedRecipes: resolvePlatformRecipes(manifest.recipes, sortedProperties),
    recipeLowering: manifest.recipeLowering
  };
}
function resolvePlatformRecipes(recipes, properties) {
  const cache = /* @__PURE__ */ new Map();
  const resolveProperty = (key, stack, recipeId) => {
    const cached = cache.get(key);
    if (cached !== void 0) return cached;
    const cycleAt = stack.indexOf(key);
    if (cycleAt >= 0) {
      throw new TypeError(`cyclic platform property placeholder: ${[...stack.slice(cycleAt), key].join(" -> ")}`);
    }
    const raw = properties[key];
    if (raw === void 0) {
      if (isCkDynamicRecipePlaceholder(key)) return `{${key}}`;
      throw new TypeError(`unknown platform recipe placeholder ${key} in ${recipeId}`);
    }
    const resolved = expand(raw, [...stack, key], recipeId);
    cache.set(key, resolved);
    return resolved;
  };
  const expand = (raw, stack, recipeId) => {
    let value = raw;
    for (; ; ) {
      const matches = innermostPlaceholders(value, recipeId);
      if (!matches.length) return value;
      let changed = false;
      let next = "";
      let offset = 0;
      for (const match of matches) {
        next += value.slice(offset, match.start);
        const replacement = resolveProperty(match.key, stack, recipeId);
        next += replacement;
        changed ||= replacement !== value.slice(match.start, match.end);
        offset = match.end;
      }
      next += value.slice(offset);
      value = next;
      if (!changed) return value;
    }
  };
  return recipes.map((recipe) => {
    const argv = [];
    for (const raw of recipe.argv) {
      const exact = /^\{([^{}]+)\}$/.exec(raw);
      const expanded = expand(raw, [], recipe.id);
      if (!expanded.trim()) continue;
      if (exact && Object.prototype.hasOwnProperty.call(properties, exact[1])) {
        argv.push(...tokenizeRecipe(expanded));
      } else {
        argv.push(expanded);
      }
    }
    if (!argv.length) throw new TypeError(`platform recipe expands to an empty command: ${recipe.id}`);
    const placeholders = /* @__PURE__ */ new Set();
    for (const token of argv) {
      for (const match of innermostPlaceholders(token, recipe.id)) {
        if (!isCkDynamicRecipePlaceholder(match.key)) {
          throw new TypeError(`unknown platform recipe placeholder ${match.key} in ${recipe.id}`);
        }
        placeholders.add(match.key);
      }
    }
    return { id: recipe.id, argv, placeholders: [...placeholders].sort(compareText2) };
  });
}
function isCkDynamicRecipePlaceholder(key) {
  return CK_DYNAMIC_RECIPE_PLACEHOLDERS.has(key) || key.startsWith("runtime.tools.") && key.endsWith(".path");
}
function innermostPlaceholders(value, recipeId) {
  const stack = [];
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "{") {
      stack.push(index);
    } else if (char === "}") {
      const start = stack.pop();
      if (start === void 0) throw new TypeError(`invalid platform recipe placeholder syntax in ${recipeId}`);
      const key = value.slice(start + 1, index);
      if (!key || key.includes("{") || key.includes("}")) continue;
      result.push({ start, end: index + 1, key });
    }
  }
  if (stack.length) throw new TypeError(`invalid platform recipe placeholder syntax in ${recipeId}`);
  return result.sort((left, right) => left.start - right.start);
}
function platformMenuAliases(menu) {
  const aliases = /* @__PURE__ */ new Set([menu.id, toOptionName(menu.id)]);
  const canonical = toOptionName(menu.id);
  if (/^(?:cdc|msc|dfu)_/.test(canonical)) aliases.add(`usb_${canonical}`);
  if (canonical === "events_core") aliases.add("event_core");
  if (canonical === "core_debug_level") aliases.add("debug_level");
  return [...aliases].filter(Boolean);
}
function resolvePlatformMenuOption(menu, value) {
  const exact = menu.options.find((option) => option.id === value);
  if (exact) return exact;
  const folded = menu.options.filter((option) => option.id.toLowerCase() === value.toLowerCase());
  if (folded.length === 1) return folded[0];
  const byLabel = menu.options.filter((option) => option.label.toLowerCase() === value.toLowerCase());
  if (byLabel.length === 1) return byLabel[0];
  const byProperty = menu.options.filter((option) => Object.values(option.properties).includes(value));
  return byProperty.length === 1 ? byProperty[0] : void 0;
}
function toOptionName(value) {
  return value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
function tokenizeRecipe(pattern) {
  const result = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new TypeError("unterminated quote in Arduino recipe");
  if (current) result.push(current);
  if (result.length === 0) throw new TypeError("Arduino recipe must not be empty");
  return result;
}
function validateTool(tool) {
  if (!tool || typeof tool !== "object" || typeof tool.id !== "string" || typeof tool.version !== "string" || !tool.id.trim() || !tool.version.trim()) {
    throw new TypeError("platform tool id and version must not be empty");
  }
  if (typeof tool.sha256 !== "string" || !SHA256.test(tool.sha256)) {
    throw new TypeError(`platform tool ${tool.id} sha256 is required and must be valid`);
  }
  return { id: tool.id, version: tool.version, sha256: tool.sha256 };
}
function normalizeRecipeLoweringBody(value) {
  if (!isRecord(value)) throw new TypeError("platform recipe lowering contract must be an object");
  assertExactKeys(value, [
    "schemaVersion",
    "bindings",
    "paths",
    "responseFiles",
    "compatibility",
    "archive",
    "publication"
  ], "platform recipe lowering contract");
  if (value.schemaVersion !== CK_RECIPE_LOWERING_SCHEMA_VERSION) {
    throw new TypeError(`unsupported recipe lowering schema ${String(value.schemaVersion)}`);
  }
  const bindings = exactRecord(value.bindings, "platform recipe lowering bindings", ["compile", "archive", "link"]);
  const compileBindings = exactRecord(
    bindings.compile,
    "platform recipe lowering compile bindings",
    ["c", "cxx", "asm"]
  );
  for (const [name, recipe] of Object.entries(compileBindings)) {
    if (typeof recipe !== "string" || !recipe.trim()) {
      throw new TypeError(`platform recipe lowering compile ${name} binding is invalid`);
    }
  }
  for (const name of ["archive", "link"]) {
    const recipe = bindings[name];
    if (typeof recipe !== "string" || !recipe.trim()) {
      throw new TypeError(`platform recipe lowering ${name} binding is invalid`);
    }
  }
  const paths = exactRecord(value.paths, "platform recipe lowering paths", ["logicalToAction"]);
  const logicalToAction = normalizePathLayout(paths.logicalToAction);
  const responseFiles = exactRecord(
    value.responseFiles,
    "platform recipe lowering response files",
    ["marker", "roles", "languageFiles"]
  );
  if (responseFiles.marker !== "@") throw new TypeError("platform recipe lowering response marker must be @");
  const roles = exactRecord(responseFiles.roles, "platform recipe lowering response roles", ["compiler", "linker"]);
  if ([roles.compiler, roles.linker].some((role) => typeof role !== "string" || !role.trim())) {
    throw new TypeError("platform recipe lowering response roles are invalid");
  }
  const languageFiles = exactRecord(
    responseFiles.languageFiles,
    "platform recipe lowering language response files",
    ["c", "cxx", "asm"]
  );
  if (Object.values(languageFiles).some((name) => typeof name !== "string" || !name.trim())) {
    throw new TypeError("platform recipe lowering language response files are invalid");
  }
  const compatibility = exactRecord(value.compatibility, "platform recipe lowering compatibility", ["compiler", "linker"]);
  const compiler = exactRecord(
    compatibility.compiler,
    "platform recipe lowering compiler compatibility",
    ["disableBuiltinCxxIncludes", "runtimeIncludes"]
  );
  if (typeof compiler.disableBuiltinCxxIncludes !== "boolean" || !Array.isArray(compiler.runtimeIncludes)) {
    throw new TypeError("platform recipe lowering compiler compatibility is invalid");
  }
  const runtimeRoles = /* @__PURE__ */ new Set();
  const runtimeIncludes = compiler.runtimeIncludes.map((entry, index) => {
    const include = exactRecord(entry, `platform runtime include ${index}`, ["role", "flag"]);
    if (!["cxx", "cxx-target", "cxx-backward", "gcc", "gcc-fixed", "sysroot"].includes(String(include.role)) || include.flag !== "-isystem") {
      throw new TypeError(`platform runtime include ${index} is invalid`);
    }
    if (runtimeRoles.has(include.role)) throw new TypeError(`duplicate platform runtime include role: ${include.role}`);
    runtimeRoles.add(include.role);
    return Object.freeze({ role: include.role, flag: "-isystem" });
  });
  const linker = exactRecord(
    compatibility.linker,
    "platform recipe lowering linker compatibility",
    ["searchPaths", "responseFiles", "runtimeLibraryDirectories", "forceLldTargetPrefixes"]
  );
  if (!Array.isArray(linker.searchPaths) || !Array.isArray(linker.responseFiles) || !Array.isArray(linker.forceLldTargetPrefixes) || !["all", "none"].includes(String(linker.runtimeLibraryDirectories))) {
    throw new TypeError("platform recipe lowering linker compatibility is invalid");
  }
  const searchPaths = normalizeLogicalPathList(linker.searchPaths, "linker search path");
  const responseFilePaths = normalizeLogicalPathList(linker.responseFiles, "linker response file");
  const forceLldTargetPrefixes = normalizePrefixList(linker.forceLldTargetPrefixes, "lld target prefix");
  const archive = exactRecord(
    value.archive,
    "platform recipe lowering archive",
    ["command", "operation", "argumentOrder"]
  );
  const archiveArgumentOrder = archive.argumentOrder;
  if (archive.command !== "ar" || archive.operation !== "rcs" || !Array.isArray(archiveArgumentOrder) || archiveArgumentOrder.length !== ARCHIVE_ARGUMENT_ORDER.length || ARCHIVE_ARGUMENT_ORDER.some((part, index) => archiveArgumentOrder[index] !== part)) {
    throw new TypeError("platform recipe lowering archive contract is invalid");
  }
  const publication = exactRecord(
    value.publication,
    "platform recipe lowering publication",
    ["sdkArchiveRewrites"]
  );
  if (!Array.isArray(publication.sdkArchiveRewrites)) {
    throw new TypeError("platform recipe lowering archive rewrites are invalid");
  }
  const rewrites = publication.sdkArchiveRewrites.map((rewrite) => String(rewrite));
  if (new Set(rewrites).size !== rewrites.length || rewrites.some((rewrite) => !["strip-debug", "deterministic-archives"].includes(rewrite))) {
    throw new TypeError("platform recipe lowering archive rewrites are invalid");
  }
  return Object.freeze({
    schemaVersion: CK_RECIPE_LOWERING_SCHEMA_VERSION,
    bindings: Object.freeze({
      compile: Object.freeze({
        c: compileBindings.c,
        cxx: compileBindings.cxx,
        asm: compileBindings.asm
      }),
      archive: bindings.archive,
      link: bindings.link
    }),
    paths: Object.freeze({ logicalToAction }),
    responseFiles: Object.freeze({
      marker: "@",
      roles: Object.freeze({ compiler: roles.compiler, linker: roles.linker }),
      languageFiles: Object.freeze({ c: languageFiles.c, cxx: languageFiles.cxx, asm: languageFiles.asm })
    }),
    compatibility: Object.freeze({
      compiler: Object.freeze({
        disableBuiltinCxxIncludes: compiler.disableBuiltinCxxIncludes,
        runtimeIncludes: Object.freeze(runtimeIncludes)
      }),
      linker: Object.freeze({
        searchPaths: Object.freeze(searchPaths),
        responseFiles: Object.freeze(responseFilePaths),
        runtimeLibraryDirectories: linker.runtimeLibraryDirectories,
        forceLldTargetPrefixes: Object.freeze(forceLldTargetPrefixes)
      })
    }),
    archive: Object.freeze({
      command: "ar",
      operation: "rcs",
      argumentOrder: ARCHIVE_ARGUMENT_ORDER
    }),
    publication: Object.freeze({ sdkArchiveRewrites: Object.freeze(rewrites) })
  });
}
function normalizePathLayout(value) {
  const layout = exactRecord(value, "platform recipe lowering logical paths", ["exact", "prefixes"]);
  if (!isRecord(layout.exact) || !isRecord(layout.prefixes)) {
    throw new TypeError("platform recipe lowering logical paths are invalid");
  }
  const exact = {};
  for (const [from, to] of Object.entries(layout.exact)) {
    if (typeof to !== "string") throw new TypeError("platform Action path is invalid");
    validateLogicalPath(from, "logical path");
    validateLogicalPath(to, "Action path");
    exact[from] = to;
  }
  const prefixes = {};
  for (const [from, to] of Object.entries(layout.prefixes)) {
    if (typeof to !== "string") throw new TypeError("platform Action path prefix is invalid");
    if (!from.endsWith("/") || !to.endsWith("/")) throw new TypeError("platform path prefix must end with /");
    validateLogicalPath(from.slice(0, -1), "logical path prefix");
    validateLogicalPath(to.slice(0, -1), "Action path prefix");
    prefixes[from] = to;
  }
  const destinations = [...Object.values(exact), ...Object.values(prefixes)];
  if (new Set(destinations).size !== destinations.length) {
    throw new TypeError("platform recipe lowering path destinations are duplicated");
  }
  return Object.freeze({ exact: Object.freeze(sortRecord(exact)), prefixes: Object.freeze(sortRecord(prefixes)) });
}
function normalizeLogicalPathList(value, label) {
  const result = value.map((path) => {
    if (typeof path !== "string") throw new TypeError(`platform ${label} is invalid`);
    validateLogicalPath(path.replace(/^@/, ""), label);
    return path;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`platform ${label}s are duplicated`);
  return result;
}
function normalizePrefixList(value, label) {
  const result = value.map((prefix) => {
    if (typeof prefix !== "string" || !prefix.trim() || prefix.includes("/") || prefix.includes("\\")) {
      throw new TypeError(`platform ${label} is invalid`);
    }
    return prefix;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`platform ${label}s are duplicated`);
  return result;
}
function validateLogicalPath(value, label) {
  if (!value || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`platform ${label} is invalid: ${value}`);
  }
}
function exactRecord(value, label, keys) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, keys, label);
  return value;
}
function assertExactKeys(value, keys, label) {
  const expected = [...keys].sort(compareText2);
  const actual = Object.keys(value).sort(compareText2);
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new TypeError(`${label} has unexpected fields`);
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sortRecord(value) {
  return Object.fromEntries(Object.keys(value).sort(compareText2).map((key) => [key, value[key]]));
}
function compareText2(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// packages/core/src/platform-pack/recipe-command-lowering.ts
var CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION = 1;
var ESP32_ESP_SR_PARTITION_SCHEME = "esp_sr_16";
var ESP32_ESP_SR_MODEL_ARTIFACT_ID = "srmodels";
var ESP32_ESP_SR_MODEL_PATH = "packs/board/srmodels.bin";
var ESP32_ESP_SR_MODEL_OUTPUT = "build/srmodels.bin";
var ESP32_ESP_SR_MODEL_ROLE = "model-source";
var ESP32_ESP_SR_MODEL_OFFSET = "0xd10000";
var ESP32_ESP_SR_MODEL_CAPACITY_BYTES = 0x2f0000n;
function expandPlatformProperty(properties, raw) {
  let value = raw;
  const dependencies = /* @__PURE__ */ new Set();
  for (let pass = 0; pass < 32; pass += 1) {
    let changed = false;
    value = value.replace(/\{([^{}]+)\}/g, (placeholder, key) => {
      dependencies.add(key);
      if (!Object.prototype.hasOwnProperty.call(properties, key)) return placeholder;
      changed = true;
      return properties[key];
    });
    if (!changed) break;
  }
  return Object.freeze({ value, dependencies });
}
function hasPlatformPropertyDependency(argument, key) {
  return [...argument.dependencies].some((dependency) => dependency === key || dependency.startsWith(`${key}.`));
}
function derivePlatformArchiveCommand(input) {
  const lowering = validateRecipeCommandInput(input);
  return deriveArchiveRecipe(input.recipes, lowering, input.properties);
}
function deriveEsp32PostLinkContract(input) {
  const { manifest, resolved, properties, espSr16 } = resolveEsp32PostLinkPlatform(input);
  validateEsp32ModeledTools(properties);
  requireDirectPatternRecipe(
    manifest.recipes,
    "recipe.objcopy.bin",
    "{tools.esptool_py.path}/{tools.esptool_py.cmd}",
    "recipe.objcopy.bin.pattern_args"
  );
  requirePartitionRecipe(manifest.recipes);
  requireDirectPatternRecipe(
    manifest.recipes,
    "recipe.hooks.objcopy.postobjcopy.3",
    "{tools.esptool_py.path}/{tools.esptool_py.cmd}",
    "recipe.hooks.objcopy.postobjcopy.3.pattern_args"
  );
  const application = parseEsp32Application(properties);
  const partitions = parseEsp32Partitions(properties);
  const bootloader = parseEsp32Bootloader(properties);
  assertExpectedEsp32Image(application, properties);
  assertSameEsp32Target(application, bootloader, "bootloader");
  const merge = parseEsp32Merge(properties, application, partitions, espSr16);
  if (merge.chip !== application.chip) {
    throw new TypeError("ESP32 merge chip does not match application chip");
  }
  if (merge.padToSize !== application.flashSize) {
    throw new TypeError("ESP32 merge pad size does not match application flash size");
  }
  assertExpectedEsp32Paths(application, partitions, merge);
  const boardPack = normalizePostLinkPackIdentity(input.boardPack);
  const bindings = normalizeEsp32Bindings(input.bindings, application.input, boardPack, espSr16);
  validatePostLinkPackArtifacts(bindings, input.boardPackRevisionInput, boardPack);
  assertExpectedEsp32FlashLayout(merge, properties, espSr16, bindings.model?.size);
  const offsets = new Map(merge.segments.map((segment) => [segment.productId, segment.offset]));
  const applicationProduct = freezeProduct({
    id: "transform-application",
    productId: "application",
    lifecycle: "project",
    format: "bin",
    output: application.output,
    offset: requiredProductOffset(offsets, "application"),
    operation: Object.freeze({
      kind: "esp32.elf2image",
      input: bindings.application,
      chip: application.chip,
      flashMode: application.flashMode,
      flashFrequency: application.flashFrequency,
      flashSize: application.flashSize,
      elfSha256Offset: application.elfSha256Offset
    })
  });
  const bootloaderProduct = freezeProduct({
    id: "transform-bootloader",
    productId: "bootloader",
    lifecycle: "configuration",
    format: "bootloader",
    output: "build/bootloader.bin",
    offset: requiredProductOffset(offsets, "bootloader"),
    operation: bindings.bootloader.source === "sdk-elf" ? Object.freeze({
      kind: "esp32.elf2image",
      input: bindings.bootloader.input,
      chip: bootloader.chip,
      flashMode: bootloader.flashMode,
      flashFrequency: bootloader.flashFrequency,
      flashSize: bootloader.flashSize
    }) : Object.freeze({
      kind: "materialize",
      input: bindings.bootloader.input
    })
  });
  const partitionsProduct = freezeProduct({
    id: "transform-partitions",
    productId: "partitions",
    lifecycle: "configuration",
    format: "partition",
    output: "build/partitions.bin",
    offset: requiredProductOffset(offsets, "partitions"),
    operation: bindings.partitions.source === "csv" ? Object.freeze({
      kind: "esp32.partition-bin",
      input: bindings.partitions.input,
      quiet: true
    }) : Object.freeze({
      kind: "materialize",
      input: bindings.partitions.input
    })
  });
  const bootApp0Product = freezeProduct({
    id: "transform-boot-app0",
    productId: "boot-app0",
    lifecycle: "configuration",
    format: "boot-app0",
    output: "build/boot_app0.bin",
    offset: requiredProductOffset(offsets, "boot-app0"),
    operation: Object.freeze({
      kind: "materialize",
      input: bindings.bootApp0
    })
  });
  let modelProduct;
  if (espSr16) {
    if (!bindings.model) {
      throw new TypeError("ESP32 model binding is required for esp_sr_16");
    }
    modelProduct = freezeProduct({
      id: "transform-model",
      productId: "model",
      lifecycle: "configuration",
      format: "bin",
      output: ESP32_ESP_SR_MODEL_OUTPUT,
      offset: requiredProductOffset(offsets, "model"),
      operation: Object.freeze({
        kind: "materialize",
        input: bindings.model
      })
    });
  }
  const sourceProducts = [
    applicationProduct,
    bootloaderProduct,
    partitionsProduct,
    bootApp0Product
  ];
  if (modelProduct) sourceProducts.push(modelProduct);
  const sourceById = new Map(sourceProducts.map((product) => [product.productId, product]));
  const mergeSegments = merge.segments.map((segment) => {
    const product = sourceById.get(segment.productId);
    if (!product) throw new TypeError(`ESP32 merge product is unavailable: ${segment.productId}`);
    return Object.freeze({
      productId: segment.productId,
      offset: segment.offset,
      input: Object.freeze({
        kind: "action-output",
        actionId: product.id,
        path: product.output,
        role: `${segment.productId}-image`
      })
    });
  });
  const mergedProduct = freezeProduct({
    id: "transform-merged",
    productId: "merged",
    lifecycle: "project",
    format: "bin",
    output: merge.output,
    operation: Object.freeze({
      kind: "esp32.merge-bin",
      chip: merge.chip,
      padToSize: merge.padToSize,
      flashMode: "keep",
      flashFrequency: "keep",
      flashSize: "keep",
      segments: Object.freeze(mergeSegments)
    })
  });
  const body = Object.freeze({
    kind: "ck-esp32-post-link-contract",
    schemaVersion: CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION,
    source: Object.freeze({
      platformManifestSha256: manifest.sha256,
      recipeLoweringSha256: manifest.recipeLowering.sha256,
      fqbn: resolved.board.fqbn,
      boardPackId: boardPack.id,
      boardPackSha256: boardPack.sha256
    }),
    target: Object.freeze({
      chip: application.chip,
      flashMode: application.flashMode,
      flashFrequency: application.flashFrequency,
      flashSize: application.flashSize
    }),
    products: Object.freeze([...sourceProducts, mergedProduct])
  });
  return Object.freeze({
    ...body,
    sha256: sha256Hex(canonicalJson(body))
  });
}
var ESP32_IMAGE_OPTIONS = Object.freeze([
  "--chip",
  "--flash-mode",
  "--flash-freq",
  "--flash-size"
]);
var ESP32_FLASH_PRODUCT_ORDER = Object.freeze([
  "bootloader",
  "partitions",
  "boot-app0",
  "application"
]);
function esp32FlashProductOrder(espSr16) {
  return espSr16 ? Object.freeze([...ESP32_FLASH_PRODUCT_ORDER, "model"]) : ESP32_FLASH_PRODUCT_ORDER;
}
function parseEsp32Application(properties) {
  const label = "ESP32 application recipe";
  const tokens = strictPropertyTokens(properties, "recipe.objcopy.bin.pattern_args");
  const options = /* @__PURE__ */ new Map();
  let operationCount = 0;
  let output;
  let input;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "elf2image") {
      operationCount += 1;
      continue;
    }
    if (token === "-o") {
      if (output !== void 0) throw new TypeError(`${label} contains duplicate -o`);
      output = requiredFollowingToken(tokens, ++index, "-o", label);
      continue;
    }
    if ([...ESP32_IMAGE_OPTIONS, "--elf-sha256-offset"].includes(token)) {
      if (options.has(token)) throw new TypeError(`${label} contains duplicate ${token}`);
      options.set(token, requiredFollowingToken(tokens, ++index, token, label));
      continue;
    }
    if (token.startsWith("-")) throw new TypeError(`${label} contains an unmodeled argument: ${token}`);
    if (input !== void 0) throw new TypeError(`${label} contains an unmodeled positional argument: ${token}`);
    input = token;
  }
  requireOperationCount(operationCount, "elf2image", label);
  requireOptionSet(options, [...ESP32_IMAGE_OPTIONS, "--elf-sha256-offset"], label);
  if (output === void 0 || input === void 0) {
    throw new TypeError(`${label} requires exactly one output and ELF input`);
  }
  const elfSha256Offset = normalizeHexOffset(
    options.get("--elf-sha256-offset"),
    `${label} ELF SHA-256 offset`
  );
  if (elfSha256Offset !== "0xb0") {
    throw new TypeError(`${label} ELF SHA-256 offset must be 0xb0`);
  }
  const normalizedInput = normalizeContractPath(input, `${label} input`);
  const normalizedOutput = normalizeContractPath(output, `${label} output`);
  if (!normalizedInput.endsWith(".elf") || !normalizedOutput.endsWith(".bin")) {
    throw new TypeError(`${label} input/output formats are invalid`);
  }
  return {
    ...normalizeEsp32ImageOptions(options, label),
    elfSha256Offset,
    input: normalizedInput,
    output: normalizedOutput
  };
}
function parseEsp32Bootloader(properties) {
  const label = "ESP32 bootloader recipe";
  const tokens = strictPropertyTokens(properties, "recipe.hooks.prebuild.4.pattern_args");
  const options = /* @__PURE__ */ new Map();
  let operationCount = 0;
  let outputMarkerCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "elf2image") {
      operationCount += 1;
      continue;
    }
    if (token === "-o") {
      outputMarkerCount += 1;
      if (index !== tokens.length - 1) {
        throw new TypeError(`${label} -o marker must be the final argument`);
      }
      continue;
    }
    if (ESP32_IMAGE_OPTIONS.includes(token)) {
      if (options.has(token)) throw new TypeError(`${label} contains duplicate ${token}`);
      options.set(token, requiredFollowingToken(tokens, ++index, token, label));
      continue;
    }
    throw new TypeError(`${label} contains an unmodeled argument: ${token}`);
  }
  requireOperationCount(operationCount, "elf2image", label);
  if (outputMarkerCount !== 1) throw new TypeError(`${label} must contain exactly one -o marker`);
  requireOptionSet(options, ESP32_IMAGE_OPTIONS, label);
  return normalizeEsp32ImageOptions(options, label);
}
function parseEsp32Partitions(properties) {
  const input = normalizeContractPath(
    strictExpandedArgument(properties, "{build.path}/partitions.csv", "ESP32 partition input").value,
    "ESP32 partition input"
  );
  const output = normalizeContractPath(
    strictExpandedArgument(
      properties,
      "{build.path}/{build.project_name}.partitions.bin",
      "ESP32 partition output"
    ).value,
    "ESP32 partition output"
  );
  if (!input.endsWith(".csv") || !output.endsWith(".bin")) {
    throw new TypeError("ESP32 partition recipe input/output formats are invalid");
  }
  return Object.freeze({ input, output });
}
function parseEsp32Merge(properties, application, partitions, espSr16) {
  const label = "ESP32 merge recipe";
  const tokens = strictPropertyTokens(
    properties,
    "recipe.hooks.objcopy.postobjcopy.3.pattern_args"
  );
  const options = /* @__PURE__ */ new Map();
  const rawSegments = [];
  let operationCount = 0;
  let output;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^0x[0-9a-f]+$/i.test(token)) {
      for (let pair = index; pair < tokens.length; pair += 2) {
        const rawOffset = tokens[pair];
        const rawPath = tokens[pair + 1];
        if (rawOffset === void 0 || rawPath === void 0 || !/^0x[0-9a-f]+$/i.test(rawOffset)) {
          throw new TypeError(`${label} flash layout must contain offset/path pairs`);
        }
        rawSegments.push({
          offset: normalizeHexOffset(rawOffset, `${label} segment offset`),
          path: normalizeContractPath(rawPath, `${label} segment path`)
        });
      }
      break;
    }
    if (token === "merge-bin") {
      operationCount += 1;
      continue;
    }
    if (token === "-o") {
      if (output !== void 0) throw new TypeError(`${label} contains duplicate -o`);
      output = requiredFollowingToken(tokens, ++index, "-o", label);
      continue;
    }
    if (["--chip", "--pad-to-size", "--flash-mode", "--flash-freq", "--flash-size"].includes(token)) {
      if (options.has(token)) throw new TypeError(`${label} contains duplicate ${token}`);
      options.set(token, requiredFollowingToken(tokens, ++index, token, label));
      continue;
    }
    throw new TypeError(`${label} contains an unmodeled argument: ${token}`);
  }
  requireOperationCount(operationCount, "merge-bin", label);
  requireOptionSet(
    options,
    ["--chip", "--pad-to-size", "--flash-mode", "--flash-freq", "--flash-size"],
    label
  );
  for (const option of ["--flash-mode", "--flash-freq", "--flash-size"]) {
    if (options.get(option) !== "keep") {
      throw new TypeError(`${label} ${option} must be keep`);
    }
  }
  if (output === void 0 || rawSegments.length !== ESP32_FLASH_PRODUCT_ORDER.length) {
    throw new TypeError(`${label} requires one output and exactly four recipe flash segments`);
  }
  const recipePaths = {
    application: application.output,
    bootloader: normalizeContractPath(
      strictExpandedArgument(
        properties,
        "{build.path}/{build.project_name}.bootloader.bin",
        "ESP32 bootloader output"
      ).value,
      "ESP32 bootloader output"
    ),
    partitions: partitions.output,
    "boot-app0": normalizeContractPath(
      strictExpandedArgument(
        properties,
        "{runtime.platform.path}/tools/partitions/boot_app0.bin",
        "ESP32 boot_app0 input"
      ).value,
      "ESP32 boot_app0 input"
    )
  };
  const expectedByPath = /* @__PURE__ */ new Map();
  for (const [productId, path] of Object.entries(recipePaths)) {
    if (path !== void 0) expectedByPath.set(path, productId);
  }
  const offsets = /* @__PURE__ */ new Map();
  const seenOffsets = /* @__PURE__ */ new Set();
  const flashBytes = parseFlashSizeBytes(application.flashSize, `${label} flash size`);
  for (const segment of rawSegments) {
    const productId = expectedByPath.get(segment.path);
    if (!productId) throw new TypeError(`${label} contains an unknown product path: ${segment.path}`);
    if (offsets.has(productId)) throw new TypeError(`${label} contains duplicate product: ${productId}`);
    if (seenOffsets.has(segment.offset)) throw new TypeError(`${label} contains duplicate offset: ${segment.offset}`);
    if (BigInt(segment.offset) >= flashBytes) {
      throw new TypeError(`${label} segment offset exceeds flash size: ${segment.offset}`);
    }
    offsets.set(productId, segment.offset);
    seenOffsets.add(segment.offset);
  }
  if (offsets.size !== ESP32_FLASH_PRODUCT_ORDER.length) {
    throw new TypeError(`${label} does not contain every required product`);
  }
  const segments = ESP32_FLASH_PRODUCT_ORDER.map((productId) => Object.freeze({
    productId,
    offset: offsets.get(productId)
  }));
  const paths = { ...recipePaths };
  if (espSr16) {
    paths.model = ESP32_ESP_SR_MODEL_OUTPUT;
    segments.push(Object.freeze({
      productId: "model",
      offset: ESP32_ESP_SR_MODEL_OFFSET
    }));
  }
  return Object.freeze({
    chip: normalizeEsp32Scalar(options.get("--chip"), `${label} chip`),
    output: normalizeContractPath(output, `${label} output`),
    padToSize: normalizeEsp32Scalar(options.get("--pad-to-size"), `${label} pad size`),
    paths: Object.freeze(paths),
    segments: Object.freeze(segments)
  });
}
function normalizeEsp32ImageOptions(options, label) {
  return Object.freeze({
    chip: normalizeEsp32Scalar(options.get("--chip"), `${label} chip`),
    flashMode: normalizeEsp32Scalar(options.get("--flash-mode"), `${label} flash mode`),
    flashFrequency: normalizeEsp32Scalar(
      options.get("--flash-freq"),
      `${label} flash frequency`
    ),
    flashSize: normalizeEsp32Scalar(options.get("--flash-size"), `${label} flash size`)
  });
}
function assertSameEsp32Target(expected, actual, label) {
  if (actual.chip !== expected.chip || actual.flashMode !== expected.flashMode || actual.flashFrequency !== expected.flashFrequency || actual.flashSize !== expected.flashSize) {
    throw new TypeError(`ESP32 ${label} image parameters do not match the application image`);
  }
}
function assertExpectedEsp32Image(image, properties) {
  const expected = {
    chip: normalizeEsp32Scalar(
      strictExpandedArgument(properties, "{build.mcu}", "build.mcu").value,
      "ESP32 build.mcu"
    ),
    flashMode: normalizeEsp32Scalar(
      strictExpandedArgument(properties, "{build.flash_mode}", "build.flash_mode").value,
      "ESP32 build.flash_mode"
    ),
    flashFrequency: normalizeEsp32Scalar(
      strictExpandedArgument(properties, "{build.img_freq}", "build.img_freq").value,
      "ESP32 build.img_freq"
    ),
    flashSize: normalizeEsp32Scalar(
      strictExpandedArgument(properties, "{build.flash_size}", "build.flash_size").value,
      "ESP32 build.flash_size"
    )
  };
  assertSameEsp32Target(expected, image, "application");
}
function assertExpectedEsp32Paths(application, partitions, merge) {
  const expected = {
    applicationInput: "build/firmware.elf",
    applicationOutput: "build/firmware.bin",
    partitionInput: "build/partitions.csv",
    partitionOutput: "build/firmware.partitions.bin",
    mergedOutput: "build/firmware.merged.bin"
  };
  if (application.input !== expected.applicationInput || application.output !== expected.applicationOutput || partitions.input !== expected.partitionInput || partitions.output !== expected.partitionOutput || merge.output !== expected.mergedOutput) {
    throw new TypeError("ESP32 post-link recipe paths do not match the CK logical layout");
  }
}
function assertExpectedEsp32FlashLayout(merge, properties, espSr16, modelSize) {
  const actual = new Map(merge.segments.map((segment) => [segment.productId, segment.offset]));
  const expected = {
    bootloader: normalizeHexOffset(
      strictExpandedArgument(
        properties,
        "{build.bootloader_addr}",
        "build.bootloader_addr"
      ).value,
      "ESP32 build.bootloader_addr"
    ),
    partitions: "0x8000",
    "boot-app0": "0xe000",
    application: "0x10000"
  };
  const productOrder = esp32FlashProductOrder(espSr16);
  if (espSr16) expected.model = ESP32_ESP_SR_MODEL_OFFSET;
  for (const productId of productOrder) {
    if (actual.get(productId) !== expected[productId]) {
      throw new TypeError(`ESP32 ${productId} flash offset does not match the modeled layout`);
    }
  }
  if (!espSr16) return;
  const flashBytes = parseFlashSizeBytes(
    strictExpandedArgument(properties, "{build.flash_size}", "ESP32 flash size").value,
    "ESP32 flash size"
  );
  const expectedFlashBytes = 16n * 1024n * 1024n;
  if (flashBytes !== expectedFlashBytes) {
    throw new TypeError("ESP32 esp_sr_16 requires a 16MB flash layout");
  }
  if (modelSize === void 0 || !Number.isSafeInteger(modelSize) || modelSize < 1) {
    throw new TypeError("ESP32 esp_sr_16 model artifact size is invalid");
  }
  const modelBytes = BigInt(modelSize);
  if (modelBytes > ESP32_ESP_SR_MODEL_CAPACITY_BYTES) {
    throw new TypeError("ESP32 esp_sr_16 model artifact exceeds its allocated capacity");
  }
  const modelOffset = actual.get("model");
  if (!modelOffset || BigInt(modelOffset) + modelBytes > flashBytes) {
    throw new TypeError("ESP32 esp_sr_16 model artifact exceeds the flash layout");
  }
}
function resolveEsp32PostLinkPlatform(input) {
  if (!isRecord2(input) || !isRecord2(input.manifest) || !isRecord2(input.resolved) || !isRecord2(input.boardPack) || !isRecord2(input.bindings)) {
    throw new TypeError("ESP32 post-link contract input is invalid");
  }
  const manifest = validatePlatformManifest(input.manifest);
  const provided = input.resolved;
  if (typeof provided.board?.fqbn !== "string" || !isRecord2(provided.options)) {
    throw new TypeError("ESP32 post-link resolved platform is invalid");
  }
  const resolved = resolvePlatformManifest({
    manifest,
    fqbn: provided.board.fqbn,
    options: provided.options
  });
  if (canonicalJson(resolved) !== canonicalJson(provided)) {
    throw new TypeError("ESP32 post-link resolved platform does not match its Manifest");
  }
  if (resolved.architecture.toLowerCase() !== "esp32" || !resolved.recipeLowering || resolved.manifestSha256 !== manifest.sha256 || resolved.recipeLowering.sha256 !== manifest.recipeLowering.sha256) {
    throw new TypeError("ESP32 post-link platform identity is invalid");
  }
  const properties = Object.freeze({
    ...resolved.properties,
    "build.path": "build",
    "build.project_name": "firmware",
    "runtime.platform.path": "packs/platform"
  });
  if (typeof properties["build.partitions"] !== "string" || !properties["build.partitions"].trim()) {
    throw new TypeError("ESP32 custom partition selection requires an explicit project binding");
  }
  if (properties["upload.extra_flags"]?.trim()) {
    throw new TypeError("ESP32 upload extra flash segments are not modeled by the post-link contract");
  }
  const partitionOptionValues = [
    resolved.options.partition_scheme,
    resolved.options.PartitionScheme
  ].filter((value) => typeof value === "string" && value.length > 0);
  const optionSelectsEspSr16 = partitionOptionValues.some(
    (value) => value === ESP32_ESP_SR_PARTITION_SCHEME
  );
  const propertySelectsEspSr16 = properties["build.partitions"] === ESP32_ESP_SR_PARTITION_SCHEME;
  if (partitionOptionValues.length > 0 && optionSelectsEspSr16 !== propertySelectsEspSr16) {
    throw new TypeError("ESP32 esp_sr_16 option does not match the resolved partition layout");
  }
  const espSr16 = optionSelectsEspSr16 || propertySelectsEspSr16;
  return Object.freeze({ manifest, resolved, properties, espSr16 });
}
function validateEsp32ModeledTools(properties) {
  if (properties["tools.esptool_py.cmd"] !== "esptool") {
    throw new TypeError("ESP32 image recipe tool binding is invalid");
  }
  const partitionTool = strictPropertyTokens(properties, "tools.gen_esp32part.cmd");
  if (canonicalJson(partitionTool) !== canonicalJson([
    "python3",
    "packs/platform/tools/gen_esp32part.py"
  ])) {
    throw new TypeError("ESP32 partition recipe tool binding is invalid");
  }
}
function requireDirectPatternRecipe(recipes, id, executable, patternProperty) {
  const recipe = requiredRecipe(recipes, id);
  const expected = [executable, `{${patternProperty}}`];
  if (canonicalJson(recipe.argv) !== canonicalJson(expected)) {
    throw new TypeError(`ESP32 ${id} must be a direct modeled tool invocation`);
  }
}
function requirePartitionRecipe(recipes) {
  const recipe = requiredRecipe(recipes, "recipe.objcopy.partitions.bin");
  const expected = [
    "{tools.gen_esp32part.cmd}",
    "-q",
    "{build.path}/partitions.csv",
    "{build.path}/{build.project_name}.partitions.bin"
  ];
  if (canonicalJson(recipe.argv) !== canonicalJson(expected)) {
    throw new TypeError("ESP32 partition recipe must be exactly -q CSV BIN");
  }
}
function strictPropertyTokens(properties, key) {
  if (!Object.prototype.hasOwnProperty.call(properties, key) || typeof properties[key] !== "string" || !properties[key].trim()) {
    throw new TypeError(`ESP32 post-link property is missing: ${key}`);
  }
  return tokenizeRecipe(properties[key]).map((token) => strictExpandedArgument(properties, token, key).value);
}
function strictExpandedArgument(properties, raw, label) {
  const expanded = expandPlatformProperty(properties, raw);
  if (!expanded.value || expanded.value.includes("\0") || /[{}]/.test(expanded.value)) {
    throw new TypeError(`ESP32 ${label} contains an unresolved or invalid argument: ${raw}`);
  }
  return Object.freeze({ value: expanded.value, dependencies: expanded.dependencies });
}
function requiredFollowingToken(tokens, index, option, label) {
  const token = tokens[index];
  if (token === void 0 || !token || token.startsWith("-")) {
    throw new TypeError(`${label} ${option} requires one value`);
  }
  return token;
}
function requireOperationCount(count, operation, label) {
  if (count !== 1) throw new TypeError(`${label} must contain exactly one ${operation}`);
}
function requireOptionSet(options, expected, label) {
  if (options.size !== expected.length || expected.some((option) => !options.has(option))) {
    throw new TypeError(`${label} does not contain the required option set`);
  }
}
function normalizeEsp32Scalar(value, label) {
  if (typeof value !== "string" || value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    throw new TypeError(`${label} is invalid: ${String(value)}`);
  }
  return value;
}
function normalizeHexOffset(value, label) {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new TypeError(`${label} is not hexadecimal: ${value}`);
  return `0x${BigInt(value).toString(16)}`;
}
function parseFlashSizeBytes(value, label) {
  const match = /^(\d+)(B|KB|K|MB|M)$/i.exec(value);
  if (!match) throw new TypeError(`${label} is invalid: ${value}`);
  const amount = BigInt(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === "B" ? 1n : unit === "K" || unit === "KB" ? 1024n : 1024n * 1024n;
  const bytes = amount * multiplier;
  if (bytes <= 0n) throw new TypeError(`${label} must be positive`);
  return bytes;
}
function normalizeContractPath(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} is invalid`);
  }
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("//")) {
    throw new TypeError(`${label} must be a logical relative path: ${value}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`${label} contains an invalid path segment: ${value}`);
  }
  return path;
}
function normalizeEsp32Bindings(value, applicationInput, boardPack, espSr16) {
  if (!isRecord2(value) || !isRecord2(value.bootloader) || !isRecord2(value.partitions)) {
    throw new TypeError("ESP32 post-link bindings are invalid");
  }
  const application = normalizeActionOutputInput(value.application, "ESP32 application binding");
  if (application.path !== applicationInput) {
    throw new TypeError("ESP32 application binding does not match the Manifest ELF input");
  }
  if (value.bootloader.source !== "sdk-elf" && value.bootloader.source !== "immutable-bin") {
    throw new TypeError("ESP32 bootloader binding source is invalid");
  }
  if (value.partitions.source !== "csv" && value.partitions.source !== "immutable-bin") {
    throw new TypeError("ESP32 partitions binding source is invalid");
  }
  const bootloaderInput = normalizeImmutableInput(
    value.bootloader.input,
    "ESP32 bootloader binding",
    boardPack,
    false
  );
  const partitionInput = normalizeImmutableInput(
    value.partitions.input,
    "ESP32 partitions binding",
    boardPack,
    value.partitions.source === "csv"
  );
  const bootApp0 = normalizeImmutableInput(
    value.bootApp0,
    "ESP32 boot_app0 binding",
    boardPack,
    false
  );
  requirePathExtension(
    bootloaderInput.path,
    value.bootloader.source === "sdk-elf" ? ".elf" : ".bin",
    "ESP32 bootloader binding"
  );
  requirePathExtension(
    partitionInput.path,
    value.partitions.source === "csv" ? ".csv" : ".bin",
    "ESP32 partitions binding"
  );
  requirePathExtension(bootApp0.path, ".bin", "ESP32 boot_app0 binding");
  let model;
  if (espSr16) {
    if (!value.model) {
      throw new TypeError("ESP32 model binding is required for esp_sr_16");
    }
    const modelInput = normalizeImmutableInput(
      value.model,
      "ESP32 model binding",
      boardPack,
      false
    );
    if (modelInput.role !== ESP32_ESP_SR_MODEL_ROLE) {
      throw new TypeError("ESP32 model binding role must be model-source");
    }
    if (modelInput.path !== ESP32_ESP_SR_MODEL_PATH || modelInput.provenance.kind !== "pack-artifact" || modelInput.provenance.artifactId !== ESP32_ESP_SR_MODEL_ARTIFACT_ID) {
      throw new TypeError("ESP32 esp_sr_16 model binding must use the srmodels Board Pack artifact");
    }
    requirePathExtension(modelInput.path, ".bin", "ESP32 model binding");
    const modelSize = modelInput.size;
    if (modelSize === void 0) {
      throw new TypeError("ESP32 model binding size is required");
    }
    if (modelSize > Number(ESP32_ESP_SR_MODEL_CAPACITY_BYTES)) {
      throw new TypeError("ESP32 model binding exceeds the esp_sr_16 model capacity");
    }
    model = Object.freeze({ ...modelInput, size: modelSize });
  } else if (value.model !== void 0) {
    throw new TypeError("ESP32 model binding is only valid for esp_sr_16");
  }
  const immutablePaths = [
    bootloaderInput.path,
    partitionInput.path,
    bootApp0.path,
    ...model === void 0 ? [] : [model.path]
  ];
  if (new Set(immutablePaths).size !== immutablePaths.length) {
    throw new TypeError("ESP32 immutable post-link bindings must use distinct paths");
  }
  return Object.freeze({
    application,
    bootloader: Object.freeze({ source: value.bootloader.source, input: bootloaderInput }),
    partitions: Object.freeze({ source: value.partitions.source, input: partitionInput }),
    bootApp0,
    ...model === void 0 ? {} : { model }
  });
}
function normalizePostLinkPackIdentity(value) {
  if (!isRecord2(value) || !stablePackIdentity(value.id) || !isSha256(value.sha256)) {
    throw new TypeError("ESP32 post-link Board Pack identity is invalid");
  }
  return Object.freeze({ id: value.id, sha256: value.sha256 });
}
function validatePostLinkPackArtifacts(bindings, revisionInput, boardPack) {
  const immutableInputs = [
    bindings.bootloader.input,
    bindings.partitions.input,
    bindings.bootApp0,
    ...bindings.model === void 0 ? [] : [bindings.model]
  ];
  const artifactInputs = immutableInputs.filter((item) => item.provenance.kind === "pack-artifact");
  if (!artifactInputs.length) return;
  if (typeof revisionInput !== "string" || revisionInput.length < 1 || sha256Hex(revisionInput) !== boardPack.sha256) {
    throw new TypeError("ESP32 post-link Board Pack revision input is invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(revisionInput);
  } catch {
    throw new TypeError("ESP32 post-link Board Pack revision input is invalid");
  }
  if (!isRecord2(manifest) || manifest.schema !== 2 || manifest.id !== boardPack.id || typeof manifest.version !== "string" || manifest.version.length < 1 || !Array.isArray(manifest.artifacts)) {
    throw new TypeError("ESP32 post-link Board Pack Manifest identity is invalid");
  }
  const artifactIds = /* @__PURE__ */ new Set();
  for (const candidate of manifest.artifacts) {
    if (!isRecord2(candidate) || !stablePackIdentity(candidate.id) || artifactIds.has(candidate.id) || typeof candidate.kind !== "string" || candidate.kind.length < 1 || typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 1 || !isSha256(candidate.sha256)) {
      throw new TypeError("ESP32 post-link Board Pack Manifest artifacts are invalid");
    }
    artifactIds.add(candidate.id);
  }
  for (const input of artifactInputs) {
    const provenance = input.provenance;
    if (provenance.kind !== "pack-artifact" || provenance.packId !== boardPack.id || provenance.packSha256 !== boardPack.sha256 || provenance.packSchema !== manifest.schema) {
      throw new TypeError(`ESP32 post-link Board Pack artifact schema is invalid: ${input.role}`);
    }
    const matches = manifest.artifacts.filter((artifact2) => artifact2?.id === provenance.artifactId);
    const artifact = matches[0];
    if (matches.length !== 1 || !isRecord2(artifact) || artifact.kind !== "bin" || artifact.sha256 !== input.sha256 || input.size !== void 0 && artifact.size !== input.size) {
      throw new TypeError(`ESP32 post-link Board Pack artifact is invalid: ${input.role}`);
    }
  }
}
function normalizeActionOutputInput(value, label) {
  if (!isRecord2(value) || value.kind !== "action-output" || typeof value.actionId !== "string" || !/^[a-z][a-z0-9._-]*$/.test(value.actionId) || typeof value.role !== "string" || !/^[a-z][a-z0-9._-]*$/.test(value.role)) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({
    kind: "action-output",
    actionId: value.actionId,
    path: normalizeContractPath(value.path, `${label} path`),
    role: value.role
  });
}
function normalizeImmutableInput(value, label, boardPack, allowProjectFile) {
  if (!isRecord2(value) || value.kind !== "immutable" || !isSha256(value.sha256) || typeof value.role !== "string" || !/^[a-z][a-z0-9._-]*$/.test(value.role) || !isRecord2(value.provenance)) {
    throw new TypeError(`${label} is invalid`);
  }
  const size = normalizeImmutableSize(value.size, label);
  const path = normalizeContractPath(value.path, `${label} path`);
  const provenance = normalizeImmutableProvenance(
    value.provenance,
    label,
    boardPack,
    path,
    value.sha256,
    allowProjectFile
  );
  return Object.freeze({
    kind: "immutable",
    path,
    role: value.role,
    sha256: value.sha256,
    ...size === void 0 ? {} : { size },
    provenance
  });
}
function normalizeImmutableSize(value, label) {
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} size is invalid`);
  }
  return value;
}
function normalizeImmutableProvenance(value, label, boardPack, inputPath, inputSha256, allowProjectFile) {
  if (!isRecord2(value)) {
    throw new TypeError(`${label} provenance is invalid`);
  }
  if (value.kind === "project-file") {
    if (!allowProjectFile || value.path !== "partitions.csv" || inputPath !== value.path || !isSha256(value.projectSha256) || !isSha256(value.fileSha256) || value.fileSha256 !== inputSha256) {
      throw new TypeError(`${label} project-file provenance is invalid`);
    }
    return Object.freeze({
      kind: "project-file",
      path: value.path,
      projectSha256: value.projectSha256,
      fileSha256: value.fileSha256
    });
  }
  if (!stablePackIdentity(value.packId) || !isSha256(value.packSha256)) {
    throw new TypeError(`${label} provenance is invalid`);
  }
  if (value.packId !== boardPack.id || value.packSha256 !== boardPack.sha256) {
    throw new TypeError(`${label} provenance does not match the selected Board Pack`);
  }
  if (value.kind === "pack-artifact") {
    if (!Number.isSafeInteger(value.packSchema) || value.packSchema < 1 || !stablePackIdentity(value.artifactId)) {
      throw new TypeError(`${label} artifact provenance is invalid`);
    }
    return Object.freeze({
      kind: "pack-artifact",
      packId: value.packId,
      packSha256: value.packSha256,
      packSchema: value.packSchema,
      artifactId: value.artifactId
    });
  }
  if (value.kind === "pack-file" && stablePackIdentity(value.selector)) {
    return Object.freeze({
      kind: "pack-file",
      packId: value.packId,
      packSha256: value.packSha256,
      selector: value.selector
    });
  }
  throw new TypeError(`${label} file provenance is invalid`);
}
function stablePackIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(value);
}
function requirePathExtension(path, extension, label) {
  if (!path.toLowerCase().endsWith(extension)) {
    throw new TypeError(`${label} must reference a ${extension} input`);
  }
}
function requiredProductOffset(offsets, productId) {
  const offset = offsets.get(productId);
  if (!offset) throw new TypeError(`ESP32 post-link offset is missing: ${productId}`);
  return offset;
}
function freezeProduct(value) {
  return Object.freeze(value);
}
function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function deriveArchiveRecipe(recipes, lowering, properties) {
  const recipe = requiredRecipe(recipes, lowering.bindings.archive);
  const expanded = expandRecipeArguments(recipe, properties);
  const executable = expanded[0];
  if (!hasPlatformPropertyDependency(executable, "compiler.ar.cmd") && !/(?:^|[\\/-])(?:gcc-)?ar(?:\.exe)?$/i.test(executable.value)) {
    throw new TypeError("Platform archive recipe executable is not bound to compiler.ar.cmd");
  }
  const argumentsList = expanded.slice(1);
  const operation = argumentsList.filter((argument) => (argument.value === "cr" || argument.value === lowering.archive.operation) && (hasPlatformPropertyDependency(argument, "compiler.ar.flags") || argument.dependencies.size === 0));
  const output = argumentsList.filter((argument) => hasPlatformPropertyDependency(argument, "archive_file_path"));
  const inputs = argumentsList.filter((argument) => hasPlatformPropertyDependency(argument, "object_file"));
  if (operation.length !== 1) {
    throw new TypeError("Platform archive recipe must contain exactly one cr or rcs operation");
  }
  if (output.length !== 1 || inputs.length !== 1) {
    throw new TypeError("Platform archive recipe must contain exactly one output and object input");
  }
  const structural = /* @__PURE__ */ new Set([operation[0], output[0], inputs[0]]);
  const flags = [];
  for (const argument of argumentsList) {
    if (structural.has(argument)) continue;
    if (!hasPlatformPropertyDependency(argument, "compiler.ar.extra_flags")) {
      throw new TypeError(`Platform archive recipe contains an unmodeled argument: ${argument.value}`);
    }
    flags.push(argument.value);
  }
  return Object.freeze({
    recipeId: lowering.bindings.archive,
    command: lowering.archive.command,
    operation: lowering.archive.operation,
    argumentOrder: Object.freeze([
      "operation",
      "output",
      "inputs",
      "flags"
    ]),
    flags: Object.freeze(flags)
  });
}
function expandRecipeArguments(recipe, properties) {
  const result = [];
  for (const raw of recipe.argv) {
    const expanded = expandPlatformProperty(properties, raw);
    if (!expanded.value.trim()) continue;
    for (const rawValue of tokenizeRecipe(expanded.value)) {
      const value = normalizeArduinoRecipeArgument(rawValue);
      if (value === "@" || /\{[^{}]+\}/.test(value)) continue;
      result.push(Object.freeze({ value, dependencies: expanded.dependencies }));
    }
  }
  if (!result.length) {
    throw new TypeError(`Platform recipe ${recipe.id} expands to an empty command`);
  }
  return result;
}
function normalizeArduinoRecipeArgument(value) {
  for (const prefix of ["-DARDUINO_BOARD=", "-DARDUINO_VARIANT="]) {
    if (value.startsWith(prefix) && !value.startsWith(`${prefix}"`)) {
      return `${prefix}"${value.slice(prefix.length)}"`;
    }
  }
  return value;
}
function validateRecipeCommandInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.recipes) || !input.properties || typeof input.properties !== "object" || Array.isArray(input.properties)) {
    throw new TypeError("Platform recipe command input is invalid");
  }
  return requireRecipeLoweringV2(input.recipeLowering);
}
function requiredRecipe(recipes, id) {
  const matches = recipes.filter((recipe) => recipe.id === id);
  if (matches.length !== 1) {
    throw new TypeError(`CK Platform Manifest must contain exactly one ${id} recipe`);
  }
  return matches[0];
}
function requireRecipeLoweringV2(value) {
  const candidate = value;
  const compile = candidate?.bindings?.compile;
  if (candidate?.schemaVersion !== CK_RECIPE_LOWERING_SCHEMA_VERSION || !compile || typeof compile !== "object" || Array.isArray(compile) || ["c", "cxx", "asm"].some((language) => typeof compile[language] !== "string" || !compile[language].trim()) || typeof candidate.bindings?.archive !== "string" || !candidate.bindings.archive.trim() || typeof candidate.bindings?.link !== "string" || !candidate.bindings.link.trim() || candidate.archive?.command !== "ar" || candidate.archive.operation !== "rcs" || canonicalJson(candidate.archive.argumentOrder) !== canonicalJson([
    "operation",
    "output",
    "inputs",
    "flags"
  ])) {
    throw new TypeError("Platform recipe command lowering requires schema 2 bindings");
  }
  return candidate;
}

// packages/core/src/build-ir/platform-planning.ts
var CK_BROWSER_PLATFORM_PATH_LAYOUT = Object.freeze({
  exact: Object.freeze({
    "core.a": "packs/platform/core.a",
    core: "packs/platform/core",
    variant: "packs/board/variant"
  }),
  prefixes: Object.freeze({
    "sdk/": "packs/platform/sdk/",
    "core/": "packs/platform/core/",
    "variant/": "packs/board/variant/",
    "runtime/": "packs/toolchain/runtime/"
  })
});
function lowerEsp32PostLinkTransforms(contract, tools) {
  verifyEsp32PostLinkContract(contract);
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new TypeError("ESP32 post-link tool bindings are invalid");
  }
  return contract.products.map((product) => lowerEsp32PostLinkProduct(product, tools, contract));
}
function lowerEsp32PostLinkProduct(product, tools, contract) {
  const operation = product.operation;
  const packInputs = operationPackInputs(operation);
  const contractFlag = `--ck-post-link-contract=${contract.sha256}`;
  const base = {
    id: product.id,
    productId: product.productId,
    lifecycle: product.lifecycle,
    format: product.format,
    output: product.output,
    ...product.lifecycle === "configuration" ? { packDependencies: [contract.source.boardPackId] } : {},
    ...packInputs.length ? { packInputs } : {},
    ...product.offset === void 0 ? {} : { offset: product.offset }
  };
  if (operation.kind === "esp32.elf2image") {
    const input = actionInput(operation.input);
    const flags = esp32ImageFlags(operation);
    const argumentsList = [
      "--chip",
      operation.chip,
      "elf2image",
      "--flash-mode",
      operation.flashMode,
      "--flash-freq",
      operation.flashFrequency,
      "--flash-size",
      operation.flashSize,
      ...operation.elfSha256Offset === void 0 ? [] : ["--elf-sha256-offset", operation.elfSha256Offset],
      "-o",
      product.output,
      operation.input.path
    ];
    return {
      ...base,
      input: operation.input.path,
      inputs: [input],
      flags: [...flags, contractFlag],
      tool: requiredPostLinkTool(tools.elf2image, operation.kind),
      arguments: argumentsList,
      dependencies: actionInputDependencies([operation.input])
    };
  }
  if (operation.kind === "esp32.partition-bin") {
    return {
      ...base,
      input: operation.input.path,
      inputs: [actionInput(operation.input)],
      flags: ["--quiet=true", contractFlag],
      tool: requiredPostLinkTool(tools.partitionBin, operation.kind),
      arguments: ["-q", operation.input.path, product.output],
      dependencies: []
    };
  }
  if (operation.kind === "materialize") {
    return {
      ...base,
      input: operation.input.path,
      inputs: [actionInput(operation.input)],
      flags: [contractFlag],
      tool: requiredPostLinkTool(tools.materialize, operation.kind),
      arguments: [operation.input.path, "-o", product.output],
      dependencies: []
    };
  }
  const inputs = operation.segments.map((segment) => actionInput(segment.input));
  if (!inputs.length) throw new TypeError("ESP32 merge operation has no inputs");
  return {
    ...base,
    input: inputs[0].path,
    inputs,
    flags: [
      `--chip=${operation.chip}`,
      `--pad-to-size=${operation.padToSize}`,
      "--flash-mode=keep",
      "--flash-freq=keep",
      "--flash-size=keep",
      contractFlag
    ],
    tool: requiredPostLinkTool(tools.mergeBin, operation.kind),
    arguments: [
      "--chip",
      operation.chip,
      "merge-bin",
      "-o",
      product.output,
      "--pad-to-size",
      operation.padToSize,
      "--flash-mode",
      operation.flashMode,
      "--flash-freq",
      operation.flashFrequency,
      "--flash-size",
      operation.flashSize,
      ...operation.segments.flatMap((segment) => [segment.offset, segment.input.path])
    ],
    dependencies: actionInputDependencies(operation.segments.map((segment) => segment.input))
  };
}
function operationPackInputs(operation) {
  return postLinkOperationInputs(operation).flatMap((input) => {
    if (input.kind !== "immutable" || input.provenance.kind !== "pack-artifact") return [];
    return [{
      kind: "pack-artifact",
      packId: input.provenance.packId,
      packRevision: input.provenance.packSha256,
      packSchema: input.provenance.packSchema,
      artifactId: input.provenance.artifactId,
      sha256: input.sha256,
      role: input.role
    }];
  });
}
function postLinkOperationInputs(operation) {
  return operation.kind === "esp32.merge-bin" ? operation.segments.map((segment) => segment.input) : [operation.input];
}
function esp32ImageFlags(operation) {
  return [
    `--chip=${operation.chip}`,
    `--flash-mode=${operation.flashMode}`,
    `--flash-freq=${operation.flashFrequency}`,
    `--flash-size=${operation.flashSize}`,
    ...operation.elfSha256Offset === void 0 ? [] : [`--elf-sha256-offset=${operation.elfSha256Offset}`]
  ];
}
function actionInput(input) {
  return {
    path: input.path,
    role: input.role,
    ...input.kind === "immutable" ? { sha256: input.sha256 } : {}
  };
}
function actionInputDependencies(inputs) {
  return [...new Set(inputs.filter((input) => input.kind === "action-output").map((input) => input.actionId))].sort(compareStrings);
}
function requiredPostLinkTool(value, operation) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`ESP32 post-link tool is unavailable for ${operation}`);
  }
  return value;
}
function verifyEsp32PostLinkContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract) || contract.kind !== "ck-esp32-post-link-contract" || contract.schemaVersion !== 1 || typeof contract.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(contract.sha256) || !Array.isArray(contract.products)) {
    throw new TypeError("ESP32 post-link contract is invalid");
  }
  const { sha256, ...body } = contract;
  if (sha256Hex(canonicalJson(body)) !== sha256) {
    throw new TypeError("ESP32 post-link contract sha256 mismatch");
  }
  const hasModel = contract.products.some((product) => product.productId === "model");
  const expected = hasModel ? ["application", "bootloader", "partitions", "boot-app0", "model", "merged"] : ["application", "bootloader", "partitions", "boot-app0", "merged"];
  if (contract.products.length !== expected.length || contract.products.some((product, index) => product.productId !== expected[index])) {
    throw new TypeError("ESP32 post-link contract product order is invalid");
  }
}
function lowerPlatformBuildCommands(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Platform planning input is invalid");
  }
  const lowering = input.recipeLowering;
  const compile = splitCompileArguments(input.compile, input.pathLayout);
  const link = splitLinkArguments(input.link, input.pathLayout, lowering?.responseFiles);
  const splitFlags = splitCompileLanguageFlags(compile.flags, lowering?.responseFiles.languageFiles);
  const explicitFlags = remapCompilerFlags(
    normalizeCompilerFlags(input.languageFlags),
    input.pathLayout
  );
  const flags = {
    common: [...splitFlags.common, ...explicitFlags.common],
    c: [...splitFlags.c, ...explicitFlags.c],
    cxx: [...splitFlags.cxx, ...explicitFlags.cxx],
    asm: [...splitFlags.asm, ...explicitFlags.asm]
  };
  const compilerInputs = responseFileInputs(
    [...flags.common, ...flags.c, ...flags.cxx, ...flags.asm],
    lowering?.responseFiles.marker ?? "@",
    lowering?.responseFiles.roles.compiler ?? "compiler-response-file"
  );
  return {
    macros: compile.macros,
    includePaths: compile.includePaths,
    flags,
    compilerInputs,
    linkerFlags: link.prefix,
    linkerInputs: link.inputs,
    linkerTailFlags: link.tail
  };
}
function splitCompileArguments(command, layout) {
  if (!command || !Array.isArray(command.args) || typeof command.source !== "string" || typeof command.object !== "string") {
    throw new TypeError("Platform Manifest compile command is invalid");
  }
  const flags = [];
  const macros = {};
  const includePaths = [];
  let sourceCount = 0;
  let outputCount = 0;
  let compileCount = 0;
  for (let index = 1; index < command.args.length; index += 1) {
    const argument = command.args[index];
    if (typeof argument !== "string") throw new TypeError("Platform Manifest argument is invalid");
    if (argument === command.source) {
      sourceCount += 1;
      continue;
    }
    if (argument === "-o" && command.args[index + 1] === command.object) {
      outputCount += 1;
      index += 1;
      continue;
    }
    if (argument === "-c") {
      compileCount += 1;
      continue;
    }
    const logical = logicalArgument(argument, layout);
    if (logical.startsWith("-D") && logical.length > 2) {
      const definition = logical.slice(2);
      const equals = definition.indexOf("=");
      const key = equals < 0 ? definition : definition.slice(0, equals);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        macros[key] = equals < 0 ? true : definition.slice(equals + 1);
        continue;
      }
    }
    if (logical.startsWith("-I") && logical.length > 2) {
      includePaths.push(logical.slice(2));
      continue;
    }
    flags.push(logical);
  }
  if (sourceCount !== 1 || outputCount !== 1 || compileCount !== 1) {
    throw new TypeError("Platform Manifest compile placeholders are invalid");
  }
  return { flags, macros, includePaths };
}
function splitCompileLanguageFlags(flags, languageFiles) {
  const common = [];
  const c = [];
  const cxx = [];
  const asm = [];
  const cFile = languageFiles?.c ?? "c_flags";
  const cxxFile = languageFiles?.cxx ?? "cpp_flags";
  const asmFile = languageFiles?.asm ?? "S_flags";
  for (const flag of flags) {
    if (flag.startsWith("@") && flag.endsWith(`/${cFile}`)) c.push(flag);
    else if (flag.startsWith("@") && flag.endsWith(`/${cxxFile}`)) cxx.push(flag);
    else if (flag.startsWith("@") && flag.endsWith(`/${asmFile}`)) asm.push(flag);
    else common.push(flag);
  }
  return { common, c, cxx, asm };
}
function splitLinkArguments(command, layout, responseFiles) {
  if (!command || !Array.isArray(command.args) || typeof command.object !== "string" || typeof command.elf !== "string") {
    throw new TypeError("Platform Manifest link command is invalid");
  }
  const coreArchive = command.coreArchive ?? "core.a";
  const prefix = [];
  const tail = [];
  let objectCount = 0;
  let outputCount = 0;
  let coreCount = 0;
  let afterObject = false;
  for (let index = 1; index < command.args.length; index += 1) {
    const argument = command.args[index];
    if (typeof argument !== "string") throw new TypeError("Platform Manifest argument is invalid");
    if (argument === command.object) {
      objectCount += 1;
      afterObject = true;
      continue;
    }
    if (argument === coreArchive) {
      coreCount += 1;
      afterObject = true;
      continue;
    }
    if (argument === "-o" && command.args[index + 1] === command.elf) {
      outputCount += 1;
      index += 1;
      continue;
    }
    (afterObject ? tail : prefix).push(logicalArgument(argument, layout));
  }
  if (objectCount !== 1 || outputCount !== 1 || coreCount !== 1) {
    throw new TypeError("Platform Manifest link placeholders are invalid");
  }
  return {
    prefix,
    tail,
    inputs: responseFileInputs(
      [...prefix, ...tail],
      responseFiles?.marker ?? "@",
      responseFiles?.roles.linker ?? "linker-response-file"
    )
  };
}
function responseFileInputs(argumentsList, marker, role) {
  return uniqueInputs(argumentsList.filter((argument) => argument.startsWith(marker)).map((argument) => ({ path: argument.slice(marker.length), role })));
}
function logicalArgument(argument, layout) {
  if (argument.startsWith("@")) return `@${resolvePlatformLogicalPath(argument.slice(1), layout)}`;
  const joinedPath = argument.match(/^(-[IL])(.+)$/);
  if (joinedPath) return `${joinedPath[1]}${resolvePlatformLogicalPath(joinedPath[2], layout)}`;
  return resolvePlatformLogicalPath(argument, layout);
}
function resolvePlatformLogicalPath(path, layout) {
  if (typeof path !== "string") throw new TypeError("Platform Manifest path is invalid");
  const exact = layout?.exact?.[path];
  if (exact !== void 0) return exact;
  const prefixes = Object.entries(layout?.prefixes ?? {}).sort(([left], [right]) => right.length - left.length || compareStrings(left, right));
  for (const [prefix, replacement] of prefixes) {
    if (path.startsWith(prefix)) return `${replacement}${path.slice(prefix.length)}`;
  }
  return path;
}
function invertPlatformLogicalPathLayout(layout) {
  if (!layout) return void 0;
  const exact = Object.fromEntries(Object.entries(layout.exact ?? {}).map(([from, to]) => [to, from]));
  const prefixes = Object.fromEntries(Object.entries(layout.prefixes ?? {}).map(([from, to]) => [to, from]));
  if (new Set(Object.keys(exact)).size !== Object.keys(layout.exact ?? {}).length || new Set(Object.keys(prefixes)).size !== Object.keys(layout.prefixes ?? {}).length) {
    throw new TypeError("Platform path layout cannot be inverted because destinations are duplicated");
  }
  return { exact, prefixes };
}
function normalizeCompilerFlags(value) {
  const normalize = (flags, label) => {
    if (flags === void 0) return [];
    if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string")) {
      throw new TypeError(`Platform ${label} flags are invalid`);
    }
    return [...flags];
  };
  return {
    common: normalize(value?.common, "common compiler"),
    c: normalize(value?.c, "C compiler"),
    cxx: normalize(value?.cxx, "C++ compiler"),
    asm: normalize(value?.asm, "assembler")
  };
}
function remapCompilerFlags(value, layout) {
  const remap = (flags) => flags.map((flag) => logicalArgument(flag, layout));
  return {
    common: remap(value.common),
    c: remap(value.c),
    cxx: remap(value.cxx),
    asm: remap(value.asm)
  };
}
function uniqueInputs(inputs) {
  const byPath = /* @__PURE__ */ new Map();
  for (const input of inputs) if (!byPath.has(input.path)) byPath.set(input.path, input);
  return [...byPath.values()].sort((left, right) => compareStrings(left.path, right.path));
}
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
export {
  CK_BROWSER_PLATFORM_PATH_LAYOUT,
  CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION,
  deriveEsp32PostLinkContract,
  derivePlatformArchiveCommand,
  invertPlatformLogicalPathLayout,
  lowerEsp32PostLinkTransforms,
  lowerPlatformBuildCommands,
  resolvePlatformLogicalPath
};
