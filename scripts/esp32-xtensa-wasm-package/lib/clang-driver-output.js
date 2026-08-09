const HEADER_PATTERNS = Object.freeze([
  /^(?:.* )?clang version /,
  /^Target:/,
  /^Thread model:/,
  /^InstalledDir:/,
  /^Build config:/,
]);
const DRIVER_DIAGNOSTIC = /^(?:[^:\s]+: )?(?:warning|note|remark): /;

function unquoteClangArgs(line) {
  return Array.from(
    line.matchAll(/ (?:([^ "\n]+)|"((?:[^"\\$]|\\["\\$])*)")/g),
    (match) => {
      if (match[1] !== undefined) return match[1];
      return match[2].replaceAll(/\\["$\\]/g, (escaped) => escaped[1]);
    },
  );
}

export function parseClangDriverOutput(output) {
  const commands = [];
  const diagnostics = [];
  let ended = false;
  let invalidLine = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (commands.length > 0) ended = true;
      continue;
    }
    if (ended) {
      invalidLine = line;
      break;
    }
    if (commands.length === 0 && HEADER_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    if (DRIVER_DIAGNOSTIC.test(line)) {
      diagnostics.push(line);
      continue;
    }
    if (line === ' (in-process)') continue;
    if (line.startsWith(' "')) {
      const command = unquoteClangArgs(line);
      if (command.length > 0) {
        commands.push(command);
        continue;
      }
    }
    invalidLine = line;
    break;
  }

  return Object.freeze({
    valid: invalidLine === null && ended && commands.length > 0,
    commands: Object.freeze(commands.map((command) => Object.freeze(command))),
    diagnostics: diagnostics.length > 0 ? diagnostics.join('\n') + '\n' : '',
    invalidLine,
  });
}
