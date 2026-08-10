/**
 * 底座参考客户端。
 *
 * 它的作用不是"做一个好用的 IDE"，而是**证明 API 契约立得住**：
 * 一个不认识积木、不认识图形化的普通前端，只靠 POST /v1/compile +
 * SSE 诊断 + Web Serial，就能完成「编辑 → 编译 → 烧录」全链路。
 *
 * 图形化平台将来接的是同一套 API，区别只在于：
 * 它的源码来自积木生成器，并且自己维护一张 blockId ←→ 行号 的 source map，
 * 拿到这里同样的 `line` 之后映射回积木去高亮。底座对此一无所知。
 */

import { Stk500Flasher, webSerialSupported } from './stk500.js';
import { flashEsp32, forgetFlashedDevices } from './esp32flash.js';
import { artifactBytes, artifactText } from './artifacts.js';
import { browserBoardRoute, compileInBrowser } from './browser-compiler.js';
import { registerBrowserAvrCache } from './browser-avr-cache.js';
import {
  compactStoredCompileContext,
  compileRecoveryBoardDisposition,
} from './compile-recovery.js';
import {
  ACTIVE_COMPILE_RECORD_KEY,
  LEGACY_ACTIVE_COMPILE_DB_NAME,
  activeCompileRecordKey,
  activeCompileTabId,
  createActiveCompilePersistence,
  createIndexedDbActiveCompileStore,
} from './active-compile-storage.js';
import {
  commitCompileAcceptance,
  validCancellationHandle,
  validateCompileAcceptance,
} from './compile-submission.js';
import {
  ProjectFileError,
  addProjectFile,
  createProjectSnapshot,
  mergeProjectSnapshots,
  normalizeProjectPath,
  projectSnapshotForRequest,
  readProjectSnapshot,
  renameProjectFile,
} from './project-files.js';
import {
  loadProjectState,
  saveProjectState,
} from './project-state.js';
import {
  LEGACY_PROJECT_ARCHIVE_EXTENSION,
  MAX_PROJECT_ARCHIVE_BYTES,
  PROJECT_ARCHIVE_EXTENSION,
  decodeProjectArchive,
  encodeProjectArchive,
  projectArchiveFilename,
  safeDownloadFilename,
} from './project-transfer.js';
import { ESP32_BROWSER_RELEASE } from './esp32/v1/release.js';
import {
  installEsp32BrowserLibraryPack,
  listInstalledEsp32BrowserLibraryPacks,
  loadEsp32BrowserLibraryRegistry,
} from './esp32/v1/library-registry.js';
import {
  reconcileEsp32BrowserLibraryCatalog,
  reconcileEsp32BrowserLibraryReferences,
  resolveEsp32BrowserCatalogLibrary,
} from './browser-library-catalog.js';
import {
  installGitHubLibrary,
  mergeInstalledLibraries,
} from './library-import.js';
import {
  boardOptionUnavailable,
  browserCompileUnavailableMessage,
  compileFallbackRoute,
  createBrowserCompileProgressReporter,
  diagnosticsForFile,
  firmwareArtifacts,
  shouldRetryBrowserAssetBuild,
  unsupportedBoardOptionReason,
  validateRestoredBoardConfiguration,
  withTimeout,
} from './editor-workflow.js';
import {
  filterLibrariesForArchitecture,
} from './library-architecture.js';
import { highlightArduino } from './syntax-highlight.js';
import { createBrowserLibraryCacheCoordinator } from './browser-library-cache.js';
import {
  mergeLibrarySelectionRows,
  normalizeLibraryReferences,
} from './library-selection.js';
import { createLatestOperationCoordinator } from './latest-operation.js';
import { apiUrl } from './deployment-url.js';

// This is intentionally detached: caching is an optional accelerator and must
// never delay page startup or interfere with server compile fallback.
void registerBrowserAvrCache();

const $ = (id) => document.getElementById(id);
const codeEl = $('code');
const codeHighlightEl = $('code-highlight');
const gutterEl = $('gutter');
const diagsEl = $('diags');
const statusEl = $('status');
const progressEl = $('progress');
const progressRingEl = $('progress-ring');
const progressValueEl = $('progress-value');
const monitorEl = $('monitor');
const boardEl = $('board');
const optionsEl = $('board-options');
const projectFilesEl = $('project-files');
const projectFolderInput = $('project-folder-input');
const projectFilesInput = $('project-files-input');
const projectArchiveInput = $('project-archive-input');
const projectFileEditorForm = $('project-file-editor');
const projectFileNameEl = $('project-file-name');
const projectIdEl = $('project-id');
const artifactSectionEl = $('artifact-section');
const artifactDownloadsEl = $('artifact-downloads');
const libraryFilterEl = $('library-filter');
const libraryListEl = $('library-list');
const libraryImportFormEl = $('library-import-form');
const libraryRepositoryEl = $('library-repository');
const libraryRefEl = $('library-ref');
const libraryImportStatusEl = $('library-import-status');
const editorActiveFileEl = document.querySelector('[data-editor-active-file]');
const runtimeIndicatorEl = document.querySelector('[data-runtime-indicator]');
const VISITOR_STORAGE_KEY = 'sketchforge.visitor';
const LEGACY_VISITOR_STORAGE_KEY = 'arduinofast.visitor';
const CLOUD_PROJECT_ID_STORAGE_KEY = 'sketchforge.cloud-project-id.v1';
const LEGACY_CLOUD_PROJECT_ID_STORAGE_KEY = 'arduinofast.cloud-project-id.v1';
const legacyProjectStateStorage = (() => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
})();
const projectStateStorage = (() => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
})();
const tabCompileStorage = projectStateStorage;
const activeCompileIndexedDb = (() => {
  try {
    return globalThis.indexedDB;
  } catch {
    return null;
  }
})();
const activeCompileTab = activeCompileTabId(tabCompileStorage);
const activeCompileKey = activeCompileRecordKey(activeCompileTab);
const activeCompilePersistence = createActiveCompilePersistence({
  durable: createIndexedDbActiveCompileStore(activeCompileIndexedDb, activeCompileKey),
  legacyDurables: [
    createIndexedDbActiveCompileStore(activeCompileIndexedDb),
    createIndexedDbActiveCompileStore(
      activeCompileIndexedDb,
      activeCompileKey,
      LEGACY_ACTIVE_COMPILE_DB_NAME,
    ),
    createIndexedDbActiveCompileStore(
      activeCompileIndexedDb,
      ACTIVE_COMPILE_RECORD_KEY,
      LEGACY_ACTIVE_COMPILE_DB_NAME,
    ),
  ],
  fallbackStorage: tabCompileStorage,
  legacyStorages: [legacyProjectStateStorage, tabCompileStorage],
});

let boards = [];
let lastHex = null;
let lastResult = null;
let lastDiags = [];
let monitorAbort = null;
let monitorOpening = false;
let activeCompile = null;
let flashing = false;
let projectSnapshot = null;
let activeProjectFile = 'main.ino';
let libraryCatalog = [];
let browserLibraryRegistry = null;
const browserLibraryCacheOperations = new Map();
const browserLibraryCache = createBrowserLibraryCacheCoordinator({
  install: (options) => installEsp32BrowserLibraryPack(options),
});
let libraryCatalogLoadSequence = 0;
let selectedLibraries = new Map();
let browserLibraryRegistryError = null;
let libraryImporting = false;
let firmwareDownloading = false;
let editingProjectFile = null;
let uiEventsBound = false;
let projectStateReady = false;
let boardStateReady = false;
let restoredBoard = '';
let restoredOptions = Object.freeze({});
const projectRestoreOperations = createLatestOperationCoordinator();

const JOB_STATUS_POLL_MS = 2_500;
const OPTIONAL_CATALOG_TIMEOUT_MS = 8_000;

const compileStageLabels = {
  accepted: '任务已受理，等待编译 worker',
  stream: '已连接进度通道，等待编译 worker',
  reconnecting: '进度通道正在重连，服务器任务仍在运行',
  queued: '正在排队等待编译 worker',
  preprocess: '正在预处理源码',
  core: '正在准备开发板核心',
  libraries: '正在准备依赖库',
  static: '正在生成启动与分区固件',
  pch: '正在准备编译缓存',
  compiling: '正在编译用户代码',
  linking: '正在链接固件',
  imaging: '正在生成可烧录固件',
  size: '正在统计固件体积',
  done: '正在收集编译结果',
};

function showOutputView(view) {
  globalThis.dispatchEvent?.(new CustomEvent('sketchforge:show-output', {
    detail: { view },
  }));
}

function syncEditorChrome() {
  if (editorActiveFileEl) editorActiveFileEl.textContent = activeProjectFile || 'main.ino';
}

function setRuntimeIndicator(text, state = 'ready') {
  if (!runtimeIndicatorEl) return;
  runtimeIndicatorEl.textContent = text;
  runtimeIndicatorEl.dataset.state = state;
}

function migratedStorageValue(storage, currentKey, legacyKey) {
  let current;
  try { current = storage?.getItem?.(currentKey); } catch { return null; }
  if (typeof current === 'string' && current) return current;

  let legacy;
  try { legacy = storage?.getItem?.(legacyKey); } catch { return null; }
  if (typeof legacy !== 'string' || !legacy) return null;
  if (typeof storage?.setItem === 'function') {
    try {
      storage.setItem(currentKey, legacy);
      storage?.removeItem?.(legacyKey);
    } catch { /* reading the old value is still useful when migration is blocked */ }
  }
  return legacy;
}

function storeCurrentStorageValue(storage, currentKey, legacyKey, value) {
  if (typeof storage?.setItem !== 'function') return false;
  try {
    storage.setItem(currentKey, value);
    storage?.removeItem?.(legacyKey);
    return true;
  } catch {
    return false;
  }
}

function anonymousVisitorId() {
  try {
    const storage = globalThis.localStorage;
    const current = migratedStorageValue(storage, VISITOR_STORAGE_KEY, LEGACY_VISITOR_STORAGE_KEY);
    if (current) return current;
    const created = crypto.randomUUID();
    storeCurrentStorageValue(storage, VISITOR_STORAGE_KEY, LEGACY_VISITOR_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

const visitorId = anonymousVisitorId();

const DEFAULT_SKETCH = `// 改一个字试试，编译错误会精确标在对应行上。
// reportUptime 定义在 loop 之后却能直接调用 —— 底座自动生成了函数原型。

int interval = 1000;

void setup() {
  Serial.begin(9600);
  Serial.println("sketchforge ready");
}

void loop() {
  reportUptime(interval);
}

void reportUptime(int ms) {
  Serial.print("uptime ms: ");
  Serial.println(millis());
  delay(ms);
}
`;

// ---------------------------------------------------------------------------
// 编辑器：行号槽 + 错误标记
// ---------------------------------------------------------------------------

function currentProjectSnapshot() {
  const files = projectSnapshot?.files?.map((file) => ({
    name: file.name,
    content: file.name === activeProjectFile ? codeEl.value : file.content,
  })) ?? [{ name: 'main.ino', content: codeEl.value }];
  return createProjectSnapshot(files);
}

function persistLocalProjectState() {
  if (!projectStateReady || !projectSnapshot) return false;
  const board = boardStateReady ? boardEl.value : restoredBoard;
  const options = boardStateReady ? currentOptions() : restoredOptions;
  const saved = saveProjectState(projectStateStorage, {
    files: projectSnapshotForRequest(projectSnapshot),
    activeFile: activeProjectFile,
    board,
    options,
    libraries: selectedLibraryRefs(),
  });
  if (saved) {
    restoredBoard = board;
    restoredOptions = Object.freeze({ ...options });
  }
  return saved;
}

function renderProjectFiles() {
  if (!projectFilesEl || !projectSnapshot) return;
  syncEditorChrome();
  projectFilesEl.innerHTML = projectSnapshot.files.map((file) => {
    const active = file.name === activeProjectFile ? ' active' : '';
    const rename = `<button class="rename" type="button" data-rename="${escapeHtml(file.name)}" title="Rename file">Rename</button>`;
    const removable = file.name === projectSnapshot.sketch ? '' : `<button class="remove" type="button" data-remove="${escapeHtml(file.name)}" title="Remove file">x</button>`;
    return `<div class="project-file"><button type="button" class="${active}" data-file="${escapeHtml(file.name)}">${escapeHtml(file.name)}</button>${rename}${removable}</div>`;
  }).join('');
  projectFilesEl.querySelectorAll('[data-file]').forEach((button) => {
    button.addEventListener('click', () => selectProjectFile(button.dataset.file));
  });
  projectFilesEl.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => removeProjectFile(button.dataset.remove));
  });
  projectFilesEl.querySelectorAll('[data-rename]').forEach((button) => {
    button.addEventListener('click', () => openProjectFileEditor(button.dataset.rename));
  });
}

function installProjectSnapshot(snapshot, active = snapshot.sketch) {
  closeProjectFileEditor();
  projectSnapshot = snapshot;
  activeProjectFile = snapshot.files.some((file) => file.name === active) ? active : snapshot.sketch;
  syncEditorChrome();
  codeEl.value = snapshot.files.find((file) => file.name === activeProjectFile)?.content ?? '';
  renderGutter();
  renderProjectFiles();
  persistLocalProjectState();
  invalidateCompileOutput();
}

function syncActiveProjectFile() {
  if (!projectSnapshot || !activeProjectFile) return;
  const files = projectSnapshot.files.map((file) => ({
    name: file.name,
    content: file.name === activeProjectFile ? codeEl.value : file.content,
  }));
  projectSnapshot = createProjectSnapshot(files);
  persistLocalProjectState();
}

function selectProjectFile(name) {
  if (!projectSnapshot || !projectSnapshot.files.some((file) => file.name === name)) return;
  syncActiveProjectFile();
  activeProjectFile = name;
  syncEditorChrome();
  codeEl.value = projectSnapshot.files.find((file) => file.name === name)?.content ?? '';
  persistLocalProjectState();
  renderGutter();
  renderProjectFiles();
}

function removeProjectFile(name) {
  if (!projectSnapshot || name === projectSnapshot.sketch) return;
  cancelPendingProjectRestore();
  syncActiveProjectFile();
  const remaining = projectSnapshot.files.filter((file) => file.name !== name);
  try {
    const next = createProjectSnapshot(remaining);
    installProjectSnapshot(next, next.files.some((file) => file.name === activeProjectFile) ? activeProjectFile : next.sketch);
  } catch (error) {
    setStatus(error.message, 0, 'var(--err)');
  }
}

function openProjectFileEditor(source = null) {
  if (!projectSnapshot || !projectFileEditorForm || !projectFileNameEl) return;
  if (source !== null && !projectSnapshot.files.some((file) => file.name === source)) return;
  syncActiveProjectFile();
  editingProjectFile = source;
  projectFileNameEl.value = source ?? '';
  projectFileNameEl.placeholder = source ? 'New file path' : 'src/helper.cpp';
  projectFileNameEl.setAttribute('aria-label', source ? `Rename ${source}` : 'New project file path');
  projectFileEditorForm.hidden = false;
  requestAnimationFrame(() => {
    projectFileNameEl.focus();
    projectFileNameEl.select();
  });
}

function closeProjectFileEditor() {
  editingProjectFile = null;
  projectFileEditorForm?.reset();
  if (projectFileEditorForm) projectFileEditorForm.hidden = true;
}

function submitProjectFileEdit(event) {
  event.preventDefault();
  if (!projectSnapshot || !projectFileNameEl) return;
  cancelPendingProjectRestore();
  const source = editingProjectFile;
  try {
    syncActiveProjectFile();
    const target = normalizeProjectPath(projectFileNameEl.value);
    if (source === null) {
      const next = addProjectFile(projectSnapshot, target);
      installProjectSnapshot(next, target);
      setStatus(`Project file created: ${target}`, 0, 'var(--ok)');
    } else {
      const next = renameProjectFile(projectSnapshot, source, target);
      installProjectSnapshot(next, activeProjectFile === source ? target : activeProjectFile);
      setStatus(`Project file renamed: ${source} → ${target}`, 0, 'var(--ok)');
    }
  } catch (error) {
    const message = error instanceof ProjectFileError ? error.message : String(error?.message ?? error);
    setStatus(`Project file update failed: ${message}`, 0, 'var(--err)');
  }
}

async function importProjectFiles(fileList, mode) {
  const operation = projectRestoreOperations.begin();
  try {
    const imported = await readProjectSnapshot(fileList, { requireSketch: mode === 'replace' });
    if (!projectRestoreOperations.isCurrent(operation)) return;
    if (mode === 'replace') {
      installProjectSnapshot(imported, imported.sketch);
    } else {
      syncActiveProjectFile();
      const merged = mergeProjectSnapshots(projectSnapshot, imported);
      installProjectSnapshot(merged, merged.files.some((file) => file.name === activeProjectFile) ? activeProjectFile : merged.sketch);
    }
    projectRestoreOperations.finish(operation);
    setStatus(`${projectSnapshot.files.length} project files ready`, 0, 'var(--ok)');
  } catch (error) {
    if (!projectRestoreOperations.isCurrent(operation)) return;
    projectRestoreOperations.finish(operation);
    const message = error instanceof ProjectFileError ? error.message : String(error?.message ?? error);
    setStatus(`Project import failed: ${message}`, 0, 'var(--err)');
  } finally {
    if (fileList === projectFolderInput?.files) projectFolderInput.value = '';
    if (fileList === projectFilesInput?.files) projectFilesInput.value = '';
  }
}

function downloadBytes(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeDownloadFilename(name, 'download.bin');
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportProjectArchive() {
  if (activeCompile || flashing) return;
  try {
    syncActiveProjectFile();
    const snapshot = currentProjectSnapshot();
    const board = boardStateReady ? boardEl.value : restoredBoard;
    const options = boardStateReady ? currentOptions() : restoredOptions;
    const encoded = encodeProjectArchive({
      files: projectSnapshotForRequest(snapshot),
      activeFile: activeProjectFile,
      board,
      options,
      libraries: selectedLibraryRefs(),
    });
    downloadBytes(
      new TextEncoder().encode(encoded),
      projectArchiveFilename(projectIdEl?.value),
      'application/json;charset=utf-8',
    );
    setStatus('项目已导出', 0, 'var(--ok)');
  } catch (error) {
    setStatus(`项目导出失败：${String(error?.message ?? error)}`, 0, 'var(--err)');
  }
}

async function importProjectArchive(file) {
  if (activeCompile || flashing || !file) return;
  if (projectArchiveInput) projectArchiveInput.value = '';
  const operation = projectRestoreOperations.begin();
  try {
    if (file.size > MAX_PROJECT_ARCHIVE_BYTES) throw new Error('project archive is too large');
    const restored = decodeProjectArchive(await file.text());
    if (!projectRestoreOperations.isCurrent(operation)) return;
    const snapshot = createProjectSnapshot(restored.files);
    const configuration = requireRestoredBoardConfiguration(restored.board, restored.options);
    const persistenceWasReady = projectStateReady;
    projectStateReady = false;
    try {
      installProjectSnapshot(snapshot, restored.activeFile);
      boardEl.value = configuration.board.fqbn;
      renderBoardOptions(configuration.options);
      libraryCatalog = [];
      installLibrarySelections(restored.libraries);
    } finally {
      projectStateReady = persistenceWasReady;
    }
    boardStateReady = true;
    persistLocalProjectState();
    renderLibraryList();
    void loadLibraryCatalog().catch((error) => {
      setLibraryImportStatus(`库目录加载失败：${String(error?.message ?? error)}`, 'error');
    });
    invalidateCompileOutput();
    projectRestoreOperations.finish(operation);
    setStatus('项目已导入', 0, 'var(--ok)');
  } catch (error) {
    if (!projectRestoreOperations.isCurrent(operation)) return;
    projectRestoreOperations.finish(operation);
    setStatus(`项目导入失败：${String(error?.message ?? error)}`, 0, 'var(--err)');
  }
}

function libraryKey(name, version) {
  return `${String(name).toLowerCase()}@${String(version)}`;
}

function restoredBoardConfigurationError(configuration) {
  if (configuration.reason === 'board') {
    return `保存的板卡当前不可用：${configuration.fqbn}`;
  }
  const details = configuration.invalidOptions
    ?.map(({ id, value }) => `${id}=${String(value)}`)
    .join(', ');
  return `保存的板卡选项已失效${details ? `：${details}` : ''}`;
}

function requireRestoredBoardConfiguration(fqbn, options) {
  const configuration = validateRestoredBoardConfiguration(boards, fqbn, options);
  if (!configuration.valid) throw new Error(restoredBoardConfigurationError(configuration));
  return configuration;
}

function cancelPendingProjectRestore() {
  if (!projectRestoreOperations.cancelCurrent()) return false;
  setStatus('项目恢复已取消', 0, 'var(--warn)');
  return true;
}

function installLibrarySelections(refs) {
  selectedLibraries = new Map(normalizeLibraryReferences(refs).map((selection) => [
    libraryKey(selection.name, selection.version ?? ''),
    selection,
  ]));
}

function selectedLibraryRefs() {
  return [...selectedLibraries.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || String(left.version ?? '').localeCompare(String(right.version ?? ''))
  ));
}

function currentLibraryRefs() {
  return selectedLibraryRefs();
}

function renderLibraryList() {
  if (!libraryListEl) return;
  const query = (libraryFilterEl?.value ?? '').trim().toLowerCase();
  const catalogRows = filterLibrariesForArchitecture(libraryCatalog, currentBoard()?.arch);
  const rows = mergeLibrarySelectionRows(selectedLibraryRefs(), catalogRows).filter((library) => (
    !query || `${library.name} ${library.description ?? ''}`.toLowerCase().includes(query)
  ));
  if (!rows.length) {
    const notice = browserLibraryRegistryError
      ? '<div class="library-notice" role="status">浏览器库目录暂时加载失败，已保留可用目录；稍后可重试。</div>'
      : '';
    libraryListEl.innerHTML = `${notice}<div class="empty">没有匹配的库</div>`;
    return;
  }
  const notice = browserLibraryRegistryError
    ? '<div class="library-notice" role="status">浏览器库目录暂时加载失败，已保留可用目录；稍后可重试。</div>'
    : '';
  libraryListEl.innerHTML = notice + rows.map((library) => {
    const key = library.catalogKey || library.selectionKey;
    const checked = library.selected ? ' checked' : '';
    const browserResolution = currentBoard()?.arch === 'esp32'
      ? resolveEsp32BrowserCatalogLibrary(browserLibraryRegistry, library, 'esp32')
      : null;
    const browserReady = Boolean(browserResolution);
    const cached = browserReady && browserLibraryCache.hasAll(browserResolution.libraries);
    const caching = browserReady && (
      browserLibraryCacheOperations.has(key)
      || browserResolution.libraries.some((selection) => browserLibraryCache.isPending(selection))
    );
    const installed = library.installed === true;
    const markers = [
      browserReady ? 'WASM' : '',
      currentBoard()?.arch === 'esp32' && !browserReady ? '无浏览器 Pack' : '',
      installed ? '已导入' : '',
      library.retained ? '目录中不可用' : '',
    ].filter(Boolean).join(' · ');
    const action = library.retained ? '' : browserReady && cached
      ? '<button type="button" disabled aria-label="浏览器库已缓存" title="浏览器 Pack 已缓存">已缓存</button>'
      : browserReady
        ? `<button type="button" data-cache-library="${escapeHtml(key)}" title="缓存浏览器 WASM 库"${caching ? ' disabled aria-busy="true"' : ''}>${caching ? '缓存中' : '缓存'}</button>`
      : !installed && library.source?.repository
        ? `<button type="button" data-install-library="${escapeHtml(key)}" title="安装到服务器">安装</button>`
        : '';
    return `<div class="library-row">
      <input type="checkbox" class="library-choice" data-library="${escapeHtml(library.selectionKey)}" data-catalog-library="${escapeHtml(library.catalogKey)}"${checked}>
      <label title="${escapeHtml(library.description ?? library.name)}">${escapeHtml(library.name)} <small>${escapeHtml(library.version || '未锁定版本')}${markers ? ` · ${markers}` : ''}</small></label>
      ${action}
    </div>`;
  }).join('');
  libraryListEl.querySelectorAll('.library-choice').forEach((input) => {
    input.addEventListener('change', () => {
      cancelPendingProjectRestore();
      const selectionKey = input.dataset.library;
      if (!input.checked) selectedLibraries.delete(selectionKey);
      else {
        const item = libraryCatalog.find((candidate) => (
          libraryKey(candidate.name, candidate.version) === input.dataset.catalogLibrary
        ));
        if (!item) {
          input.checked = false;
          return;
        }
        selectedLibraries.delete(selectionKey);
        selectedLibraries.set(
          libraryKey(item.name, item.version),
          { name: item.name, version: item.version },
        );
      }
      persistLocalProjectState();
      invalidateCompileOutput();
      renderLibraryList();
    });
  });
  libraryListEl.querySelectorAll('[data-cache-library]').forEach((button) => {
    button.addEventListener('click', () => { void cacheBrowserLibrary(button.dataset.cacheLibrary); });
  });
  libraryListEl.querySelectorAll('[data-install-library]').forEach((button) => {
    button.addEventListener('click', () => { void installServerLibrary(button.dataset.installLibrary); });
  });
}

async function cacheBrowserLibrary(key) {
  const item = libraryCatalog.find((candidate) => libraryKey(candidate.name, candidate.version) === key);
  if (!item || !browserLibraryRegistry) return;
  const existing = browserLibraryCacheOperations.get(key);
  if (existing) return existing;
  const operation = (async () => {
    try {
      const resolved = resolveEsp32BrowserCatalogLibrary(browserLibraryRegistry, item, 'esp32');
      if (!resolved) throw new Error('该库当前没有可用的浏览器 Pack');
      if (browserLibraryCache.hasAll(resolved.libraries)) return true;
      for (const selection of resolved.libraries) {
        await browserLibraryCache.ensure(selection, {
          registry: browserLibraryRegistry,
          architecture: 'esp32',
          selection,
          onProgress: ({ loaded, total }) => setStatus(`缓存 ${selection.name}… ${total ? Math.round((loaded / total) * 100) : 0}%`, 0),
        });
      }
      setStatus(`浏览器库已缓存：${item.name}`, 0, 'var(--ok)');
      return true;
    } catch (error) {
      setStatus(`浏览器库缓存失败：${error.message}`, 0, 'var(--err)');
      return false;
    }
  })();
  browserLibraryCacheOperations.set(key, operation);
  renderLibraryList();
  try {
    return await operation;
  } finally {
    if (browserLibraryCacheOperations.get(key) === operation) browserLibraryCacheOperations.delete(key);
    renderLibraryList();
  }
}

async function installServerLibrary(key) {
  const item = libraryCatalog.find((candidate) => libraryKey(candidate.name, candidate.version) === key);
  const repository = item?.source?.repository;
  if (!item || typeof repository !== 'string') return;
  const operation = projectRestoreOperations.begin();
  setStatus(`正在导入库：${item.name}…`, 0);
  try {
    const result = await installGitHubLibrary({
      repository,
      ref: item.version,
      visitorId,
    });
    if (!projectRestoreOperations.isCurrent(operation)) return;
    const selection = await refreshAndSelectImportedLibrary(result.library, false, operation);
    if (!selection) return;
    projectRestoreOperations.finish(operation);
    setStatus(`库已安装：${result.library.name}`, 0, 'var(--ok)');
  } catch (error) {
    if (!projectRestoreOperations.isCurrent(operation)) return;
    projectRestoreOperations.finish(operation);
    setStatus(`库安装失败：${error.message}`, 0, 'var(--err)');
  }
}

function setLibraryImportStatus(message, state = 'idle') {
  if (!libraryImportStatusEl) return;
  libraryImportStatusEl.textContent = message;
  libraryImportStatusEl.title = message;
  libraryImportStatusEl.dataset.state = state;
}

function setLibraryImportBusy(busy) {
  libraryImporting = busy;
  libraryImportFormEl?.setAttribute('aria-busy', String(busy));
  libraryImportFormEl?.querySelectorAll('input, button').forEach((control) => {
    control.disabled = busy;
  });
}

async function refreshAndSelectImportedLibrary(library, reveal = false, operation = null) {
  const selection = { name: library.name.trim(), version: library.version.trim() };
  const key = libraryKey(selection.name, selection.version);
  const catalogLoaded = await loadLibraryCatalog({
    stillCurrent: () => !operation || projectRestoreOperations.isCurrent(operation),
  });
  if (!catalogLoaded || (operation && !projectRestoreOperations.isCurrent(operation))) return null;

  // Keep the accepted result visible even when the follow-up catalog request
  // is temporarily unavailable.
  libraryCatalog = mergeInstalledLibraries(libraryCatalog, [library]);
  selectedLibraries.set(key, selection);
  persistLocalProjectState();
  if (reveal && libraryFilterEl) libraryFilterEl.value = selection.name;
  renderLibraryList();
  invalidateCompileOutput();
  return selection;
}

async function importUnknownGitHubLibrary(event) {
  event.preventDefault();
  if (libraryImporting) return;
  const operation = projectRestoreOperations.begin();
  setLibraryImportBusy(true);
  setLibraryImportStatus('正在导入并检查库…', 'busy');
  try {
    const result = await installGitHubLibrary({
      repository: libraryRepositoryEl?.value ?? '',
      ref: libraryRefEl?.value ?? '',
      visitorId,
    });
    if (!projectRestoreOperations.isCurrent(operation)) return;
    const selection = await refreshAndSelectImportedLibrary(result.library, true, operation);
    if (!selection) return;
    projectRestoreOperations.finish(operation);
    libraryImportFormEl?.reset();
    setLibraryImportStatus(`已导入并选中 ${selection.name} ${selection.version}`, 'success');
  } catch (error) {
    if (!projectRestoreOperations.isCurrent(operation)) return;
    projectRestoreOperations.finish(operation);
    setLibraryImportStatus(`导入失败：${String(error?.message ?? error)}`, 'error');
  } finally {
    if (libraryImportStatusEl?.dataset.state === 'busy') {
      setLibraryImportStatus('导入结果未应用到当前项目', 'idle');
    }
    setLibraryImportBusy(false);
  }
}

async function loadLibraryCatalog({ stillCurrent = () => true } = {}) {
  const sequence = ++libraryCatalogLoadSequence;
  const architecture = currentBoard()?.arch;
  const query = architecture ? `?arch=${encodeURIComponent(architecture)}` : '';
  const browserRegistryPromise = architecture === 'esp32'
    ? withTimeout(
      loadEsp32BrowserLibraryRegistry({ release: ESP32_BROWSER_RELEASE }),
      OPTIONAL_CATALOG_TIMEOUT_MS,
      'browser library registry',
    )
    : Promise.resolve(null);
  const browserCachePromise = architecture === 'esp32'
    ? withTimeout(
      listInstalledEsp32BrowserLibraryPacks(),
      OPTIONAL_CATALOG_TIMEOUT_MS,
      'browser library cache',
    )
    : Promise.resolve([]);
  const [catalogLoad, installedLoad, browserRegistryLoad, browserCacheLoad] = await Promise.allSettled([
    withTimeout(fetch(apiUrl(`libraries/catalog${query}`), { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.libraries)) throw new Error('invalid library catalog');
      return payload.libraries;
    }), OPTIONAL_CATALOG_TIMEOUT_MS, 'library catalog'),
    withTimeout(fetch(apiUrl('libraries/installed'), { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.libraries)) throw new Error('invalid installed libraries');
      return payload.libraries;
    }), OPTIONAL_CATALOG_TIMEOUT_MS, 'installed libraries'),
    browserRegistryPromise,
    browserCachePromise,
  ]);
  if (sequence !== libraryCatalogLoadSequence || !stillCurrent()) return false;
  libraryCatalog = catalogLoad.status === 'fulfilled' ? catalogLoad.value : [];
  const installedLibraries = installedLoad.status === 'fulfilled' ? installedLoad.value : [];
  if (architecture === 'esp32') {
    if (browserRegistryLoad.status === 'fulfilled' && browserRegistryLoad.value) {
      browserLibraryRegistry = browserRegistryLoad.value;
      browserLibraryRegistryError = null;
    } else {
      browserLibraryRegistryError = browserRegistryLoad.reason ?? new Error('browser library registry unavailable');
    }
    if (browserCacheLoad.status === 'fulfilled') browserLibraryCache.remember(browserCacheLoad.value);
  } else {
    browserLibraryRegistry = null;
    browserLibraryRegistryError = null;
  }
  libraryCatalog = mergeInstalledLibraries(libraryCatalog, installedLibraries);
  if (architecture === 'esp32' && browserLibraryRegistry) {
    libraryCatalog = reconcileEsp32BrowserLibraryCatalog(libraryCatalog, browserLibraryRegistry, architecture);
    const previousReferences = selectedLibraryRefs();
    const migratedReferences = reconcileEsp32BrowserLibraryReferences(
      previousReferences,
      browserLibraryRegistry,
      architecture,
    );
    const changed = migratedReferences.length !== previousReferences.length
      || migratedReferences.some((reference, index) => (
        reference.name !== previousReferences[index]?.name
        || reference.version !== previousReferences[index]?.version
      ));
    if (changed) {
      installLibrarySelections(migratedReferences);
      persistLocalProjectState();
      invalidateCompileOutput();
    }
  }
  renderLibraryList();
  return true;
}

function cloudProjectId() {
  const value = String(projectIdEl?.value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('云项目名称只能包含字母、数字、下划线和连字符');
  }
  try {
    storeCurrentStorageValue(
      globalThis.localStorage,
      CLOUD_PROJECT_ID_STORAGE_KEY,
      LEGACY_CLOUD_PROJECT_ID_STORAGE_KEY,
      value,
    );
  } catch { /* optional */ }
  return value;
}

async function saveCloudProject() {
  if (activeCompile || flashing) return;
  cancelPendingProjectRestore();
  if (!boardStateReady) {
    setStatus('请先选择有效的板卡配置再保存云项目', 0, 'var(--warn)');
    return;
  }
  try {
    const id = cloudProjectId();
    const context = snapshotCompileContext();
    setStatus(`正在保存云项目 ${id}…`, 0);
    const response = await fetch(apiUrl(`projects/${encodeURIComponent(id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-AF-Visitor': visitorId },
      body: JSON.stringify({
        name: id,
        board: context.board,
        files: context.files,
        libraries: selectedLibraryRefs(),
        options: context.options,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    setStatus(`云项目已保存：${id}`, 0, 'var(--ok)');
  } catch (error) {
    setStatus(`云保存失败：${error.message}`, 0, 'var(--err)');
  }
}

async function loadCloudProject() {
  if (activeCompile || flashing) return;
  let operation;
  try {
    const id = cloudProjectId();
    operation = projectRestoreOperations.begin();
    setStatus(`正在恢复云项目 ${id}…`, 0);
    const response = await fetch(apiUrl(`projects/${encodeURIComponent(id)}`), {
      headers: { 'X-AF-Visitor': visitorId },
      cache: 'no-store',
    });
    const project = await response.json().catch(() => ({}));
    if (!projectRestoreOperations.isCurrent(operation)) return;
    if (String(projectIdEl?.value ?? '').trim() !== id) {
      projectRestoreOperations.cancel(operation);
      return;
    }
    if (!response.ok) throw new Error(project.message || `HTTP ${response.status}`);
    const snapshot = createProjectSnapshot(project.files);
    const configuration = requireRestoredBoardConfiguration(project.board, project.options);
    const persistenceWasReady = projectStateReady;
    projectStateReady = false;
    try {
      installProjectSnapshot(snapshot, snapshot.sketch);
      boardEl.value = configuration.board.fqbn;
      renderBoardOptions(configuration.options);
      libraryCatalog = [];
      installLibrarySelections(project.libraries);
      renderLibraryList();
    } finally {
      projectStateReady = persistenceWasReady;
    }
    boardStateReady = true;
    persistLocalProjectState();
    void loadLibraryCatalog().catch((error) => {
      setLibraryImportStatus(`库目录加载失败：${String(error?.message ?? error)}`, 'error');
    });
    invalidateCompileOutput();
    projectRestoreOperations.finish(operation);
    setStatus(`云项目已恢复：${id}`, 0, 'var(--ok)');
  } catch (error) {
    if (operation && !projectRestoreOperations.isCurrent(operation)) return;
    if (operation) projectRestoreOperations.finish(operation);
    setStatus(`云恢复失败：${error.message}`, 0, 'var(--err)');
  }
}

function renderGutter() {
  if (codeHighlightEl) {
    const highlightCode = codeHighlightEl.querySelector('code');
    if (highlightCode) highlightCode.innerHTML = highlightArduino(codeEl.value);
    codeHighlightEl.scrollTop = codeEl.scrollTop;
    codeHighlightEl.scrollLeft = codeEl.scrollLeft;
  }
  const lines = codeEl.value.split('\n').length;
  const bySeverity = new Map();
  for (const d of diagnosticsForFile(lastDiags, activeProjectFile)) {
    const cur = bySeverity.get(d.line);
    // 同一行有多条时，error 优先于 warning
    if (!cur || (cur !== 'error' && d.severity === 'error')) bySeverity.set(d.line, d.severity);
  }

  let html = '';
  for (let i = 1; i <= lines; i++) {
    const sev = bySeverity.get(i);
    const cls = sev === 'error' ? ' class="has-error"' : sev === 'warning' ? ' class="has-warn"' : '';
    html += `<div${cls}>${i}</div>`;
  }
  gutterEl.innerHTML = html;
  gutterEl.scrollTop = codeEl.scrollTop;
}

codeEl.addEventListener('input', () => {
  cancelPendingProjectRestore();
  try {
    syncActiveProjectFile();
    renderProjectFiles();
    renderGutter();
  } catch (error) {
    setStatus(error.message, 0, 'var(--err)');
  }
  invalidateCompileOutput();
});
codeEl.addEventListener('compositionupdate', renderGutter);
codeEl.addEventListener('scroll', () => {
  gutterEl.scrollTop = codeEl.scrollTop;
  if (codeHighlightEl) {
    codeHighlightEl.scrollTop = codeEl.scrollTop;
    codeHighlightEl.scrollLeft = codeEl.scrollLeft;
  }
});

/** 把光标移到指定行并滚动过去 —— 图形化平台在这一步会改成"高亮对应积木" */
function jumpToLine(line, column = 1) {
  const lines = codeEl.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
  pos += Math.max(0, column - 1);
  codeEl.focus();
  codeEl.setSelectionRange(pos, pos);
  const lineHeight = 21;
  codeEl.scrollTop = Math.max(0, (line - 6) * lineHeight);
  gutterEl.scrollTop = codeEl.scrollTop;
}

// ---------------------------------------------------------------------------
// 诊断渲染
// ---------------------------------------------------------------------------

function renderDiags() {
  if (!lastDiags.length) {
    diagsEl.innerHTML = '<div class="empty">没有诊断信息</div>';
    return;
  }
  diagsEl.innerHTML = lastDiags
    .map((d, i) => {
      const tags = [];
      if (d.fromGenerated) tags.push('自动生成的声明');
      if (d.unmapped) tags.push('位置不确定');
      return `<div class="diag ${d.severity}" data-i="${i}">
        <div>${escapeHtml(d.message)}</div>
        <span class="loc">${escapeHtml(d.file)}:${d.line}${d.column ? ':' + d.column : ''}</span>
        ${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
      </div>`;
    })
    .join('');

  diagsEl.querySelectorAll('.diag').forEach((el) => {
    el.addEventListener('click', () => {
      openDiagnostic(lastDiags[Number(el.dataset.i)]);
    });
  });
}

function openDiagnostic(diagnostic) {
  if (!diagnostic || !Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1) return;
  if (diagnostic.file && diagnostic.file !== activeProjectFile) {
    if (!projectSnapshot?.files.some((file) => file.name === diagnostic.file)) return;
    selectProjectFile(diagnostic.file);
  }
  jumpToLine(diagnostic.line, diagnostic.column);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * 18;

function setProgressIndeterminate(active) {
  if (active) {
    progressRingEl.dataset.indeterminate = 'true';
    progressRingEl.setAttribute('aria-busy', 'true');
    progressRingEl.removeAttribute('aria-valuenow');
    progressRingEl.setAttribute('aria-valuetext', '正在加载编译资产');
    statusEl.setAttribute('aria-live', 'off');
    progressValueEl.textContent = '...';
    return;
  }
  delete progressRingEl.dataset.indeterminate;
  progressRingEl.removeAttribute('aria-busy');
  progressRingEl.removeAttribute('aria-valuetext');
  statusEl.setAttribute('aria-live', 'polite');
}

function setStatus(text, pct = null, color = null) {
  statusEl.textContent = text;
  statusEl.style.color = color || '';
  if (pct !== null) {
    setProgressIndeterminate(false);
    const numericPct = Number(pct);
    const safePct = Number.isFinite(numericPct)
      ? Math.min(100, Math.max(0, numericPct))
      : 0;
    progressEl.style.strokeDashoffset = String(
      PROGRESS_RING_CIRCUMFERENCE * (1 - safePct / 100),
    );
    progressRingEl.setAttribute('aria-valuenow', String(Math.round(safePct)));
    progressValueEl.textContent = `${Math.round(safePct)}%`;
  }
}

function renderMemory(mem) {
  if (!mem) { $('mem-section').style.display = 'none'; return; }
  $('mem-section').style.display = '';
  const row = (label, used, total) => {
    const pct = (used / total) * 100;
    const cls = pct > 90 ? 'full' : pct > 70 ? 'high' : '';
    return `<div class="row">
      <span>${label}</span>
      <span class="track"><i class="${cls}" style="width:${Math.min(100, pct)}%"></i></span>
      <span>${used}/${total} (${pct.toFixed(1)}%)</span>
    </div>`;
  };
  $('mem').innerHTML = row('Flash', mem.flashUsed, mem.flashTotal) + row('RAM', mem.ramUsed, mem.ramTotal);
}

// ---------------------------------------------------------------------------
// 编译上下文与操作状态
// ---------------------------------------------------------------------------

function snapshotCompileContext() {
  syncActiveProjectFile();
  const options = Object.fromEntries(
    Object.entries(currentOptions()).sort(([a], [b]) => a.localeCompare(b)),
  );
  const board = currentBoard();
  const buildOptions = Object.fromEntries(
    Object.entries(options).filter(([id]) =>
      board?.options.find((option) => option.id === id)?.affectsBuild !== false,
    ),
  );
  const snapshot = currentProjectSnapshot();
  return Object.freeze({
    source: snapshot.files.find((file) => file.name === snapshot.sketch)?.content ?? codeEl.value,
    files: projectSnapshotForRequest(snapshot),
    activeFile: activeProjectFile,
    board: boardEl.value,
    libraries: currentLibraryRefs(),
    options: Object.freeze(options),
    buildOptions: Object.freeze(buildOptions),
  });
}

const compileContextKey = (context) => JSON.stringify({
  files: context.files ?? [{ name: 'main.ino', content: context.source }],
  board: context.board,
  libraries: context.libraries ?? [],
  // Older in-flight records have no buildOptions and retain their previous,
  // conservative behavior when restored.
  options: context.buildOptions ?? context.options,
});
const currentCompileContextKey = () => compileContextKey(snapshotCompileContext());

function resultMatchesCurrentContext(result = lastResult) {
  return Boolean(result?.__compileContextKey) &&
    result.__compileContextKey === currentCompileContextKey();
}

function updateActionState() {
  const compileButton = $('btn-compile');
  const canCancelLocally = Boolean(
    activeCompile
    && (activeCompile.phase === 'browser' || activeCompile.phase === 'submitting')
    && !activeCompile.controller.signal.aborted,
  );
  const hasCancellationPath = Boolean(
    activeCompile && (canCancelLocally || validCancellationHandle(activeCompile.cancellation)),
  );
  const canCancel = hasCancellationPath && !activeCompile.cancelling;
  compileButton.classList.toggle('cancel', hasCancellationPath || Boolean(activeCompile?.cancelling));
  compileButton.textContent = activeCompile
    ? (canCancel ? '取消' : activeCompile.cancelling ? '取消中' : '编译中')
    : '编译';
  compileButton.title = hasCancellationPath ? '取消当前编译请求' : '编译项目';
  compileButton.disabled = activeCompile
    ? !canCancel
    : Boolean(flashing || !boardStateReady || !currentBoard());
  $('btn-flash').disabled = Boolean(
    activeCompile || flashing || !webSerialSupported() || !resultMatchesCurrentContext(),
  );
  $('btn-monitor').disabled = flashing || monitorOpening;
  const projectTransferDisabled = Boolean(activeCompile || flashing || firmwareDownloading);
  if ($('btn-import-archive')) $('btn-import-archive').disabled = projectTransferDisabled;
  if ($('btn-export-project')) $('btn-export-project').disabled = projectTransferDisabled;
  if (projectArchiveInput) projectArchiveInput.disabled = projectTransferDisabled;
  artifactDownloadsEl?.querySelectorAll('button').forEach((button) => {
    button.disabled = Boolean(activeCompile || flashing || firmwareDownloading);
  });
}

function renderArtifactDownloads(result) {
  if (!artifactSectionEl || !artifactDownloadsEl) return;
  artifactDownloadsEl.replaceChildren();
  const artifacts = result?.status === 'success' ? firmwareArtifacts(result) : [];
  artifactSectionEl.hidden = artifacts.length === 0;
  if (artifacts.length === 0) return;

  for (const artifact of artifacts) {
    const row = document.createElement('div');
    row.className = 'artifact-row';
    const label = document.createElement('span');
    const location = artifact.offset === undefined ? '' : ` @ ${artifact.offset}`;
    const size = Number.isFinite(artifact.size) ? ` · ${artifact.size} B` : '';
    label.textContent = `${artifact.name}${location}${size}`;
    label.title = label.textContent;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '下载';
    button.title = `下载并校验 ${artifact.name}`;
    button.addEventListener('click', async () => {
      if (firmwareDownloading || activeCompile || flashing) return;
      if (lastResult !== result || !resultMatchesCurrentContext(result)) {
        invalidateCompileOutput();
        setStatus('代码或板卡配置已改变，请重新编译后再下载', 0, 'var(--warn)');
        return;
      }
      firmwareDownloading = true;
      updateActionState();
      setStatus(`正在校验固件：${artifact.name}…`, 100);
      try {
        const bytes = await artifactBytes(artifact);
        if (lastResult !== result || !resultMatchesCurrentContext(result)) {
          setStatus('代码或板卡配置已改变，已丢弃过期固件下载', 0, 'var(--warn)');
          return;
        }
        downloadBytes(bytes, artifact.name);
        setStatus(`固件已下载：${artifact.name} · ${bytes.length} 字节`, 100, 'var(--ok)');
      } catch (error) {
        setStatus(String(error?.message ?? error), 100, 'var(--err)');
      } finally {
        firmwareDownloading = false;
        updateActionState();
      }
    });

    row.append(label, button);
    artifactDownloadsEl.append(row);
  }
}

function clearCompileOutput() {
  lastHex = null;
  lastResult = null;
  lastDiags = [];
  renderDiags();
  renderGutter();
  renderMemory(null);
  renderArtifactDownloads(null);
  updateActionState();
}

function invalidateCompileOutput() {
  const hadOutput = Boolean(lastHex || lastResult || lastDiags.length);
  clearCompileOutput();
  if (activeCompile) {
    activeCompile.browserProgress?.dispose();
    setStatus('内容已修改，当前编译结果将被忽略', 0, 'var(--warn)');
  } else if (hadOutput) {
    setStatus('内容已修改，请重新编译', 0, 'var(--warn)');
  }
}

function finishCompile(run) {
  if (activeCompile === run) {
    activeCompile = null;
    run.closed = true;
    run.eventSource?.close();
    if (run.elapsedTimer) clearInterval(run.elapsedTimer);
    if (run.statusTimer) clearTimeout(run.statusTimer);
    run.browserProgress?.dispose();
    void clearStoredCompile(run);
  }
  updateActionState();
}

function setContextInputsDisabled(disabled) {
  codeEl.disabled = disabled;
  boardEl.disabled = disabled || boards.length === 0;
  $('btn-import-project').disabled = disabled;
  $('btn-add-files').disabled = disabled;
  if ($('btn-add-files-sidebar')) $('btn-add-files-sidebar').disabled = disabled;
  if ($('btn-new-file')) $('btn-new-file').disabled = disabled;
  if ($('btn-import-archive')) $('btn-import-archive').disabled = disabled;
  if ($('btn-export-project')) $('btn-export-project').disabled = disabled;
  if (projectArchiveInput) projectArchiveInput.disabled = disabled;
  projectFileEditorForm?.querySelectorAll('input,button').forEach((control) => { control.disabled = disabled; });
  projectFilesEl?.querySelectorAll('button').forEach((control) => { control.disabled = disabled; });
  if (projectIdEl) projectIdEl.disabled = disabled;
  if ($('btn-cloud-save')) $('btn-cloud-save').disabled = disabled;
  if ($('btn-cloud-load')) $('btn-cloud-load').disabled = disabled;
  libraryListEl?.querySelectorAll('input,button').forEach((input) => { input.disabled = disabled; });
  optionsEl.querySelectorAll('select').forEach((select) => { select.disabled = disabled; });
  if (!disabled) syncBoardOptionConstraints();
}

function elapsedLabel(run) {
  const seconds = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1_000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function setRunStatus(run, stage = run.stage, detail = run.detail) {
  if (activeCompile !== run || run.closed || currentCompileContextKey() !== run.key) return;
  run.stage = stage;
  run.detail = detail;
  const label = compileStageLabels[stage] ?? stage;
  const suffix = detail ? ` · ${detail}` : '';
  setStatus(`${label}${suffix} · 已 ${elapsedLabel(run)}`, run.percent);
}

function safeEventData(event) {
  try {
    const value = JSON.parse(event.data);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function storeCompile(run) {
  if (!run.jobId || !run.stream) return;
  try {
    const status = await activeCompilePersistence.put({
      jobId: run.jobId,
      stream: run.stream,
      context: compactStoredCompileContext(run.context),
      startedAt: run.startedAt,
      acceptedAt: run.acceptedAt ?? run.startedAt,
      acceptanceId: run.acceptanceId,
      acceptanceEpoch: run.acceptanceEpoch,
      cancellation: run.cancellation,
    });
    if (status?.record?.jobId === run.jobId) {
      if (status.record.acceptanceId) run.acceptanceId = status.record.acceptanceId;
      if (Number.isSafeInteger(status.record.acceptanceEpoch)) {
        run.acceptanceEpoch = status.record.acceptanceEpoch;
      }
    }
    run.persistence = status.persistence;
    return status;
  } catch (error) {
    // Validation failures are programming errors; keep the accepted job alive
    // in this tab and make the persistence failure observable.
    console.warn('[SketchForge] Active compile record could not be stored.', error);
    return null;
  }
}

async function clearStoredCompile(run) {
  if (!run.jobId) return;
  try {
    await activeCompilePersistence.delete(run.jobId, run.acceptanceId);
  } catch (error) {
    console.warn('[SketchForge] Active compile record could not be cleared.', error);
  }
}

async function loadStoredCompile() {
  try {
    return await activeCompilePersistence.load();
  } catch (error) {
    console.warn('[SketchForge] Active compile record could not be loaded.', error);
    return null;
  }
}

function newCompileAcceptanceId() {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (typeof id === 'string' && id.length > 0) return id;
  } catch { /* fall through */ }
  return `acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeCompileRun(context, details = {}) {
  return {
    context,
    key: compileContextKey(context),
    eventSource: null,
    jobId: null,
    stream: null,
    cancellation: null,
    controller: new AbortController(),
    cancelRequested: false,
    cancelling: false,
    phase: 'browser',
    startedAt: Date.now(),
    acceptedAt: null,
    acceptanceId: null,
    acceptanceEpoch: null,
    stage: 'accepted',
    detail: '',
    percent: 4,
    elapsedTimer: null,
    statusTimer: null,
    browserProgress: null,
    browserStage: null,
    checkingStatus: false,
    closed: false,
    persistence: 'memory',
    ...details,
  };
}

function scheduleJobStatusCheck(run, delay = JOB_STATUS_POLL_MS) {
  if (activeCompile !== run || run.closed || !run.jobId || run.statusTimer) return;
  run.statusTimer = setTimeout(async () => {
    run.statusTimer = null;
    await checkJobStatus(run);
  }, delay);
}

async function checkJobStatus(run) {
  if (activeCompile !== run || run.closed || !run.jobId || run.checkingStatus) return;
  run.checkingStatus = true;
  try {
    const response = await fetch(apiUrl(`compile/${encodeURIComponent(run.jobId)}`));
    if (!response.ok) {
      if (response.status === 404) {
        finishCompile(run);
        setStatus('编译任务已过期，请重新编译', 0, 'var(--warn)');
      } else {
        setRunStatus(run, 'reconnecting');
        scheduleJobStatusCheck(run);
      }
      return;
    }

    const job = await response.json();
    if (job?.state === 'cancelled') {
      await applyCompileResult(run, job.result ?? {
        status: 'error',
        reason: 'cancelled',
        message: 'compile was cancelled',
        diagnostics: [],
        timings: {},
      });
      return;
    }
    if (job?.state === 'cancelling') {
      setStatus(`正在取消编译 · 已 ${elapsedLabel(run)}`, run.percent, 'var(--warn)');
      scheduleJobStatusCheck(run);
      return;
    }
    if (job?.state === 'completed' && job.result) {
      await applyCompileResult(run, job.result);
      return;
    }
    if (job?.state === 'failed') {
      await applyCompileResult(run, {
        status: 'error',
        reason: 'internal',
        message: '编译 worker 在完成前退出，请重新编译',
        diagnostics: [],
        timings: {},
      });
      return;
    }
    // Polling is only a recovery path for a lost SSE terminal event. Do not
    // replace a real worker phase (core/PCH/linking/etc.) with the generic
    // stream label every 2.5 seconds, otherwise a long cold ESP32 build looks
    // as though it is permanently waiting for a worker.
    if (run.stage === 'reconnecting') {
      setRunStatus(run, 'reconnecting');
    } else if (run.stage === 'accepted' || run.stage === 'stream') {
      setRunStatus(run, 'stream');
    } else {
      setRunStatus(run);
    }
    scheduleJobStatusCheck(run);
  } catch {
    setRunStatus(run, 'reconnecting');
    scheduleJobStatusCheck(run);
  } finally {
    run.checkingStatus = false;
  }
}

function connectCompileStream(run) {
  if (activeCompile !== run || run.closed || !run.stream) return;
  run.eventSource?.close();

  const es = new EventSource(run.stream);
  run.eventSource = es;
  es.addEventListener('open', () => {
    if (activeCompile !== run || run.closed) return;
    // A reconnect can happen in the middle of a cold core build. Preserve the
    // last concrete phase until the replayed SSE progress frame arrives.
    if (run.stage === 'accepted' || run.stage === 'stream' || run.stage === 'reconnecting') {
      setRunStatus(run, 'stream');
    } else {
      setRunStatus(run);
    }
  });
  es.addEventListener('progress', (event) => {
    if (activeCompile !== run || run.closed || currentCompileContextKey() !== run.key) return;
    const progress = safeEventData(event);
    if (!progress || typeof progress.stage !== 'string') return;
    run.percent = typeof progress.percent === 'number' ? progress.percent : run.percent;
    setRunStatus(run, progress.stage, typeof progress.detail === 'string' ? progress.detail : '');
  });
  es.addEventListener('diagnostic', (event) => {
    if (activeCompile !== run || run.closed || currentCompileContextKey() !== run.key) return;
    const payload = safeEventData(event);
    if (!payload?.diagnostic) return;
    lastDiags.push(payload.diagnostic);
    renderDiags();
    renderGutter();
  });
  es.addEventListener('done', async (event) => {
    if (activeCompile !== run || run.closed) return;
    const payload = safeEventData(event);
    if (!payload?.result) return;
    await applyCompileResult(run, payload.result);
  });
  es.onerror = () => {
    if (activeCompile !== run || run.closed) return;
    // EventSource retries on its own. Keep the job active and use the REST
    // status endpoint as a second path for completed jobs and page refreshes.
    setRunStatus(run, 'reconnecting');
    scheduleJobStatusCheck(run, 0);
  };
}

function startCompileTracking(run) {
  setRunStatus(run);
  run.elapsedTimer = setInterval(() => setRunStatus(run), 1_000);
  connectCompileStream(run);
  updateActionState();
}

async function restoreStoredCompile(saved, operation) {
  if (!saved || !operation || !projectRestoreOperations.isCurrent(operation)) return false;
  if (compileRecoveryBoardDisposition(boards, saved.context.board) === 'defer') return false;

  const persistenceWasReady = projectStateReady;
  projectStateReady = false;
  try {
    if (!projectRestoreOperations.isCurrent(operation)) return false;
    const restored = Array.isArray(saved.context.files)
      ? createProjectSnapshot(saved.context.files)
      : createProjectSnapshot([{ name: 'main.ino', content: saved.context.source }]);
    installProjectSnapshot(restored, saved.context.activeFile ?? restored.sketch);
    installLibrarySelections(saved.context.libraries);
    renderLibraryList();
    boardEl.value = saved.context.board;
    renderBoardOptions(saved.context.options);
  } catch {
    await activeCompilePersistence.delete(saved.jobId, saved.acceptanceId);
    return false;
  } finally {
    projectStateReady = persistenceWasReady;
  }
  renderGutter();

  const context = snapshotCompileContext();
  if (compileContextKey(context) !== compileContextKey(saved.context)) {
    await activeCompilePersistence.delete(saved.jobId, saved.acceptanceId);
    return false;
  }
  persistLocalProjectState();

  const run = makeCompileRun(context, {
    jobId: saved.jobId,
    stream: saved.stream,
    cancellation: validCancellationHandle(saved.cancellation) ? saved.cancellation : null,
    startedAt: saved.startedAt,
    acceptedAt: saved.acceptedAt ?? saved.startedAt,
    acceptanceId: saved.acceptanceId ?? null,
    acceptanceEpoch: saved.acceptanceEpoch ?? null,
    stage: 'reconnecting',
    phase: 'remote',
  });
  activeCompile = run;
  clearCompileOutput();
  startCompileTracking(run);
  await checkJobStatus(run);
  return activeCompile === run;
}

// ---------------------------------------------------------------------------
// 编译：POST /v1/compile → SSE
// ---------------------------------------------------------------------------

async function cancelRemoteCompile(run) {
  if (activeCompile !== run || run.closed || !validCancellationHandle(run.cancellation)) return;
  run.cancelling = true;
  updateActionState();
  setStatus(`正在取消编译 · 已 ${elapsedLabel(run)}`, run.percent, 'var(--warn)');
  try {
    const response = await fetch(run.cancellation.url, {
      method: 'DELETE',
      headers: { 'X-AF-Cancel-Token': run.cancellation.token },
    });
    if (activeCompile !== run || run.closed) return;
    const result = await response.json().catch(() => ({}));
    if (response.status === 404) {
      run.cancelling = false;
      run.cancellation = null;
      await storeCompile(run);
      updateActionState();
      await checkJobStatus(run);
      if (activeCompile === run && !run.closed) {
        setStatus('取消句柄已过期，正在继续等待任务结果', run.percent, 'var(--warn)');
      }
      return;
    }
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    if (result.cancelled) {
      finishCompile(run);
      clearCompileOutput();
      setStatus(
        result.jobCancelled ? '编译已取消' : '已取消本次编译请求，共享任务仍在继续',
        0,
        'var(--warn)',
      );
      return;
    }
    run.cancelling = false;
    updateActionState();
    await checkJobStatus(run);
  } catch (error) {
    if (activeCompile !== run || run.closed) return;
    run.cancelling = false;
    updateActionState();
    setStatus(`取消失败，编译仍在进行：${error.message}`, run.percent, 'var(--warn)');
    scheduleJobStatusCheck(run, 0);
  }
}

function completeLocalCancellation(run, message = '编译已取消') {
  if (activeCompile !== run || run.closed) return;
  finishCompile(run);
  clearCompileOutput();
  setStatus(message, 0, 'var(--warn)');
}

async function cancelCompile() {
  const run = activeCompile;
  if (!run || run.cancelling) return;
  if (validCancellationHandle(run.cancellation)) {
    await cancelRemoteCompile(run);
    return;
  }
  if (
    (run.phase !== 'browser' && run.phase !== 'submitting')
    || run.controller.signal.aborted
  ) return;

  run.cancelRequested = true;
  run.cancelling = true;
  run.controller.abort();
  updateActionState();
  setStatus(`正在取消编译 · 已 ${elapsedLabel(run)}`, run.percent, 'var(--warn)');

  if (run.phase === 'browser') completeLocalCancellation(run);
}

async function compile() {
  if (activeCompile) {
    await cancelCompile();
    return;
  }
  if (flashing) return;
  showOutputView('diagnostics');
  cancelPendingProjectRestore();
  if (!boardStateReady || !currentBoard()) {
    setStatus('请先选择有效的板卡配置再编译', 0, 'var(--warn)');
    return;
  }

  const context = snapshotCompileContext();
  const run = makeCompileRun(context);
  activeCompile = run;
  clearCompileOutput();
  setStatus('准备编译…', 2);

  const body = {
    board: context.board,
    files: context.files,
    libraries: context.libraries,
    options: context.options,
  };

  let browserBuild;
  const browserProgress = createBrowserCompileProgressReporter({
    onStatus: setStatus,
    onIndeterminateChange: setProgressIndeterminate,
  });
  run.browserProgress = browserProgress;
  let browserAssetAttempt = 0;
  const onBrowserProgress = ({ stage, percent, detail }) => {
    if (activeCompile !== run || currentCompileContextKey() !== run.key) return;
    if (stage === 'fallback') return;
    run.browserStage = stage;
    const visibleDetail = browserAssetAttempt > 0 && stage === 'assets'
      ? '连接中断，正在自动重试 1/1'
      : detail;
    browserProgress.report({ stage, percent, detail: visibleDetail });
  };
  try {
    browserBuild = await compileInBrowser(body, onBrowserProgress, { signal: run.controller.signal });
    if (
      !run.controller.signal.aborted
      && activeCompile === run
      && currentCompileContextKey() === run.key
      && shouldRetryBrowserAssetBuild(browserBuild, run.browserStage, browserAssetAttempt, context.board)
    ) {
      browserAssetAttempt += 1;
      console.warn('[SketchForge] Browser compile assets failed; retrying once.', browserBuild.error);
      browserProgress.report({ stage: 'assets', percent: 0, detail: '连接中断，正在自动重试 1/1' });
      browserBuild = await compileInBrowser(body, onBrowserProgress, { signal: run.controller.signal });
    }
  } catch {
    if (run.controller.signal.aborted) {
      completeLocalCancellation(run);
      return;
    }
    // 浏览器编译器故障不能卡住页面；统一交给服务端编译通道兜底。
    browserBuild = { handled: false, reason: 'runtime' };
  } finally {
    browserProgress.dispose();
    run.browserProgress = null;
  }
  if (activeCompile !== run) return;
  if (run.controller.signal.aborted) {
    completeLocalCancellation(run);
    return;
  }
  const route = compileFallbackRoute(browserBuild, serverBoardAvailable(context.board));
  if (route === 'browser') {
    await applyCompileResult(run, browserBuild.result);
    return;
  }
  if (route === 'unavailable') {
    finishCompile(run);
    const routeInfo = browserBoardRoute(context.board);
    const message = browserCompileUnavailableMessage(browserBuild, routeInfo);
    setStatus(`${message}，服务端编译 worker 也未就绪`, 0, 'var(--warn)');
    return;
  }
  run.phase = 'submitting';
  setStatus('正在提交编译任务…', 4);
  updateActionState();

  let res;
  try {
    res = await fetch(apiUrl('compile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AF-Visitor': visitorId },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (activeCompile !== run) return;
    if (run.cancelRequested) {
      completeLocalCancellation(run);
      return;
    }
    finishCompile(run);
    setStatus(`无法连接底座：${e.message}`, 0, 'var(--err)');
    return;
  }

  if (res.status === 429) {
    if (run.cancelRequested) {
      completeLocalCancellation(run);
      return;
    }
    finishCompile(run);
    setStatus('编译队列已满，请稍后重试', 0, 'var(--warn)');
    return;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (activeCompile !== run) return;
    if (run.cancelRequested) {
      completeLocalCancellation(run);
      return;
    }
    finishCompile(run);
    setStatus(`提交失败：${err.message || res.status}`, 0, 'var(--err)');
    return;
  }

  let accepted;
  try {
    accepted = validateCompileAcceptance(await res.json());
  } catch (e) {
    if (activeCompile !== run) return;
    if (run.cancelRequested) {
      completeLocalCancellation(run);
      return;
    }
    finishCompile(run);
    setStatus(`提交失败：${e.message}`, 0, 'var(--err)');
    return;
  }

  const disposition = await commitCompileAcceptance({
    accepted,
    isCancellationRequested: () => run.cancelRequested,
    commit: async (value) => {
      run.jobId = value.jobId;
      run.stream = value.stream;
      run.acceptedAt = Date.now();
       run.acceptanceId = newCompileAcceptanceId();
      run.cancellation = validCancellationHandle(value.cancellation) ? value.cancellation : null;
      run.phase = 'remote';
      run.stage = value.reused ? 'accepted' : 'stream';
      run.detail = value.reused ? '复用相同的在途任务' : '';
      await storeCompile(run);
    },
    cancelAccepted: () => cancelRemoteCompile(run),
    abandonAccepted: () => completeLocalCancellation(run, '已取消显示本次编译结果'),
  });
  if (disposition !== 'accepted') return;
  startCompileTracking(run);
}

async function applyCompileResult(run, result) {
  if (activeCompile !== run) return;
  finishCompile(run);

  if (result?.status === 'error' && result.reason === 'cancelled') {
    clearCompileOutput();
    setStatus('编译已取消', 0, 'var(--warn)');
    return;
  }

  if (currentCompileContextKey() !== run.key) {
    clearCompileOutput();
    setStatus('内容已修改，编译结果已忽略，请重新编译', 0, 'var(--warn)');
    return;
  }

  lastDiags = result.diagnostics || [];
  renderDiags();
  renderGutter();

  if (result.status === 'success') {
    const art = result.artifacts?.[0] ?? result.staticArtifacts?.[0];
    if (!art) {
      clearCompileOutput();
      setStatus('编译结果缺少固件产物', 100, 'var(--err)');
      return;
    }
    const committedResult = {
      ...result,
      __compileContext: run.context,
      __compileContextKey: run.key,
    };
    lastResult = committedResult;
    renderMemory(result.memory);
    renderArtifactDownloads(lastResult);
    const ms = Math.round(result.timings.total ?? 0);
    setStatus(
      `编译成功 · ${art.size} 字节 · ${ms} ms${result.cached ? '（命中缓存）' : ''}`,
      100, 'var(--ok)',
    );
    updateActionState();
    try {
      // Prime AVR flashing, but keep a successful compile usable when a
      // transient artifact fetch fails. flash() retries after port selection.
      const hexArtifact = result.artifacts?.find((artifact) => artifact.name.endsWith('.hex'));
      const hex = hexArtifact ? await artifactText(hexArtifact) : null;
      if (lastResult === committedResult) lastHex = hex;
    } catch {
      if (lastResult === committedResult) lastHex = null;
    }
  } else {
    renderMemory(null);
    setStatus(`编译失败：${result.message}`, 100, 'var(--err)');
    if (lastDiags.length) openDiagnostic(lastDiags[0]);
  }
}

// ---------------------------------------------------------------------------
// 烧录：Web Serial（零安装的兑现）
// ---------------------------------------------------------------------------

async function flash() {
  if (flashing || activeCompile || !lastResult) return;
  if (!resultMatchesCurrentContext()) {
    invalidateCompileOutput();
    setStatus('代码或板卡配置已改变，请重新编译后再烧录', 0, 'var(--warn)');
    return;
  }
  if (!webSerialSupported()) {
    setStatus('当前浏览器不支持 Web Serial（Safari / iOS 不支持）', 0, 'var(--err)');
    return;
  }

  const result = lastResult;
  const context = result.__compileContext;
  const board = boards.find((b) => b.fqbn === context.board);
  const isEsp = board?.upload?.protocol === 'esp32' || board?.upload?.protocol === 'esp8266';
  const baud = uploadSpeed(board, context.options);
  let port = null;

  flashing = true;
  setContextInputsDisabled(true);
  updateActionState();

  try {
    // 先在用户点击的调用链里选端口，避免等待关闭监视器后丢失 user activation。
    port = await navigator.serial.requestPort();
    await stopMonitor();
    if (currentCompileContextKey() !== result.__compileContextKey) {
      throw new Error('代码或板卡配置已改变，请重新编译后再烧录');
    }

    if (isEsp) {
      // esptool-js 自己管端口的 open/close 和波特率协商，这里不要抢着 open
      await flashEsp32(port, result, board, context.options,
        (msg, pct) => setStatus(msg, pct));
      setStatus('烧录完成', 100, 'var(--ok)');
    } else {
      if (!lastHex) {
        const hexArtifact = result.artifacts?.find((artifact) => artifact.name.endsWith('.hex'));
        if (!hexArtifact) throw new Error('编译结果缺少 AVR HEX 固件');
        lastHex = await artifactText(hexArtifact);
      }
      setStatus(`打开串口 @ ${baud} bps…`, 1);
      await port.open({ baudRate: baud });
      const flasher = new Stk500Flasher(port, (msg, pct) => setStatus(msg, pct));
      const written = await flasher.flash(lastHex);
      setStatus(`烧录完成，共 ${written} 字节`, 100, 'var(--ok)');
    }
  } catch (e) {
    setStatus(friendlyFlashError(e, baud), 0, 'var(--err)');
    // ESP32 握手失败后，"已完整烧录"的记忆可能不准，清掉以免下次错误地跳过静态分片
    if (isEsp) forgetFlashedDevices();
  } finally {
    if (!isEsp) { try { await port?.close(); } catch { /* 忽略 */ } }
    flashing = false;
    setContextInputsDisabled(false);
    updateActionState();
  }
}

/**
 * 把浏览器/协议层的原始报错翻译成用户能照着做的提示。
 *
 * 烧录失败的原因高度集中在少数几种，而原生报错（英文、面向开发者）
 * 对最终用户毫无指导意义。图形化平台面向的是新手，这一层不能省。
 */
function friendlyFlashError(e, baud) {
  const m = String(e?.message ?? e);
  if (/No port selected|NotFoundError/i.test(m)) {
    return '没有选择串口。点「烧录到板子」后，请在弹出的列表里选中你的开发板。';
  }
  if (/user gesture/i.test(m)) {
    // Web Serial 要求 requestPort() 必须由真实用户手势触发。
    // 脚本里 element.click() 不算 —— 上层平台如果想自动烧录，
    // 必须在用户真实点击的事件处理里调用，或复用已授权的端口。
    return '浏览器要求由你亲自点击才能选择串口。请手动点一下「烧录到板子」。';
  }
  if (/already open|InvalidStateError/i.test(m)) {
    return '串口已被占用。请先关闭串口监视器，或退出 Arduino IDE 等占用该端口的程序。';
  }
  if (/Failed to open|NetworkError|Access denied/i.test(m)) {
    return '打开串口失败。请检查数据线是否支持数据传输（有些线只能充电）、驱动是否正常。';
  }
  if (/无法与 bootloader 同步/.test(m)) {
    return `无法与 bootloader 同步（当前 ${baud} bps）。最常见的原因是波特率选错了 —— ` +
           `老款 Nano 要选「老 bootloader，57600」。也请确认选对了串口、且没有被其他程序占用。`;
  }
  if (/协议不同步|命令被拒绝/.test(m)) {
    return `${m}\n通常是波特率不匹配或板子型号选错。试试切换「处理器 / Bootloader」选项。`;
  }
  if (/串口读取超时/.test(m)) {
    return '板子没有响应。请按一下板上的 RESET 键后立即重试，或检查是否选对了板子型号。';
  }
  return `烧录失败：${m}`;
}

// ---------------------------------------------------------------------------
// 串口监视器
// ---------------------------------------------------------------------------

async function toggleMonitor() {
  if (monitorOpening || flashing) return;
  if (monitorAbort) { await stopMonitor(); return; }
  showOutputView('monitor');
  if (!webSerialSupported()) {
    monitorEl.textContent = '当前浏览器不支持 Web Serial。';
    return;
  }
  let port = null;
  monitorOpening = true;
  updateActionState();
  try {
    // 不缓存端口：每次打开监视器都可以安全地重新选择设备。
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    monitorEl.textContent = '';
    $('btn-monitor').textContent = '停止监视';

    const reader = port.readable.getReader();
    const stop = async () => {
      try { await reader.cancel(); } catch { /* 忽略 */ }
      try { reader.releaseLock(); } catch { /* 忽略 */ }
      try { await port.close(); } catch { /* 忽略 */ }
      if (monitorAbort === stop) monitorAbort = null;
      $('btn-monitor').textContent = '串口监视器';
    };
    monitorAbort = stop;
    monitorOpening = false;
    updateActionState();

    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      monitorEl.textContent += decoder.decode(value, { stream: true });
      // 只保留最后 20000 字符，防止长时间运行吃光内存
      if (monitorEl.textContent.length > 20000) {
        monitorEl.textContent = monitorEl.textContent.slice(-20000);
      }
      monitorEl.scrollTop = monitorEl.scrollHeight;
    }
    if (monitorAbort === stop) await stop();
  } catch (e) {
    monitorOpening = false;
    try { await port?.close(); } catch { /* 忽略 */ }
    updateActionState();
    monitorEl.textContent += `\n[监视器错误] ${e.message}`;
    await stopMonitor();
  }
}

async function stopMonitor() {
  if (monitorAbort) await monitorAbort();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  setRuntimeIndicator('正在恢复编译记录', 'loading');
  if (projectArchiveInput) {
    projectArchiveInput.accept = [
      '.json',
      PROJECT_ARCHIVE_EXTENSION,
      LEGACY_PROJECT_ARCHIVE_EXTENSION,
      'application/json',
    ].join(',');
  }
  try {
    const savedProjectId = migratedStorageValue(
      globalThis.localStorage,
      CLOUD_PROJECT_ID_STORAGE_KEY,
      LEGACY_CLOUD_PROJECT_ID_STORAGE_KEY,
    );
    if (savedProjectId && projectIdEl) projectIdEl.value = savedProjectId;
  } catch { /* optional */ }
  const savedCompile = await withTimeout(
    loadStoredCompile(),
    4_000,
    'active compile recovery',
  ).catch((error) => {
    console.warn('[SketchForge] Active compile recovery timed out; continuing startup.', error);
    return null;
  });
  const storedProject = loadProjectState(projectStateStorage)
    ?? loadProjectState(legacyProjectStateStorage, { migrationStorage: projectStateStorage });
  try {
    const initial = savedCompile?.context?.files
      ? createProjectSnapshot(savedCompile.context.files)
      : storedProject?.files
        ? createProjectSnapshot(storedProject.files)
        : createProjectSnapshot([{ name: 'main.ino', content: savedCompile?.context?.source ?? DEFAULT_SKETCH }]);
    installProjectSnapshot(initial, savedCompile?.context?.activeFile ?? storedProject?.activeFile ?? initial.sketch);
  } catch {
    installProjectSnapshot(createProjectSnapshot([{ name: 'main.ino', content: DEFAULT_SKETCH }]));
  }
  installLibrarySelections(savedCompile?.context?.libraries ?? storedProject?.libraries ?? []);
  restoredBoard = savedCompile?.context?.board ?? storedProject?.board ?? '';
  restoredOptions = Object.freeze({ ...(savedCompile?.context?.options ?? storedProject?.options ?? {}) });
  projectStateReady = true;
  persistLocalProjectState();
  bindUiEvents();
  const startupRestoreOperation = projectRestoreOperations.begin();

  try {
    const r = await fetch(apiUrl('boards'));
    const payload = await r.json();
    if (!r.ok || !Array.isArray(payload.boards)) throw new Error('invalid board response');
    boards = [
      ...payload.boards,
      ...(Array.isArray(payload.unavailableBoards) ? payload.unavailableBoards : []),
    ];
    setRuntimeIndicator('WASM 编译器已就绪', 'ready');
  } catch {
    projectRestoreOperations.finish(startupRestoreOperation);
    setRuntimeIndicator('等待底座连接', 'error');
    setStatus('无法获取板子列表，底座是否已启动？', 0, 'var(--err)');
    return;
  }

  renderBoardSelector();
  let restoredConfigurationWarning = '';
  if (restoredBoard) {
    const configuration = validateRestoredBoardConfiguration(boards, restoredBoard, restoredOptions);
    if (configuration.valid) {
      boardEl.value = configuration.board.fqbn;
      renderBoardOptions(configuration.options);
      boardStateReady = true;
    } else {
      restoredConfigurationWarning = restoredBoardConfigurationError(configuration);
      boardStateReady = false;
      if (configuration.reason === 'board') renderMissingBoardSelection(restoredBoard);
      else {
        boardEl.value = restoredBoard;
        renderBoardOptions();
      }
    }
  } else {
    renderBoardOptions();
    boardStateReady = true;
  }
  persistLocalProjectState();
  updateActionState();
  void loadLibraryCatalog().catch((error) => {
    setLibraryImportStatus(`库目录加载失败：${String(error?.message ?? error)}`, 'error');
  });

  if (boardStateReady && await restoreStoredCompile(savedCompile, startupRestoreOperation)) {
    projectRestoreOperations.finish(startupRestoreOperation);
    return;
  }
  if (!projectRestoreOperations.isCurrent(startupRestoreOperation)) return;
  projectRestoreOperations.finish(startupRestoreOperation);

  if (restoredConfigurationWarning) {
    setStatus(restoredConfigurationWarning, 0, 'var(--warn)');
  } else if (!boards.some((board) => board.available !== false)) {
    setRuntimeIndicator('等待服务端 Worker', 'warning');
    setStatus('服务端编译 worker 未就绪，可用板卡仍会优先尝试浏览器编译', 0, 'var(--warn)');
  } else if (!webSerialSupported()) {
    setRuntimeIndicator('WASM 就绪 · Web Serial 不可用', 'warning');
    setStatus('就绪（当前浏览器不支持 Web Serial，可编译但不能烧录）', 0, 'var(--warn)');
  }
}

function bindUiEvents() {
  if (uiEventsBound) return;
  uiEventsBound = true;
  boardEl.addEventListener('change', () => {
    cancelPendingProjectRestore();
    boardStateReady = true;
    renderBoardOptions();
    libraryCatalog = [];
    renderLibraryList();
    persistLocalProjectState();
    invalidateCompileOutput();
    void loadLibraryCatalog().catch((error) => {
      setLibraryImportStatus(`库目录加载失败：${String(error?.message ?? error)}`, 'error');
    });
  });
  $('btn-compile').addEventListener('click', compile);
  $('btn-flash').addEventListener('click', flash);
  $('btn-monitor').addEventListener('click', toggleMonitor);
  $('btn-cloud-save')?.addEventListener('click', () => { void saveCloudProject(); });
  $('btn-cloud-load')?.addEventListener('click', () => { void loadCloudProject(); });
  projectIdEl?.addEventListener('input', cancelPendingProjectRestore);
  libraryFilterEl?.addEventListener('input', renderLibraryList);
  libraryImportFormEl?.addEventListener('submit', (event) => { void importUnknownGitHubLibrary(event); });
  $('btn-import-project').addEventListener('click', () => projectFolderInput?.click());
  $('btn-add-files').addEventListener('click', () => projectFilesInput?.click());
  $('btn-add-files-sidebar')?.addEventListener('click', () => projectFilesInput?.click());
  $('btn-new-file')?.addEventListener('click', () => openProjectFileEditor());
  $('btn-cancel-file-edit')?.addEventListener('click', closeProjectFileEditor);
  projectFileEditorForm?.addEventListener('submit', submitProjectFileEdit);
  $('btn-import-archive')?.addEventListener('click', () => projectArchiveInput?.click());
  $('btn-export-project')?.addEventListener('click', exportProjectArchive);
  projectFolderInput?.addEventListener('change', () => importProjectFiles(projectFolderInput.files, 'replace'));
  projectFilesInput?.addEventListener('change', () => importProjectFiles(projectFilesInput.files, 'add'));
  projectArchiveInput?.addEventListener('change', () => {
    void importProjectArchive(projectArchiveInput.files?.[0]);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && projectFileEditorForm && !projectFileEditorForm.hidden) {
      event.preventDefault();
      closeProjectFileEditor();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!activeCompile && !flashing) void compile();
    }
  });
}

/**
 * 编译选项**完全由板子定义驱动** —— 板子 JSON 加一个选项，前端自动多一个下拉框，
 * 不需要改一行前端代码。ESP32 的分区方案 / flash 大小 / flash 模式
 * 将来走的是同一条通路。前端对具体有哪些选项一无所知。
 */
const boardGroupLabels = {
  avr: 'Arduino AVR',
  esp32: 'ESP32',
  esp8266: 'ESP8266',
  stm32: 'STM32',
};
const BROWSER_FIRST_DEFAULT_BOARD = 'arduino:avr:uno';

function serverBoardAvailable(fqbn = boardEl.value) {
  return boards.some((board) => board.fqbn === fqbn && board.available !== false);
}

function renderBoardSelector() {
  const previous = boardEl.value;
  const groups = new Map();
  for (const board of boards) {
    const group = groups.get(board.arch) ?? [];
    group.push(board);
    groups.set(board.arch, group);
  }

  boardEl.innerHTML = [...groups.entries()]
    .map(([arch, group]) => {
      const label = boardGroupLabels[arch] ?? arch;
      const options = group.map((board) => {
        const unavailable = board.available === false;
        const browserRoute = browserBoardRoute(board.fqbn);
        const suffix = unavailable
          ? (browserRoute.supported
            ? '（可浏览器编译）'
            : browserRoute.reason === 'browser_pack'
              ? '（浏览器 Pack 未发布）'
              : '（需服务端编译 worker）')
          : '';
        return `<option value="${escapeHtml(board.fqbn)}">${escapeHtml(board.name + suffix)}</option>`;
      }).join('');
      return `<optgroup label="${escapeHtml(label)}">${options}</optgroup>`;
    })
    .join('');

  const selected = boards.find((board) => board.fqbn === previous)
    ?? boards.find((board) => board.available !== false)
    ?? boards.find((board) => board.fqbn === BROWSER_FIRST_DEFAULT_BOARD)
    ?? boards[0];
  if (selected) boardEl.value = selected.fqbn;
  boardEl.disabled = boards.length === 0;
}

function renderMissingBoardSelection(fqbn) {
  const group = document.createElement('optgroup');
  group.label = '不可用的已保存板卡';
  const option = document.createElement('option');
  option.value = fqbn;
  option.textContent = fqbn;
  option.disabled = true;
  option.selected = true;
  group.append(option);
  boardEl.append(group);
  boardEl.value = fqbn;
  renderBoardOptions();
}

function renderBoardOptions(selectedOptions = null) {
  const board = currentBoard();
  optionsEl.innerHTML = (board?.options ?? [])
    .map((o) => {
      const opts = o.values
        .map((v) => {
          const unsupportedReason = unsupportedBoardOptionReason(v);
          const title = unsupportedReason ? ` title="${escapeHtml(unsupportedReason)}"` : '';
          const disabled = boardOptionUnavailable(v) ? ' disabled' : '';
          return `<option value="${escapeHtml(v.value)}"${v.value === o.default ? ' selected' : ''}${disabled}${title}>${escapeHtml(v.label)}</option>`;
        })
        .join('');
      const id = `board-option-${o.id}`;
      return `<label class="board-option" for="${escapeHtml(id)}">
        <span>${escapeHtml(o.label)}</span>
        <select id="${escapeHtml(id)}" data-opt="${escapeHtml(o.id)}" title="${escapeHtml(o.label)}">${opts}</select>
      </label>`;
    })
    .join('');
  if (selectedOptions && typeof selectedOptions === 'object') {
    for (const select of optionsEl.querySelectorAll('select[data-opt]')) {
      const value = selectedOptions[select.dataset.opt];
      if (typeof value === 'string' && [...select.options].some((option) => option.value === value)) {
        select.value = value;
      }
    }
  }
  syncBoardOptionConstraints();
  optionsEl.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => {
    cancelPendingProjectRestore();
    boardStateReady = true;
    syncBoardOptionConstraints();
    renderUploadHint();
    persistLocalProjectState();
    const definition = currentBoard()?.options.find((option) => option.id === s.dataset.opt);
    if (definition?.affectsBuild !== false) invalidateCompileOutput();
  }));
  renderUploadHint();
}

function optionValueAllowed(value, selected) {
  return Object.entries(value.requires ?? {}).every(([optionId, allowed]) =>
    Array.isArray(allowed) && allowed.includes(selected[optionId]),
  );
}

function syncBoardOptionConstraints() {
  const board = currentBoard();
  if (!board) return;
  // Dependencies can point both ways (for example S3 OPI Flash and OPI
  // PSRAM), so settle the small option set instead of assuming render order.
  for (let pass = 0; pass < board.options.length; pass++) {
    const selected = currentOptions();
    let changed = false;
    for (const select of optionsEl.querySelectorAll('select[data-opt]')) {
      const definition = board.options.find((option) => option.id === select.dataset.opt);
      if (!definition) continue;
      for (const option of select.options) {
        const value = definition.values.find((item) => item.value === option.value);
        option.disabled = Boolean(value && (
          boardOptionUnavailable(value) || !optionValueAllowed(value, selected)
        ));
      }
      if (select.selectedOptions[0]?.disabled) {
        const fallback = [...select.options].find((option) => !option.disabled);
        if (fallback) {
          select.value = fallback.value;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

const currentBoard = () => boards.find((b) => b.fqbn === boardEl.value);

/** 收集当前所有选项值 */
function currentOptions() {
  const out = {};
  optionsEl.querySelectorAll('select[data-opt]').forEach((s) => { out[s.dataset.opt] = s.value; });
  return out;
}

/**
 * 解析生效的烧录波特率。
 *
 * Nano 的老 bootloader 是 57600、新 optiboot 是 115200，选错就一直同步不上
 * 且毫无提示 —— 新手最常踩的坑之一。这里靠板子定义里的 speedByOption
 * 数据驱动解析，前端不需要为任何特定板子写 if。
 */
function uploadSpeed(board = currentBoard(), opts = currentOptions()) {
  const up = board?.upload;
  if (!up) return 115200;
  for (const [optId, table] of Object.entries(up.speedByOption ?? {})) {
    const v = opts[optId];
    if (v && table[v]) return table[v];
  }
  return up.speed ?? 115200;
}

function renderUploadHint() {
  const b = currentBoard();
  if (!b) return;
  $('btn-flash').title = `${b.upload.protocol} @ ${uploadSpeed()} bps`;
}

init();
