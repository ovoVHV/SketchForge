export function compileFallbackRoute(browserBuild, serverAvailable) {
  if (browserBuild?.handled === true) return 'browser';
  return serverAvailable ? 'server' : 'unavailable';
}

export function browserCompileUnavailableMessage(browserBuild, routeInfo) {
  if (!routeInfo?.supported && routeInfo.reason === 'browser_pack') {
    return '当前板卡已有板卡定义，但浏览器编译包尚未发布';
  }
  switch (browserBuild?.reason) {
    case 'options':
      return '当前板卡的所选处理器或编译选项尚未纳入浏览器编译包';
    case 'libraries':
      return '当前选择的库尚未纳入浏览器编译包';
    case 'headers':
      return '代码引用的头文件尚未纳入浏览器编译包';
    case 'source_size':
      return '项目内容超过浏览器编译限制';
    case 'browser':
      return '当前浏览器不具备浏览器编译所需能力';
    case 'assets':
      return '浏览器编译资产加载失败';
    case 'runtime':
      return '浏览器编译运行时启动失败';
    case 'board':
      return '当前板卡暂不支持浏览器编译';
    default:
      return '浏览器无法编译当前配置';
  }
}

export function diagnosticsForFile(diagnostics, file) {
  if (!Array.isArray(diagnostics) || typeof file !== 'string') return [];
  return diagnostics.filter((diagnostic) => diagnostic?.file === file);
}

export function firmwareArtifacts(result) {
  const entries = [
    ...(Array.isArray(result?.staticArtifacts) ? result.staticArtifacts : []),
    ...(Array.isArray(result?.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result?.downloadArtifacts) ? result.downloadArtifacts : []),
  ].filter((artifact) => artifact && typeof artifact.name === 'string' && artifact.name);
  const offset = (artifact) => {
    if (artifact.offset === undefined || artifact.offset === null || artifact.offset === '') {
      return Number.MAX_SAFE_INTEGER;
    }
    const value = Number.parseInt(String(artifact.offset), 0);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return entries.sort((left, right) => offset(left) - offset(right) || left.name.localeCompare(right.name));
}

export function unsupportedBoardOptionReason(value) {
  const reason = value?.unsupported?.reason;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return value?.unsupported ? '暂不支持' : '';
}

export function boardOptionUnavailable(value) {
  return unsupportedBoardOptionReason(value) !== '';
}

export function validateRestoredBoardConfiguration(boards, fqbn, options = {}) {
  const board = (Array.isArray(boards) ? boards : []).find((candidate) => candidate?.fqbn === fqbn);
  if (!board) return { valid: false, reason: 'board', fqbn };
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { valid: false, reason: 'options', fqbn, invalidOptions: [] };
  }

  const definitions = Array.isArray(board.options) ? board.options : [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const invalidOptions = [];
  for (const [id, requested] of Object.entries(options)) {
    const definition = byId.get(id);
    const value = definition?.values?.find((candidate) => candidate.value === requested);
    if (!definition || typeof requested !== 'string' || !value || boardOptionUnavailable(value)) {
      invalidOptions.push({ id, value: requested });
    }
  }

  const selected = Object.fromEntries(definitions.map((definition) => [
    definition.id,
    Object.hasOwn(options, definition.id) ? options[definition.id] : definition.default,
  ]));
  for (const definition of definitions) {
    const value = definition.values?.find((candidate) => candidate.value === selected[definition.id]);
    if (!value || boardOptionUnavailable(value)) {
      if (!invalidOptions.some((entry) => entry.id === definition.id)) {
        invalidOptions.push({ id: definition.id, value: selected[definition.id] });
      }
      continue;
    }
    const allowed = Object.entries(value.requires ?? {}).every(([requiredId, values]) => (
      Array.isArray(values) && values.includes(selected[requiredId])
    ));
    if (!allowed && !invalidOptions.some((entry) => entry.id === definition.id)) {
      invalidOptions.push({ id: definition.id, value: selected[definition.id] });
    }
  }

  return invalidOptions.length > 0
    ? { valid: false, reason: 'options', fqbn, invalidOptions }
    : { valid: true, board, options: Object.freeze({ ...options }) };
}

export async function withTimeout(promise, timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeout must be a positive integer');
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
