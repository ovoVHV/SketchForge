import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(
  join(process.cwd(), 'packages/web/public/app.js'),
  'utf8',
);
const pageSource = readFileSync(
  join(process.cwd(), 'packages/web/public/index.html'),
  'utf8',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssRuleBodiesForSelector(source: string, selector: string): string[] {
  const selectorPattern = new RegExp(
    `(?:^|[\\s,>+~.#])${escapeRegExp(selector)}(?=\\s*(?:[,>+~:#.\\[]|$))`,
  );
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, header]) => selectorPattern.test(header.replace(/\/\*[\s\S]*?\*\//g, '').trim()))
    .map(([, , declarations]) => declarations);
}

function hasThemeDeclarations(bodies: string[]): boolean {
  return bodies.some((declarations) =>
    /(?:^|;)\s*color\s*:\s*var\(--ink\)/.test(declarations)
    && /(?:^|;)\s*background(?:-color)?\s*:\s*var\(--(?:canvas|surface(?:-[\w-]+)?)\)/.test(declarations),
  );
}

function sourceSection(start: string, end: string): string {
  const startIndex = appSource.indexOf(start);
  if (startIndex < 0) throw new Error(`missing app.js section start: ${start}`);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`missing app.js section end: ${end}`);
  return appSource.slice(startIndex, endIndex);
}

describe('app P1 workflow wiring', () => {
  it('renders an accessible circular progress indicator', () => {
    const html = readFileSync(
      join(process.cwd(), 'packages/web/public/index.html'),
      'utf8',
    );
    expect(html).toMatch(/class="progress-ring"\s+id="progress-ring"\s+role="progressbar"/);
    expect(html).toMatch(/id="progress-value">0%<\/span>/);
    expect(appSource).toMatch(/PROGRESS_RING_CIRCUMFERENCE/);
    expect(appSource).toMatch(/progressRingEl\.setAttribute\('aria-valuenow'/);
    expect(appSource).toMatch(/progressValueEl\.textContent/);
    expect(appSource).not.toMatch(/progressEl\.style\.width/);
    expect(html).toMatch(/progress-ring\[data-indeterminate="true"\]/);
    expect(appSource).toMatch(/function setProgressIndeterminate\(active\)/);
  });

  it('keeps browser asset loading alive and retries one transient asset-stage failure', () => {
    expect(appSource).toMatch(/createBrowserCompileProgressReporter\s*\(\s*\{/);
    expect(appSource).toMatch(/!run\.controller\.signal\.aborted[\s\S]*activeCompile === run[\s\S]*currentCompileContextKey\(\) === run\.key[\s\S]*shouldRetryBrowserAssetBuild\(browserBuild,\s*run\.browserStage,\s*browserAssetAttempt,\s*context\.board\)/);
    expect(appSource).toMatch(/run\.browserProgress\?\.dispose\(\)/);
    expect(appSource).toMatch(/activeCompile\.browserProgress\?\.dispose\(\)/);
    expect(appSource).toContain('连接中断，正在自动重试 1/1');
  });

  it('keeps textarea editing semantics while rendering local syntax highlighting', () => {
    const html = readFileSync(
      join(process.cwd(), 'packages/web/public/index.html'),
      'utf8',
    );
    const renderGutter = sourceSection('function renderGutter()', "codeEl.addEventListener('input'");
    const inputHandler = sourceSection(
      "codeEl.addEventListener('input'",
      "codeEl.addEventListener('compositionupdate'",
    );

    expect(appSource).toMatch(/import\s*\{\s*highlightArduino\s*\}\s*from '\.\/syntax-highlight\.js';/);
    expect(html).toMatch(/<pre class="code-highlight" id="code-highlight" aria-hidden="true"><code><\/code><\/pre>/);
    expect(html).toMatch(/<textarea id="code" spellcheck="false"/);
    expect(renderGutter).toMatch(/highlightCode\.innerHTML\s*=\s*highlightArduino\(codeEl\.value\)/);
    expect(inputHandler).toMatch(/renderGutter\(\)/);
    expect(appSource).toMatch(/codeHighlightEl\.scrollLeft\s*=\s*codeEl\.scrollLeft/);
  });

  it('deduplicates browser Pack cache operations and only exposes exact Registry matches', () => {
    const renderLibraries = sourceSection('function renderLibraryList()', 'async function cacheBrowserLibrary(key)');
    const cacheLibrary = sourceSection('async function cacheBrowserLibrary(key)', 'async function installServerLibrary(key)');

    expect(renderLibraries).toMatch(/resolveEsp32BrowserCatalogLibrary\(browserLibraryRegistry,\s*library,\s*'esp32'\)/);
    expect(renderLibraries).toMatch(/aria-busy="true"/);
    expect(renderLibraries).toMatch(/>已缓存<\/button>/);
    expect(cacheLibrary).toMatch(/browserLibraryCacheOperations\.get\(key\)/);
    expect(cacheLibrary).toMatch(/browserLibraryCacheOperations\.set\(key,\s*operation\)/);
    expect(cacheLibrary).toMatch(/browserLibraryCacheOperations\.delete\(key\)/);
  });

  it('defaults browser-only visitors to the supported UNO compiler path', () => {
    const renderBoardSelector = sourceSection(
      'function renderBoardSelector()',
      'function renderMissingBoardSelection(',
    );

    expect(appSource).toMatch(
      /const\s+BROWSER_FIRST_DEFAULT_BOARD\s*=\s*'arduino:avr:uno';/,
    );
    expect(renderBoardSelector).toMatch(
      /boards\.find\(\(board\)\s*=>\s*board\.available\s*!==\s*false\)[\s\S]*?boards\.find\(\(board\)\s*=>\s*board\.fqbn\s*===\s*BROWSER_FIRST_DEFAULT_BOARD\)/,
    );
    expect(renderBoardSelector).toMatch(/browserRoute\.reason\s*===\s*'browser_pack'[\s\S]*?浏览器 Pack 未发布/);
    expect(appSource).toMatch(
      /browserBoardRoute\(context\.board\)[\s\S]*?服务端编译 worker 也未就绪/,
    );
  });

  it('themes the board select and its native dropdown entries explicitly', () => {
    expect(pageSource).toMatch(/<select id="board"\s+aria-label="[^"]+"><\/select>/);

    const controls = [
      ['select', ['.board-picker select', '#board', 'select']],
      ['option', ['.board-picker select option', '#board option', 'select option', 'option']],
      ['optgroup', ['.board-picker select optgroup', '#board optgroup', 'select optgroup', 'optgroup']],
    ] as const;

    for (const [control, selectors] of controls) {
      const ruleBodies = selectors.flatMap((selector) =>
        cssRuleBodiesForSelector(pageSource, selector),
      );
      expect(
        hasThemeDeclarations(ruleBodies),
        `${control} must declare var(--ink) text and a themed background`,
      ).toBe(true);
    }
  });

  it('discloses that the demo page is only a view of the foundation capabilities', () => {
    const bodyMarkup = pageSource.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
    expect(bodyMarkup).toContain(
      '\u8be5\u9875\u9762\u4ec5\u5c55\u793a\u5e95\u5ea7\u80fd\u529b\uff0c\u4e0d\u4ee3\u8868\u9879\u76ee\u5168\u90e8\u529f\u80fd',
    );
  });

  it('routes download artifacts through the shared firmware artifact collector', () => {
    const renderArtifactDownloads = sourceSection(
      'function renderArtifactDownloads(result)',
      'function clearCompileOutput()',
    );

    expect(appSource).toMatch(
      /import\s*\{[\s\S]*?\bfirmwareArtifacts\b[\s\S]*?\}\s*from '\.\/editor-workflow\.js';/,
    );
    expect(renderArtifactDownloads).toMatch(
      /const\s+artifacts\s*=\s*result\?\.status\s*===\s*'success'\s*\?\s*firmwareArtifacts\(result\)\s*:\s*\[\];/,
    );
  });

  it('keeps firmware downloads in their own bounded scroll region', () => {
    const artifactSectionCss = cssRuleBodiesForSelector(pageSource, '.artifact-section').join('\n');
    const artifactListCss = cssRuleBodiesForSelector(pageSource, '.artifact-list').join('\n');

    expect(pageSource).toMatch(
      /class="[^"]*\bartifact-section\b[^"]*"\s+id="artifact-section"/,
    );
    expect(pageSource).toMatch(
      /id="artifact-downloads"\s+class="[^"]*\bartifact-list\b[^"]*"/,
    );
    expect(artifactSectionCss).toMatch(/display\s*:\s*flex/);
    expect(artifactSectionCss).toMatch(/flex-direction\s*:\s*column/);
    expect(`${artifactSectionCss}\n${artifactListCss}`).toMatch(
      /(?:min-height\s*:\s*0|max-height\s*:[^;]+)/,
    );
    expect(artifactListCss).toMatch(/min-height\s*:\s*0/);
    expect(artifactListCss).toMatch(/overflow(?:-y)?\s*:\s*auto/);
  });

  it('shows complete artifact metadata without overflowing narrow screens', () => {
    const renderArtifactDownloads = sourceSection(
      'function renderArtifactDownloads(result)',
      'function clearCompileOutput()',
    );
    const artifactRowCss = cssRuleBodiesForSelector(pageSource, '.artifact-row').join('\n');
    const artifactTextCss = cssRuleBodiesForSelector(pageSource, '.artifact-row span').join('\n');
    const artifactButtonCss = cssRuleBodiesForSelector(pageSource, '.artifact-row button').join('\n');

    expect(renderArtifactDownloads).toMatch(
      /const\s+location\s*=\s*artifact\.offset[\s\S]*?const\s+size\s*=\s*Number\.isFinite\(artifact\.size\)[\s\S]*?label\.textContent\s*=\s*`\$\{artifact\.name\}\$\{location\}\$\{size\}`/,
    );
    expect(renderArtifactDownloads).toMatch(/label\.title\s*=\s*label\.textContent/);
    expect(artifactTextCss).toMatch(/overflow-wrap\s*:\s*(?:anywhere|break-word)/);
    expect(artifactTextCss).toMatch(/white-space\s*:\s*(?:normal|pre-wrap)/);
    expect(artifactTextCss).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(artifactRowCss).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(artifactRowCss).toMatch(/width\s*:\s*100%/);
    expect(artifactRowCss).toMatch(/min-width\s*:\s*0/);
    expect(artifactButtonCss).toMatch(/white-space\s*:\s*nowrap/);
  });

  it('rechecks the result and compile context after loading artifact bytes', () => {
    const renderArtifactDownloads = sourceSection(
      'function renderArtifactDownloads(result)',
      'function clearCompileOutput()',
    );

    expect(renderArtifactDownloads).toMatch(
      /const\s+bytes\s*=\s*await\s+artifactBytes\(artifact\);[\s\S]*?if\s*\(\s*lastResult\s*!==\s*result\s*\|\|\s*!resultMatchesCurrentContext\(result\)\s*\)[\s\S]*?downloadBytes\(bytes,\s*artifact\.name\)/,
    );
  });

  it('migrates selected libraries to the exact published browser Pack version', () => {
    const loadLibraryCatalog = sourceSection(
      'async function loadLibraryCatalog(',
      'function cloudProjectId()',
    );

    expect(loadLibraryCatalog).toMatch(/libraryCatalog\s*=/);
    expect(loadLibraryCatalog).toMatch(/reconcileEsp32BrowserLibraryReferences/);
    expect(loadLibraryCatalog).toMatch(/installLibrarySelections\(migratedReferences\)/);
    expect(loadLibraryCatalog).toMatch(/persistLocalProjectState\(\)/);
    expect(appSource).not.toMatch(/setSelectedLibraryRefs\(/);
  });

  it('keeps the last valid browser Registry when a refresh fails', () => {
    const loadLibraryCatalog = sourceSection(
      'async function loadLibraryCatalog(',
      'function cloudProjectId()',
    );

    expect(loadLibraryCatalog).toMatch(
      /browserRegistryLoad\.status\s*===\s*'fulfilled'[\s\S]*?browserLibraryRegistry\s*=\s*browserRegistryLoad\.value[\s\S]*?else\s*\{\s*browserLibraryRegistryError\s*=/,
    );
    expect(loadLibraryCatalog).toMatch(
      /else\s*\{\s*browserLibraryRegistry\s*=\s*null;\s*browserLibraryRegistryError\s*=\s*null;\s*\}/,
    );
  });

  it('stores project drafts per tab and only reads localStorage as a legacy migration source', () => {
    const persistProject = sourceSection(
      'function persistLocalProjectState()',
      'function renderProjectFiles()',
    );
    const init = sourceSection('async function init()', 'function bindUiEvents()');

    expect(appSource).toMatch(
      /const\s+legacyProjectStateStorage\s*=\s*\(\(\)\s*=>[\s\S]*?globalThis\.localStorage/,
    );
    expect(appSource).toMatch(
      /const\s+projectStateStorage\s*=\s*\(\(\)\s*=>[\s\S]*?globalThis\.sessionStorage/,
    );
    expect(persistProject).toMatch(/saveProjectState\(projectStateStorage,/);
    expect(persistProject).not.toMatch(/legacyProjectStateStorage/);
    expect(init).toMatch(
      /loadProjectState\(projectStateStorage\)\s*\?\?\s*loadProjectState\(legacyProjectStateStorage,\s*\{\s*migrationStorage:\s*projectStateStorage\s*\}\)/,
    );
  });

  it.each([
    ['project file import', 'async function importProjectFiles(fileList, mode)', 'function downloadBytes('],
    ['project archive import', 'async function importProjectArchive(file)', 'function libraryKey('],
    ['cloud project restore', 'async function loadCloudProject()', 'function renderGutter()'],
  ])('guards %s with the latest restore operation', (_label, start, end) => {
    const restore = sourceSection(start, end);

    expect(restore).toMatch(
      /(?:const\s+operation\s*=|operation\s*=)\s*projectRestoreOperations\.begin\(\)/,
    );
    expect(restore).toMatch(/projectRestoreOperations\.isCurrent\(operation\)/);
    expect(restore).toMatch(/projectRestoreOperations\.finish\(operation\)/);
  });

  it('cancels a pending restore when the project id changes', () => {
    const bindUiEvents = sourceSection(
      'function bindUiEvents()',
      'function serverBoardAvailable(',
    );

    expect(bindUiEvents).toMatch(
      /projectIdEl\?\.addEventListener\(\s*'input'\s*,\s*cancelPendingProjectRestore\s*\);/,
    );
  });

  it.each([
    ['server library install', 'async function installServerLibrary(key)', 'function setLibraryImportStatus('],
    ['GitHub library import', 'async function importUnknownGitHubLibrary(event)', 'async function loadLibraryCatalog('],
  ])('guards %s with the shared project-state generation', (_label, start, end) => {
    const operation = sourceSection(start, end);

    expect(operation).toMatch(/projectRestoreOperations\.begin\(\)/);
    expect(operation).toMatch(/projectRestoreOperations\.isCurrent\(operation\)/);
    expect(operation).toMatch(/projectRestoreOperations\.finish\(operation\)/);
  });

  it('prevents a stale library import from committing catalog UI state', () => {
    const refresh = sourceSection(
      'async function refreshAndSelectImportedLibrary(',
      'async function importUnknownGitHubLibrary(',
    );
    const loadCatalog = sourceSection('async function loadLibraryCatalog(', 'function cloudProjectId()');

    expect(refresh).toMatch(/loadLibraryCatalog\(\{[\s\S]*?stillCurrent:/);
    expect(loadCatalog).toMatch(
      /sequence\s*!==\s*libraryCatalogLoadSequence\s*\|\|\s*!stillCurrent\(\)/,
    );
    expect(loadCatalog).toMatch(/return true;/);
  });

  it('stores accepted jobs through IndexedDB persistence without writing the payload to Web Storage', () => {
    const storeCompile = sourceSection('function storeCompile(run)', 'function clearStoredCompile(run)');
    expect(appSource).toMatch(
      /createActiveCompilePersistence\(\{[\s\S]*?durable:\s*createIndexedDbActiveCompileStore\(activeCompileIndexedDb,\s*activeCompileKey\)/,
    );
    expect(storeCompile).toMatch(/context:\s*compactStoredCompileContext\(run\.context\)/);
    expect(storeCompile).toMatch(/activeCompilePersistence\.put\(/);
    expect(storeCompile).not.toMatch(/(?:localStorage|sessionStorage|setItem)\b/);
  });

  it('awaits bounded durable recovery and conditionally clears records by job id', () => {
    const init = sourceSection('async function init()', 'function bindUiEvents()');
    const clearStoredCompile = sourceSection(
      'function clearStoredCompile(run)',
      'function loadStoredCompile()',
    );
    const restoreStoredCompile = sourceSection(
      'async function restoreStoredCompile(saved, operation)',
      'async function cancelRemoteCompile(run)',
    );

    expect(init).toMatch(
      /const\s+savedCompile\s*=\s*await\s+withTimeout\(\s*loadStoredCompile\(\),\s*4_000,\s*'active compile recovery',\s*\)\.catch\(/,
    );
    expect(init).toMatch(/const\s+startupRestoreOperation\s*=\s*projectRestoreOperations\.begin\(\)/);
    expect(init).toMatch(/restoreStoredCompile\(savedCompile,\s*startupRestoreOperation\)/);
    expect(clearStoredCompile).toMatch(/activeCompilePersistence\.delete\(run\.jobId,\s*run\.acceptanceId\)/);
    expect(restoreStoredCompile).toMatch(/activeCompilePersistence\.delete\(saved\.jobId,\s*saved\.acceptanceId\)/);
    expect(restoreStoredCompile).toMatch(/acceptanceId:\s*saved\.acceptanceId/);
  });

  it('waits for the persistence result and keeps its monotonic acceptance metadata', () => {
    const storeCompile = sourceSection('async function storeCompile(run)', 'async function clearStoredCompile(run)');
    expect(storeCompile).toMatch(/const\s+status\s*=\s*await\s+activeCompilePersistence\.put\(/);
    expect(storeCompile).toMatch(/run\.acceptanceEpoch\s*=\s*status\.record\.acceptanceEpoch/);
  });
});
