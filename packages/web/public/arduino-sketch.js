function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSource(value) {
  let source = String(value);
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  return source.replace(/\r\n?/g, '\n');
}

function escapeLineFile(path) {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function composeArduinoSketchSource(files) {
  if (!Array.isArray(files) || !files.length) throw new TypeError('Arduino sketch bundle must not be empty');
  const normalized = files.map((file) => ({ path: file.path, content: normalizeSource(file.content) }));
  if (normalized.every((file) => file.content.trim().length === 0)) return '';

  let source = normalized[0].content;
  for (const file of normalized.slice(1)) {
    if (source.length > 0 && !source.endsWith('\n')) source += '\n';
    source += `#line 1 "${escapeLineFile(file.path)}"\n${file.content}`;
  }
  return source;
}

/** Validate and decode the shared CK Arduino preprocess Action convention. */
export function decodeArduinoSketchAction(action, inputMap) {
  const transform = action?.transform;
  if (!transform || transform.format !== 'other' || !Array.isArray(action.inputs)
    || !Array.isArray(action.arguments) || !Array.isArray(transform.flags)) {
    throw new TypeError(`Arduino preprocess Action ${String(action?.id)} is invalid`);
  }
  const current = action.inputs.some((input) => input?.role === 'sketch-main' || input?.role === 'sketch-tab');
  let paths;
  if (current) {
    const main = action.inputs.filter((input) => input?.role === 'sketch-main');
    const tabs = action.inputs.filter((input) => input?.role === 'sketch-tab');
    if (main.length !== 1 || main[0].path !== transform.input
      || main.length + tabs.length !== action.inputs.length
      || tabs.some((input) => input.path === transform.input || !isRootSketch(input.path))) {
      throw new TypeError(`Arduino preprocess Action ${action.id} sketch inputs are invalid`);
    }
    tabs.sort((left, right) => compareText(left.path, right.path));
    paths = [main[0].path, ...tabs.map((input) => input.path)];
  } else {
    if (action.inputs.length !== 1 || action.inputs[0]?.path !== transform.input) {
      throw new TypeError(`Arduino preprocess Action ${action.id} legacy input is invalid`);
    }
    paths = [transform.input];
  }
  if (!isRootSketch(transform.input)
    || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new TypeError(`Arduino preprocess Action ${action.id} sketch paths are invalid`);
  }
  const expectedArguments = [...paths, '-o', transform.output, ...transform.flags];
  if (expectedArguments.length !== action.arguments.length
    || expectedArguments.some((value, index) => action.arguments[index] !== value)) {
    throw new TypeError(`Arduino preprocess Action ${action.id} arguments are invalid`);
  }
  const decoder = new TextDecoder();
  const files = paths.map((path) => {
    const bytes = inputMap.get(path);
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`Arduino sketch input is missing: ${path}`);
    return { path, content: decoder.decode(bytes) };
  });
  return Object.freeze({
    sourceName: transform.input,
    paths: Object.freeze([...paths]),
    source: composeArduinoSketchSource(files),
  });
}

function isRootSketch(path) {
  return typeof path === 'string' && /^[^/\\]+\.ino$/i.test(path);
}
