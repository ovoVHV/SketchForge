import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const sourceRevision = String(process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA ?? '').trim().toLowerCase();
if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) {
  throw new Error('CK_SOURCE_REVISION or GITHUB_SHA must provide the current 40- or 64-character commit digest');
}

// Keep this acceptance test local and deterministic: all compiler resources are
// loaded through the verified CK Pack loader from the checked-in C6 runtime.
const runtimeRoot = resolve(process.env.CK_RUNTIME_ROOT ?? 'packages/web/public/esp32/v2/runtime-c6');
const descriptorUrl = pathToFileURL(resolve(runtimeRoot, 'runtime.json'));
const descriptor = JSON.parse(await readFile(fileURLToPath(descriptorUrl), 'utf8'));

async function fileFetch(input, init = {}) {
  const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'file:') return fetch(input, init);
  if (method !== 'GET') return new Response('method not allowed', { status: 405 });
  try {
    const bytes = await readFile(fileURLToPath(url));
    const contentType = url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

const { createBrowserToolchainPackLoader } = await import('../packages/web/public/avr/v3/toolchain-pack.js');
const createPackLoader = (options) => createBrowserToolchainPackLoader({ ...options, fetchFn: fileFetch });
const { createEsp32BrowserBuildIR } = await import('../packages/web/public/ck-build-ir-envelope.js');
const {
  loadEsp32BrowserBuildPlanning,
  createEsp32BrowserActionExecutor,
} = await import('../packages/web/public/esp32/v2/c3-compiler.js');
const { createEsp32BrowserPackProvider } = await import('../packages/web/public/esp32/v2/ck-pack-provider.js');
const { loadEsp32C3Toolchain } = await import('../packages/web/public/esp32/v2/c3-clang-runtime.js');
const { preprocess } = await import('../packages/web/public/avr/v3/preprocess.js');
const { buildEsp32C6Image } = await import('../packages/web/public/esp32/v2/image-builder.js');
const { BrowserWasmExecutor } = await import('../packages/web/public/ck-browser-executor.js');
const { executeActionGraphWithEvidence } = await import('./ck-action-graph-evidence.mjs');

async function loadBrowserToolchain(loader) {
  const processRef = globalThis.process;
  try {
    globalThis.process = undefined;
    return await loadEsp32C3Toolchain({ loader });
  } finally {
    globalThis.process = processRef;
  }
}

const started = Date.now();
const planning = await loadEsp32BrowserBuildPlanning({
  descriptor,
  descriptorUrl: descriptorUrl.href,
  libraries: [],
  createPackLoader,
});
const capability = {
  profile: { board: descriptor.board, architecture: 'riscv32', runtime: 'esp32-riscv', imageBuilder: true },
  pinnedRuntime: { descriptor, descriptorUrl: descriptorUrl.href },
  pinnedLibraries: [],
};
const request = {
  board: descriptor.board,
  options: {},
  libraries: [],
  files: [
    {
      name: 'main.ino',
      content: '#include "include/acceptance.h"\nvoid setup() { acceptanceValue(); }\nvoid loop() {}\n',
    },
    {
      name: 'include/acceptance.h',
      content: '#pragma once\n#ifdef __cplusplus\nextern "C" {\n#endif\nint acceptanceC(void);\nextern const char acceptanceAsm[];\n#ifdef __cplusplus\n}\n#endif\nint acceptanceValue();\n',
    },
    {
      name: 'src/acceptance.cpp',
      content: '#include "../include/acceptance.h"\nint acceptanceValue() { return acceptanceC() + acceptanceAsm[0]; }\n',
    },
    { name: 'src/acceptance.c', content: 'int acceptanceC(void) { return 7; }\n' },
    {
      name: 'src/acceptance.S',
      content: '.section .rodata.acceptance,"a",@progbits\n.global acceptanceAsm\n.type acceptanceAsm,@object\nacceptanceAsm:\n.asciz "ASM"\n.size acceptanceAsm, .-acceptanceAsm\n',
    },
  ],
};
const ir = await createEsp32BrowserBuildIR(request, capability, planning);
const incrementalRequest = {
  ...request,
  files: request.files.map((file) => file.name === 'main.ino'
    ? { ...file, content: file.content.replace('void loop() {}', 'void loop() { delay(11); }') }
    : { ...file }),
};
if (incrementalRequest.files.find((file) => file.name === 'main.ino')?.content
  === request.files.find((file) => file.name === 'main.ino')?.content) {
  throw new Error('incremental evidence must modify main.ino');
}
const incrementalIr = await createEsp32BrowserBuildIR(incrementalRequest, capability, planning);
const packs = createEsp32BrowserPackProvider({
  capability,
  planning,
  ir,
  dependencies: { createPackLoader },
});
const adapter = await createEsp32BrowserActionExecutor({
  init: { descriptor, descriptorUrl: descriptorUrl.href },
  dependencies: {
    createPackLoader,
    loadToolchain: loadBrowserToolchain,
    preprocess,
    buildImage: buildEsp32C6Image,
  },
});
const executor = new BrowserWasmExecutor({
  packs,
  runAction: (action, context) => adapter.execute(
    action,
    action.inputs.map((input) => ({ path: input.path, bytes: context.readFile(input.path) })),
  ),
});
try {
  const verification = await executeActionGraphWithEvidence({
    executor: 'browser-wasm',
    target: 'esp32c6',
    fqbn: descriptor.board,
    ir,
    incrementalIr,
    mainSourcePath: 'main.ino',
    sourceRevision,
    buildExecutor: executor,
    onProgress: ({ completed, total, action, cached }) => {
      console.log(`${completed}/${total} ${action.id} ${cached ? 'cached' : 'run'}`);
    },
  });
  const result = verification.firstResult;
  console.log(JSON.stringify({
    target: 'ESP32-C6',
    status: verification.evidence.status,
    reason: result.reason,
    message: result.message,
    actionCount: result.actions?.length,
    artifacts: result.artifacts?.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    diagnostics: result.diagnostics,
    cacheReplay: verification.evidence.cacheReplay,
    buildIrSha256: verification.evidence.buildIr.sha256,
    evidence: verification.evidencePath,
    elapsedMs: Date.now() - started,
  }, null, 2));
  if (verification.evidence.status !== 'pass') process.exitCode = 1;
} finally {
  adapter.close();
}
