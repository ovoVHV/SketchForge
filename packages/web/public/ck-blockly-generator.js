// Generated from @sketchforge/core blocks generator. Do not maintain browser-only code generation.

// packages/core/src/build-ir/canonical.ts
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

// packages/core/src/blocks/generator.ts
function identifier(value) {
  const base = value.normalize("NFKD").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 32) || "value";
  const safe = /^[A-Za-z_]/.test(base) ? base : `v_${base}`;
  return `${safe}_${sha256Hex(value).slice(0, 8)}`;
}
function canonicalBlockVariableName(name, namespace = "project") {
  return `ck_${identifier(`${namespace}:${name}`)}`;
}
function fieldDefinition(input, pinOptions) {
  switch (input.kind) {
    case "value":
      return { type: "input_value", name: input.name, ...input.check === void 0 ? {} : { check: input.check } };
    case "number":
      return {
        type: "field_number",
        name: input.name,
        value: typeof input.default === "number" ? input.default : 0,
        ...input.min === void 0 ? {} : { min: input.min },
        ...input.max === void 0 ? {} : { max: input.max },
        ...input.precision === void 0 ? {} : { precision: input.precision }
      };
    case "text":
      return { type: "field_input", name: input.name, text: String(input.default ?? "") };
    case "boolean":
      return { type: "field_checkbox", name: input.name, checked: input.default === true };
    case "variable":
      return { type: "field_variable", name: input.name, variable: String(input.default ?? input.label) };
    case "pin":
      return {
        type: "field_dropdown",
        name: input.name,
        options: (pinOptions?.length ? pinOptions : [{ label: String(input.default ?? "0"), value: String(input.default ?? "0") }]).map((option) => [option.label, option.value])
      };
    case "dropdown":
      return {
        type: "field_dropdown",
        name: input.name,
        options: (input.options ?? []).map((option) => [option.label, option.value])
      };
  }
}
function definition(block, options) {
  const value = {
    type: block.type,
    message0: block.message,
    args0: block.inputs.map((input) => fieldDefinition(input, options.pinOptions)),
    colour: block.colour,
    tooltip: block.tooltip,
    helpUrl: block.helpUrl ?? ""
  };
  if (block.shape === "statement") {
    value.previousStatement = null;
    value.nextStatement = null;
  } else value.output = block.output ?? null;
  return value;
}
function fieldCode(input, block, generator) {
  if (input.kind === "value") return generator.valueToCode(block, input.name, 0) || String(input.default ?? "0");
  const raw = block.getFieldValue(input.name) ?? input.default ?? "";
  switch (input.kind) {
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new TypeError(`${block.type}.${input.name} is not a finite number`);
      return String(value);
    }
    case "text":
      return JSON.stringify(String(raw));
    case "boolean":
      return raw === true || raw === "TRUE" || raw === "true" ? "true" : "false";
    case "variable": {
      const source = String(raw);
      return generator.nameDB_?.getName(source, "VARIABLE") ?? canonicalBlockVariableName(source);
    }
    case "pin":
      if (!/^(?:[0-9]{1,3}|A[0-9]{1,2}|D[0-9]{1,3}|DAC[0-9]{1,2})$/.test(String(raw))) {
        throw new TypeError(`${block.type}.${input.name} is not a valid pin literal`);
      }
      return String(raw);
    case "dropdown": {
      const option = input.options?.find((candidate) => candidate.value === String(raw));
      if (!option) throw new TypeError(`${block.type}.${input.name} is not an allowed dropdown value`);
      return option.value;
    }
  }
}
function render(template, values, blockType) {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*|var:[A-Za-z][A-Za-z0-9_.:-]*)\s*\}\}/g, (_all, key) => {
    if (key.startsWith("var:")) return canonicalBlockVariableName(key.slice(4), blockType);
    const value = values.get(key);
    if (value === void 0) throw new TypeError(`${blockType} template references missing input ${key}`);
    return value;
  });
}
function normalizeCode(code) {
  return code.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").trim();
}
function renderUnits(units, values, type) {
  return (units ?? []).map((unit) => ({ key: unit.key, code: normalizeCode(render(unit.code, values, type)) }));
}
function createBlocklyLibraryBundle(metadata, options = {}) {
  if (metadata.review.status !== "approved" && !options.allowUnapproved) {
    throw new TypeError("Blockly generation requires approved blocks metadata");
  }
  const byType = new Map(metadata.blocks.map((block) => [block.type, block]));
  return {
    definitions: metadata.blocks.map((block) => definition(block, options)),
    toolbox: {
      kind: "category",
      name: metadata.category.name,
      colour: metadata.category.colour,
      contents: metadata.blocks.map((block) => ({ kind: "block", type: block.type }))
    },
    generate(block, generator) {
      const spec = byType.get(block.type);
      if (!spec) throw new TypeError(`unknown block type: ${block.type}`);
      const values = new Map(spec.inputs.map((input) => [input.name, fieldCode(input, block, generator)]));
      return {
        blockId: block.id,
        type: block.type,
        includes: renderUnits(spec.code.includes, values, spec.type),
        globals: renderUnits(spec.code.globals, values, spec.type),
        setup: renderUnits(spec.code.setup, values, spec.type),
        body: normalizeCode(render(spec.code.body, values, spec.type)),
        shape: spec.shape
      };
    }
  };
}
function uniqueUnits(fragments, region) {
  const byKey = /* @__PURE__ */ new Map();
  for (const fragment of fragments) {
    for (const unit of fragment[region]) {
      const previous = byKey.get(unit.key);
      if (previous !== void 0 && previous !== unit.code) {
        throw new TypeError(`${region} key ${unit.key} has conflicting generated code`);
      }
      byKey.set(unit.key, unit.code);
    }
  }
  return [...byKey].sort(([left], [right]) => left.localeCompare(right)).map(([key, code]) => ({ key, code }));
}
function indent(code, spaces = 2) {
  const prefix = " ".repeat(spaces);
  return normalizeCode(code).split("\n").filter((line) => line.length > 0).map((line) => `${prefix}${line}`);
}
function assembleBlockProgram(fragments) {
  const statements = fragments.filter((fragment) => fragment.shape === "statement");
  const includeUnits = uniqueUnits(fragments, "includes");
  const globalUnits = uniqueUnits(fragments, "globals");
  const setupUnits = uniqueUnits(fragments, "setup");
  const lines = [];
  const appendRegion = (units) => {
    for (const unit of units) lines.push(...normalizeCode(unit.code).split("\n"));
    if (units.length > 0) lines.push("");
  };
  appendRegion(includeUnits);
  appendRegion(globalUnits);
  lines.push("void setup() {");
  for (const unit of setupUnits) lines.push(...indent(unit.code));
  lines.push("}", "", "void loop() {");
  const sourceMap = {};
  const bodyCodes = [];
  for (const fragment of statements) {
    const bodyLines = indent(fragment.body);
    const startLine = lines.length + 1;
    lines.push(...bodyLines);
    sourceMap[fragment.blockId] = { startLine, endLine: Math.max(startLine, lines.length) };
    bodyCodes.push(fragment.body);
  }
  lines.push("}");
  const code = `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}
`;
  return {
    code,
    sourceMap,
    regions: {
      includes: includeUnits.map((unit) => unit.code),
      globals: globalUnits.map((unit) => unit.code),
      setup: setupUnits.map((unit) => unit.code),
      body: bodyCodes
    },
    semanticSha256: sha256Hex(code)
  };
}
export {
  assembleBlockProgram,
  canonicalBlockVariableName,
  createBlocklyLibraryBundle
};
