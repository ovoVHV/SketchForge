import {
  compileAvrInBrowser,
  isAvrBrowserBoard,
} from './browser-avr.js';
import {
  compileEsp32InBrowser,
  isEsp32BrowserBoard,
} from './browser-esp32.js';

const KNOWN_BOARD_FAMILIES = Object.freeze([
  'arduino:avr:',
  'esp32:esp32:',
]);

/**
 * Cheap, side-effect-free route lookup for the editor. Actual capability
 * checks still happen inside the architecture compiler before assets load.
 */
export function browserBoardRoute(board) {
  if (isAvrBrowserBoard(board) || isEsp32BrowserBoard(board)) {
    return Object.freeze({ supported: true, execution: 'browser' });
  }
  const family = typeof board === 'string'
    ? KNOWN_BOARD_FAMILIES.find((prefix) => board.startsWith(prefix))
    : undefined;
  return Object.freeze({
    supported: false,
    execution: 'server',
    reason: family ? 'browser_pack' : 'board',
  });
}

/** Route each architecture family before loading its browser compiler assets. */
export function compileInBrowser(request, onProgress = () => {}, options = {}) {
  if (typeof request?.board === 'string' && request.board.startsWith('esp32:')) {
    return compileEsp32InBrowser(request, onProgress, options);
  }
  return compileAvrInBrowser(request, onProgress, options);
}
