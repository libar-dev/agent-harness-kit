import type { InternalSenpiSessionCheckpointState } from './checkpoint-internal-types.js';
import type { SenpiEntryParseResult } from './parse.js';
import type { ParsedLines } from './tail-parse.js';

/**
 * Merge one parsed delta with carried state unless projection must restart.
 *
 * @param delta - Parsed records and diagnostics from the current scan.
 * @param reset - Whether checkpoint invalidation restarted the cursor.
 * @param priorState - Opaque checkpoint state retained by the caller.
 * @param graphSeeds - Accepted inputs reconstructed from a marker graph.
 * @param fallbackSessionId - Session identity from a checkpoint or marker.
 * @returns Parsed state ready for projection.
 */
export function mergeParsedDelta(
  delta: ParsedLines,
  reset: boolean,
  priorState: InternalSenpiSessionCheckpointState | undefined,
  graphSeeds: readonly SenpiEntryParseResult[],
  fallbackSessionId: string | null
): ParsedLines {
  const seedless = priorState === undefined && graphSeeds.length === 0;
  const replace = reset || seedless;
  return {
    ...delta,
    inputs: replace
      ? delta.inputs
      : [...(priorState?.inputs ?? graphSeeds), ...delta.inputs],
    diagnostics: replace
      ? delta.diagnostics
      : [...(priorState?.parseDiagnostics ?? []), ...delta.diagnostics],
    sessionId: delta.sessionId ?? fallbackSessionId,
  };
}
