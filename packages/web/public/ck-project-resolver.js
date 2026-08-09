// Generated CK project resolver. Build IR planning is provided only by ck-build-core Rust/WASM.

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

// packages/core/src/build-ir/builder.ts
var ACTION_BASE_FIELDS = [
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
  "cacheKey"
];
var ACTION_FIELDS = {
  compile: /* @__PURE__ */ new Set([...ACTION_BASE_FIELDS, "compileUnit"]),
  archive: /* @__PURE__ */ new Set([...ACTION_BASE_FIELDS, "archive"]),
  link: /* @__PURE__ */ new Set([...ACTION_BASE_FIELDS, "link"]),
  transform: /* @__PURE__ */ new Set([...ACTION_BASE_FIELDS, "transform"])
};
function resolveProject(input) {
  if ("files" in input) return resolveProject(input.files);
  const files = input.map((file) => {
    const path = normalizePath(file.path, "project file");
    return {
      path,
      content: file.content,
      language: file.language ?? inferLanguage(path),
      generated: file.generated ?? false,
      sha256: sha256Hex(file.content),
      size: utf8Size(file.content)
    };
  }).sort((left, right) => compareText2(left.path, right.path));
  assertUniqueCaseFolded(files.map((file) => file.path), "project file");
  const sha256 = sha256Hex(canonicalJson(files.map((file) => ({
    path: file.path,
    content: file.content,
    language: file.language,
    generated: file.generated
  }))));
  return { files, sha256 };
}
function normalizePath(value, label) {
  const path = value.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) {
    throw new TypeError(`${label} path must be relative and must not contain '..': ${value}`);
  }
  return path.split("/").filter((part) => part.length > 0 && part !== ".").join("/");
}
function inferLanguage(path) {
  const extension2 = path.toLowerCase().split(".").pop() ?? "";
  if (extension2 === "ino") return "ino";
  if (extension2 === "c") return "c";
  if (extension2 === "cc" || extension2 === "cpp" || extension2 === "cxx") return "c++";
  if (extension2 === "s" || extension2 === "S".toLowerCase() || extension2 === "asm") return "asm";
  if (extension2 === "h" || extension2 === "hh" || extension2 === "hpp" || extension2 === "hxx") return "header";
  return "other";
}
function utf8Size(value) {
  return new TextEncoder().encode(value).byteLength;
}
function assertUniqueCaseFolded(values, label) {
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    const folded = value.toLowerCase();
    if (seen.has(folded)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(folded);
  }
}
function compareText2(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// packages/core/src/build-ir/local-libraries.ts
var SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([".c", ".cc", ".cpp", ".cxx", ".S", ".s"]);
var HEADER_EXTENSIONS = /* @__PURE__ */ new Set([".h", ".hh", ".hpp", ".hxx"]);
var INCLUDE_FRAGMENT_EXTENSIONS = /* @__PURE__ */ new Set([".inc", ".ipp", ".tpp"]);
var METADATA_NAMES = /* @__PURE__ */ new Set(["library.properties", "license", "licence", "copying", "notice", "authors", "readme"]);
function resolveLocalLibraries(files, architecture, externalLibraries = []) {
  const projectFiles = files.map((file) => ({ ...file, path: normalizeProjectPath(file.path) }));
  const candidates = discoverCandidates(projectFiles, architecture);
  if (!candidates.length) {
    return {
      projectFiles,
      projectCompilePaths: projectFiles.map((file) => file.path),
      libraries: []
    };
  }
  const byName = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const key = candidate.manifest.name.toLowerCase();
    if (byName.has(key)) throw new TypeError("duplicate local library name: " + candidate.manifest.name);
    byName.set(key, candidate);
  }
  const externalByName = /* @__PURE__ */ new Map();
  for (const pack of externalLibraries) externalByName.set(pack.name.toLowerCase(), pack);
  const hashMemo = /* @__PURE__ */ new Map();
  const hashVisiting = /* @__PURE__ */ new Set();
  const localId = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const stem = candidate.manifest.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "library";
    localId.set(candidate.manifest.name.toLowerCase(), "local-library-" + stem + "-" + sha256Hex(candidate.rootPath).slice(0, 12));
  }
  const libraries = candidates.map((candidate) => {
    const dependencies = candidate.manifest.depends.map((name) => {
      const local = localId.get(name.toLowerCase());
      if (local) {
        const dependency = byName.get(name.toLowerCase());
        return {
          id: local,
          version: dependency.manifest.version,
          sha256: packHash(dependency, localId, byName, externalByName, hashMemo, hashVisiting)
        };
      }
      const external = externalByName.get(name.toLowerCase());
      if (external) return { id: external.id, version: external.version, sha256: external.sha256 };
      throw new TypeError("local library " + candidate.manifest.name + " references missing dependency " + name);
    });
    const pack = {
      kind: "library",
      id: localId.get(candidate.manifest.name.toLowerCase()),
      name: candidate.manifest.name,
      version: candidate.manifest.version,
      sha256: packHash(candidate, localId, byName, externalByName, hashMemo, hashVisiting),
      architectures: candidate.manifest.architectures,
      ...candidate.manifest.license ? { license: candidate.manifest.license } : {},
      manifest: manifestRecord(candidate.manifest),
      dependencies
    };
    return {
      pack,
      files: candidate.files,
      includePaths: candidate.layout === "1.5" ? ["src"] : [".", "utility"],
      rootPath: candidate.rootPath
    };
  });
  const localRoots = candidates.map((candidate) => candidate.rootPath);
  const isLocal = (path) => localRoots.some((root) => path === root || path.startsWith(root + "/"));
  return {
    projectFiles,
    projectCompilePaths: projectFiles.filter((file) => !isLocal(file.path)).map((file) => file.path),
    libraries
  };
}
function discoverLocalLibraryExternalDependencies(files) {
  const manifests = files.map((file) => ({ ...file, path: normalizeProjectPath(file.path) })).filter((file) => /^libraries\/[^/]+\/library\.properties$/.test(file.path)).sort((left, right) => compareText3(left.path, right.path)).map((file) => {
    const manifest = parseLocalManifest(file.content);
    if (!manifest.name) throw new TypeError("local library manifest has no name: " + file.path);
    return manifest;
  });
  const localNames = /* @__PURE__ */ new Set();
  for (const manifest of manifests) {
    const key = manifest.name.toLowerCase();
    if (localNames.has(key)) throw new TypeError("duplicate local library name: " + manifest.name);
    localNames.add(key);
  }
  const dependencies = /* @__PURE__ */ new Map();
  for (const manifest of manifests) {
    for (const name of manifest.depends) {
      const key = name.toLowerCase();
      if (!localNames.has(key) && !dependencies.has(key)) dependencies.set(key, name);
    }
  }
  return [...dependencies].sort(([left], [right]) => compareText3(left, right)).map(([, name]) => ({ name }));
}
function discoverCandidates(files, architecture) {
  const byRoot = /* @__PURE__ */ new Map();
  for (const file of files) {
    const match = /^libraries\/([^/]+)\/(.+)$/.exec(file.path);
    if (!match) continue;
    const rootPath = "libraries/" + match[1];
    let entries = byRoot.get(rootPath);
    if (!entries) {
      entries = /* @__PURE__ */ new Map();
      byRoot.set(rootPath, entries);
    }
    entries.set(match[2], file);
  }
  const result = [];
  for (const [rootPath, entries] of [...byRoot].sort(([a], [b]) => compareText3(a, b))) {
    const manifestFile = entries.get("library.properties");
    if (!manifestFile) continue;
    const manifest = parseLocalManifest(manifestFile.content);
    if (!manifest.name) throw new TypeError("local library manifest has no name: " + rootPath + "/library.properties");
    if (!manifest.architectures.some((value) => value === "*" || value.toLowerCase() === architecture.toLowerCase())) {
      throw new TypeError("local library " + manifest.name + " does not support architecture " + architecture);
    }
    const hasSrc = [...entries.keys()].some((path) => path.startsWith("src/"));
    const includeFiles = [...entries.entries()].filter(([path]) => isIncludedLibraryFile(path, hasSrc)).sort(([a], [b]) => compareText3(a, b)).map(([path, file]) => ({ path, content: file.content, language: inferLanguage2(path) }));
    if (!includeFiles.some((file) => SOURCE_EXTENSIONS.has(extension(file.path)) || HEADER_EXTENSIONS.has(extension(file.path)) || INCLUDE_FRAGMENT_EXTENSIONS.has(extension(file.path)))) {
      throw new TypeError("local library " + manifest.name + " has no source or headers");
    }
    result.push({
      rootPath,
      manifestText: manifestFile.content,
      manifest,
      files: includeFiles,
      layout: hasSrc ? "1.5" : "1.0"
    });
  }
  return result;
}
function isIncludedLibraryFile(path, hasSrc) {
  if (path.startsWith("examples/") || path.startsWith("extras/")) return false;
  if (hasSrc) return path.startsWith("src/") || METADATA_NAMES.has(path.toLowerCase());
  if (path.startsWith("utility/")) return !path.slice("utility/".length).includes("/");
  return !path.includes("/") || METADATA_NAMES.has(path.toLowerCase());
}
function packHash(candidate, localId, byName, external, memo, visiting) {
  const candidateKey = candidate.manifest.name.toLowerCase();
  const cached = memo.get(candidateKey);
  if (cached) return cached;
  if (visiting.has(candidateKey)) {
    throw new TypeError("local library dependency cycle contains " + candidate.manifest.name);
  }
  visiting.add(candidateKey);
  const dependencies = candidate.manifest.depends.map((name) => {
    const local = localId.get(name.toLowerCase());
    if (local) {
      const dep = byName.get(name.toLowerCase());
      return {
        id: local,
        name: dep.manifest.name,
        version: dep.manifest.version,
        sha256: packHash(dep, localId, byName, external, memo, visiting)
      };
    }
    const pack = external.get(name.toLowerCase());
    return pack ? { id: pack.id, name: pack.name, version: pack.version, sha256: pack.sha256 } : { name };
  });
  const content = resolveProject(candidate.files).files.map((file) => ({ path: file.path, sha256: file.sha256 }));
  const hash = sha256Hex(canonicalJson({
    schema: 1,
    manifest: candidate.manifestText,
    name: candidate.manifest.name,
    version: candidate.manifest.version,
    architectures: candidate.manifest.architectures,
    dependencies,
    content
  }));
  visiting.delete(candidateKey);
  memo.set(candidateKey, hash);
  return hash;
}
function manifestRecord(manifest) {
  return Object.fromEntries(Object.entries({
    name: manifest.name,
    version: manifest.version,
    architectures: manifest.architectures.join(","),
    ...manifest.depends.length ? { depends: manifest.depends.join(",") } : {},
    ...manifest.category ? { category: manifest.category } : {},
    ...manifest.license ? { license: manifest.license } : {}
  }).sort(([a], [b]) => compareText3(a, b)));
}
function parseLocalManifest(text) {
  const values = /* @__PURE__ */ new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim());
  }
  const list = (key) => (values.get(key) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return {
    name: values.get("name") ?? "",
    version: values.get("version") ?? "0.0.0",
    architectures: list("architectures").length ? list("architectures") : ["*"],
    depends: list("depends").map((value) => value.replace(/\s*\(.*\)\s*$/, "").trim()).filter(Boolean),
    ...values.get("category") ? { category: values.get("category") } : {},
    ...values.get("license") ? { license: values.get("license") } : {}
  };
}
function inferLanguage2(path) {
  const ext = extension(path);
  if (ext === ".ino") return "ino";
  if (ext === ".c") return "c";
  if (ext === ".s") return "asm";
  if (SOURCE_EXTENSIONS.has(ext)) return "c++";
  if (HEADER_EXTENSIONS.has(ext)) return "header";
  return "other";
}
function extension(path) {
  return path.slice(path.lastIndexOf(".")).toLowerCase();
}
function normalizeProjectPath(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("project file path is invalid: " + path);
  }
  return normalized;
}
function compareText3(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
export {
  discoverLocalLibraryExternalDependencies,
  resolveLocalLibraries
};
