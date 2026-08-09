import type { ActionCache, ActionCacheEntry } from './types.js';

/** Small reference cache used by tests and short-lived executors. */
export class MemoryActionCache implements ActionCache {
  private readonly entries = new Map<string, ActionCacheEntry>();

  async get(actionKey: string): Promise<ActionCacheEntry | null> {
    const entry = this.entries.get(actionKey);
    return entry ? cloneEntry(entry) : null;
  }

  async put(entry: ActionCacheEntry): Promise<void> {
    this.entries.set(entry.actionKey, cloneEntry(entry));
  }

  clear(): void {
    this.entries.clear();
  }
}

function cloneEntry(entry: ActionCacheEntry): ActionCacheEntry {
  return {
    actionKey: entry.actionKey,
    outputs: entry.outputs.map((output) => ({
      ...output,
      bytes: new Uint8Array(output.bytes),
    })),
    ...(entry.diagnostics === undefined
      ? {}
      : { diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
  };
}
