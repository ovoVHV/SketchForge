import createCompiler from './tools/cc1plus.mjs';
import createAssembler from './tools/avr-as.mjs';
import createLinker from './tools/avr-ld.mjs';
import createObjcopy from './tools/avr-objcopy.mjs';
import { preprocess } from './preprocess.js';
import { decodeArduinoSketchAction } from '../../arduino-sketch.js';
import { createBrowserToolchainPackLoader } from './toolchain-pack.js';
import { createVerifiedEmscriptenModule } from './verified-emscripten.js';
import { AVR_TOOLCHAIN_PACK } from './release.js';

const WORKSPACE = '/workspace/';
const TOOL_PREFIX = `toolchain:${AVR_TOOLCHAIN_PACK.id}`;
const TOOLS = Object.freeze({
  preprocess: 'ck:arduino-preprocess',
  compiler: `${TOOL_PREFIX}:avr-g++`,
  linker: `${TOOL_PREFIX}:avr-ld`,
  objcopy: `${TOOL_PREFIX}:avr-objcopy`,
});
const TOOL_MODULES = Object.freeze({
  compiler: Object.freeze({ factory: createCompiler, wasmArtifact: 'cc1plus-wasm' }),
  assembler: Object.freeze({ factory: createAssembler, wasmArtifact: 'avr-as-wasm' }),
  linker: Object.freeze({ factory: createLinker, wasmArtifact: 'avr-ld-wasm' }),
  objcopy: Object.freeze({ factory: createObjcopy, wasmArtifact: 'avr-objcopy-wasm' }),
});
const COMPILE_FLAGS = Object.freeze([
  '-mmcu=atmega328p',
  '-mn-flash=1',
  '-mno-skip-bug',
  '-Os',
  '-ffunction-sections',
  '-fdata-sections',
  '-std=gnu++11',
  '-fpermissive',
  '-fno-exceptions',
  '-fno-threadsafe-statics',
  '-fno-rtti',
  '-fno-enforce-eh-specs',
]);
const INCLUDE_PATHS = Object.freeze([
  'packs/board/variant',
  'packs/platform/core',
  'packs/toolchain/sysroot/avr/include',
  'packs/toolchain/sysroot/gcc/include',
]);
const COMPILER_INCLUDE_ORDER = Object.freeze([
  'packs/toolchain/sysroot/gcc/include',
  'packs/toolchain/sysroot/avr/include',
  'packs/platform/core',
  'packs/board/variant',
]);
const MACROS = Object.freeze({
  ARDUINO: '10819',
  ARDUINO_ARCH_AVR: true,
  ARDUINO_AVR_UNO: true,
  F_CPU: '16000000L',
  __AVR_ATmega328P__: true,
  __AVR_DEVICE_NAME__: 'atmega328p',
});

/** Create the Worker-local adapter that executes one CK Build IR Action at a time. */
export function createAvrBrowserActionExecutor({
  assetsBase,
  createPackLoader = createBrowserToolchainPackLoader,
  createModule = createVerifiedEmscriptenModule,
  preprocessSketch = preprocess,
} = {}) {
  if (typeof createPackLoader !== 'function' || typeof createModule !== 'function') {
    throw new TypeError('AVR Action executor dependencies are invalid');
  }
  if (typeof preprocessSketch !== 'function') throw new TypeError('AVR preprocessor is invalid');
  const base = new URL(String(assetsBase), import.meta.url);
  const loader = createPackLoader({
    manifestUrl: new URL('toolchain.json', base),
    expectedId: AVR_TOOLCHAIN_PACK.id,
    expectedRevision: AVR_TOOLCHAIN_PACK.revision,
  });
  let closed = false;

  return Object.freeze({
    async execute(action, inputFiles, { signal } = {}) {
      if (closed) throw actionError('session_closed', 'internal', 'AVR Action executor is closed');
      if (signal?.aborted) throw actionError('aborted', 'internal', 'AVR Action was aborted');
      const inputs = normalizeActionInputs(action, inputFiles);
      if (action.kind === 'compile' && action.tool === TOOLS.compiler) {
        return executeCompileAction({ action, inputs, loader, createModule });
      }
      if (action.kind === 'link' && action.tool === TOOLS.linker) {
        return executeToolAction({ action, inputs, loader, createModule, tool: 'linker' });
      }
      if (action.kind === 'transform' && action.tool === TOOLS.objcopy) {
        return executeToolAction({ action, inputs, loader, createModule, tool: 'objcopy' });
      }
      if (action.kind === 'transform' && action.tool === TOOLS.preprocess) {
        return executePreprocessAction(action, inputs, preprocessSketch);
      }
      throw actionError('unsupported_action', 'integrity', `unsupported AVR Action: ${String(action?.tool)}`);
    },
    close() {
      closed = true;
      loader.reset?.();
    },
    get closed() { return closed; },
  });
}

async function executePreprocessAction(action, inputs, preprocessSketch) {
  const task = validateTransformTask(action, 'other');
  try {
    const sketch = decodeArduinoSketchAction(action, inputs);
    const result = preprocessSketch(sketch.source, { sourceName: sketch.sourceName });
    if (!result || typeof result.cpp !== 'string') {
      throw new TypeError('AVR preprocessor returned an invalid result');
    }
    return {
      outputs: [{ path: task.output, bytes: new TextEncoder().encode(result.cpp) }],
      diagnostics: [],
    };
  } catch (error) {
    if (error?.reason) throw error;
    const integrity = error instanceof TypeError;
    throw actionError(
      integrity ? 'invalid_action' : 'preprocess_failed',
      integrity ? 'integrity' : 'compile',
      errorMessage(error),
    );
  }
}

async function executeCompileAction({ action, inputs, loader, createModule }) {
  const unit = action.compileUnit;
  if (!unit || unit.language !== 'c++') {
    throw actionError('invalid_action', 'integrity', `AVR compile Action ${action.id} is invalid`);
  }
  assertLogicalPath(unit.source, `AVR compile Action ${action.id} source`);
  assertLogicalPath(unit.output, `AVR compile Action ${action.id} output`);
  if (!inputs.has(unit.source) || action.outputs.length !== 1 || action.outputs[0].path !== unit.output) {
    throw actionError('invalid_action', 'integrity', `AVR compile Action ${action.id} paths are invalid`);
  }
  assertExactArray(unit.flags, COMPILE_FLAGS, `AVR compile Action ${action.id} flags`);
  assertExactArray(unit.includePaths, INCLUDE_PATHS, `AVR compile Action ${action.id} include paths`);
  assertExactRecord(unit.macros, MACROS, `AVR compile Action ${action.id} macros`);

  const assemblyPath = '/tmp/ck-avr-action.s';
  const compiler = await runTool({
    name: 'compiler',
    loader,
    createModule,
    arguments: compilerArguments(unit, assemblyPath),
    populate: (fs) => materializeLogicalInputs(fs, inputs),
    outputPath: assemblyPath,
    diagnosticFallback: unit.source,
  });
  const objectPath = logicalToVirtual(unit.output);
  const assembler = await runTool({
    name: 'assembler',
    loader,
    createModule,
    arguments: ['-mmcu=atmega328p', '-o', objectPath, assemblyPath],
    populate(fs) { writeVirtualFile(fs, assemblyPath, compiler.bytes); },
    outputPath: objectPath,
    diagnosticFallback: unit.source,
  });
  return {
    outputs: [{ path: unit.output, bytes: assembler.bytes }],
    diagnostics: [...compiler.diagnostics, ...assembler.diagnostics],
  };
}

async function executeToolAction({ action, inputs, loader, createModule, tool }) {
  const task = tool === 'linker'
    ? validateLinkTask(action)
    : validateTransformTask(action, 'hex');
  const output = task.output;
  const outputPath = logicalToVirtual(output);
  if (action.outputs.length !== 1 || action.outputs[0].path !== output) {
    throw actionError('invalid_action', 'integrity', `AVR ${tool} Action ${action.id} output is invalid`);
  }
  if (tool === 'objcopy') {
    const expected = ['-O', 'ihex', '-R', '.eeprom', task.input, task.output];
    assertExactArray(action.arguments, expected, `AVR objcopy Action ${action.id} arguments`);
  }
  const declaredPaths = new Set([
    ...action.inputs.map((input) => input.path),
    ...action.outputs.map((candidate) => candidate.path),
  ]);
  const translatedArguments = action.arguments.map((argument) => translateArgument(argument, declaredPaths));
  const result = await runTool({
    name: tool,
    loader,
    createModule,
    arguments: translatedArguments,
    populate: (fs) => materializeLogicalInputs(fs, inputs),
    outputPath,
    diagnosticFallback: tool === 'objcopy' ? task.input : 'build/firmware.elf',
  });
  return {
    outputs: [{ path: output, bytes: result.bytes }],
    diagnostics: result.diagnostics,
  };
}

function compilerArguments(unit, assemblyPath) {
  const macros = Object.entries(unit.macros).sort(([left], [right]) => left.localeCompare(right));
  return [
    '-quiet',
    '-imultilib', 'avr5',
    ...macros.map(([name, value]) => value === true ? `-D${name}` : `-D${name}=${value}`),
    ...COMPILER_INCLUDE_ORDER.flatMap((path) => [
      path.startsWith('packs/toolchain/') ? '-isystem' : '-I',
      logicalToVirtual(path),
    ]),
    logicalToVirtual(unit.source),
    ...unit.flags.filter((flag) => flag !== '-mmcu=atmega328p'),
    '-dumpbase', basename(unit.source),
    '-mmcu=avr5',
    '-auxbase-strip', assemblyPath,
    '-o', assemblyPath,
  ];
}

async function runTool({ name, loader, createModule, arguments: args, populate, outputPath, diagnosticFallback }) {
  const definition = TOOL_MODULES[name];
  const stderr = [];
  let module;
  try {
    module = await createModule({
      loader,
      artifactId: definition.wasmArtifact,
      factory: definition.factory,
      moduleOptions: {
        noInitialRun: true,
        print() {},
        printErr(line) { if (line) stderr.push(String(line)); },
      },
    });
  } catch (error) {
    throw actionError('tool_unavailable', 'tool', errorMessage(error));
  }

  await populate?.(module.FS);
  ensureDirectory(module.FS, outputPath.slice(0, outputPath.lastIndexOf('/')));
  let status = 0;
  try {
    const returned = module.callMain(args);
    if (Number.isInteger(returned)) status = returned;
  } catch (error) {
    const cleanExit = error?.status === 0 || /Program terminated with exit\(0\)/.test(String(error));
    if (!cleanExit) {
      status = Number.isInteger(error?.status) ? error.status : null;
      throw toolFailure(name, status, stderr, errorMessage(error), diagnosticFallback);
    }
  }
  if (status !== 0) throw toolFailure(name, status, stderr, 'non-zero exit', diagnosticFallback);

  let bytes;
  try {
    bytes = module.FS.readFile(outputPath);
  } catch (error) {
    throw actionError('missing_output', 'tool', `${name} did not produce ${outputPath}: ${errorMessage(error)}`);
  }
  return {
    bytes: new Uint8Array(bytes),
    diagnostics: parseToolDiagnostics(stderr, diagnosticFallback),
  };
}

function validateLinkTask(action) {
  const task = action.link;
  if (!task || !Array.isArray(task.objects) || !Array.isArray(task.archives) || !Array.isArray(task.flags)) {
    throw actionError('invalid_action', 'integrity', `AVR link Action ${action.id} is invalid`);
  }
  assertLogicalPath(task.output, `AVR link Action ${action.id} output`);
  const inputPaths = new Set(action.inputs.map((input) => input.path));
  for (const path of [...task.objects, ...task.archives]) {
    assertLogicalPath(path, `AVR link Action ${action.id} input`);
    if (!inputPaths.has(path)) throw actionError('invalid_action', 'integrity', `AVR link Action ${action.id} input is undeclared`);
  }
  if (task.linkerScript !== undefined && !inputPaths.has(task.linkerScript)) {
    throw actionError('invalid_action', 'integrity', `AVR link Action ${action.id} linker script is undeclared`);
  }
  return task;
}

function validateTransformTask(action, format) {
  const task = action.transform;
  if (!task || task.format !== format) {
    throw actionError('invalid_action', 'integrity', `AVR transform Action ${action.id} is invalid`);
  }
  assertLogicalPath(task.input, `AVR transform Action ${action.id} input`);
  assertLogicalPath(task.output, `AVR transform Action ${action.id} output`);
  if (!action.inputs.some((input) => input.path === task.input)
    || !action.outputs.some((output) => output.path === task.output)) {
    throw actionError('invalid_action', 'integrity', `AVR transform Action ${action.id} paths are invalid`);
  }
  return task;
}

function normalizeActionInputs(action, value) {
  if (!action || typeof action !== 'object' || !Array.isArray(action.inputs) || !Array.isArray(action.outputs)
    || !Array.isArray(action.arguments) || typeof action.id !== 'string') {
    throw actionError('invalid_action', 'integrity', 'AVR Action shape is invalid');
  }
  if (!Array.isArray(value) || value.length !== action.inputs.length) {
    throw actionError('invalid_inputs', 'integrity', `AVR Action ${action.id} input count is invalid`);
  }
  const files = new Map();
  for (let index = 0; index < action.inputs.length; index++) {
    const declaration = action.inputs[index];
    const file = value[index];
    assertLogicalPath(declaration?.path, `AVR Action ${action.id} input`);
    if (!file || file.path !== declaration.path || !(file.bytes instanceof Uint8Array) || files.has(file.path)) {
      throw actionError('invalid_inputs', 'integrity', `AVR Action ${action.id} input ${index} is invalid`);
    }
    files.set(file.path, new Uint8Array(file.bytes));
  }
  return files;
}

function materializeLogicalInputs(fs, inputs) {
  for (const [path, bytes] of inputs) writeVirtualFile(fs, logicalToVirtual(path), bytes);
}

function writeVirtualFile(fs, path, bytes) {
  ensureDirectory(fs, path.slice(0, path.lastIndexOf('/')));
  fs.writeFile(path, bytes);
}

function ensureDirectory(fs, path) {
  const segments = path.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    try {
      fs.mkdir(current);
    } catch {
      try { fs.stat(current); } catch (error) { throw error; }
    }
  }
}

function requiredInput(inputs, path) {
  const bytes = inputs.get(path);
  if (!bytes) throw actionError('missing_input', 'integrity', `AVR Action input is missing: ${path}`);
  return bytes;
}

function translateArgument(argument, declaredPaths) {
  if (declaredPaths.has(argument)) return logicalToVirtual(argument);
  if (argument.startsWith('-L')) {
    const directory = argument.slice(2);
    if (isLogicalPath(directory)
      && [...declaredPaths].some((path) => path.startsWith(`${directory}/`))) {
      return `-L${logicalToVirtual(directory)}`;
    }
    throw actionError('invalid_action', 'integrity', `AVR library search path is undeclared: ${directory}`);
  }
  if (argument.includes('/') && isLogicalPath(argument)) {
    throw actionError('invalid_action', 'integrity', `AVR tool path is undeclared: ${argument}`);
  }
  return argument;
}

function logicalToVirtual(path) {
  assertLogicalPath(path, 'AVR logical path');
  return `${WORKSPACE}${path}`;
}

function parseToolDiagnostics(lines, fallbackFile) {
  const diagnostics = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = String(raw).replace(/\x1b\[[0-9;]*m/g, '');
    const match = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/);
    if (!match) continue;
    const diagnostic = {
      severity: match[4],
      file: normalizeDiagnosticFile(match[1], fallbackFile),
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      message: match[5],
      raw: line,
    };
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function normalizeDiagnosticFile(value, fallback) {
  const path = String(value).replaceAll('\\', '/');
  if (path.startsWith(WORKSPACE)) return path.slice(WORKSPACE.length);
  if (path === '<generated>' || isLogicalPath(path)) return path;
  return fallback;
}

function toolFailure(tool, status, stderr, cause, fallbackFile) {
  const suffix = status == null ? '' : ` with status ${status}`;
  const detail = stderr.at(-1) ?? cause;
  return actionError(
    `${tool}_failed`,
    'compile',
    `${tool} failed${suffix}: ${detail}`,
    parseToolDiagnostics(stderr, fallbackFile),
    { tool, status, stderr: [...stderr] },
  );
}

function actionError(code, reason, message, diagnostics = [], fields = {}) {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  error.diagnostics = diagnostics;
  Object.assign(error, fields);
  return error;
}

function assertExactArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || expected.some((value, index) => actual[index] !== value)) {
    throw actionError('invalid_action', 'integrity', `${label} are invalid`);
  }
}

function assertExactRecord(actual, expected, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw actionError('invalid_action', 'integrity', `${label} are invalid`);
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key, index) => actualKeys[index] !== key || actual[key] !== expected[key])) {
    throw actionError('invalid_action', 'integrity', `${label} are invalid`);
  }
}

function assertLogicalPath(value, label) {
  if (!isLogicalPath(value)) throw actionError('invalid_action', 'integrity', `${label} is invalid`);
}

function isLogicalPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
