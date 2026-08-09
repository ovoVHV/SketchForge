export interface ActionGraphEvidence {
  readonly schema: 1;
  readonly executor: string;
  readonly target: string;
  readonly fqbn: string;
  readonly status: 'pass' | 'fail';
  readonly reportSha256: string;
  readonly buildIr: { readonly sha256: string; readonly count: number };
  readonly cacheReplay: {
    readonly fullyCached: boolean;
    readonly artifactIdentityMatch: boolean;
  };
}

export function createActionGraphEvidence(options: Record<string, unknown>): ActionGraphEvidence;
export function writeActionGraphEvidence(
  report: ActionGraphEvidence,
  options?: { directory?: string },
): Promise<string | null>;
export function executeActionGraphWithEvidence(options: Record<string, unknown>): Promise<{
  readonly firstResult: any;
  readonly replayResult: any;
  readonly evidence: ActionGraphEvidence;
  readonly evidencePath: string | null;
}>;
export function canonicalEvidenceJson(value: unknown): string;
export function evidenceSha256(value: unknown): string;
