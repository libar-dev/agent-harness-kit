import { publicTailResult } from './checkpoint-carrier.js';
import { tailSenpiSessionInternal } from './tail-run.js';
import type {
  SenpiSessionTailOptions,
  SenpiSessionTailResult,
} from './tail-types.js';

/**
 * Tail one Senpi session with the stable public option surface.
 *
 * @param file - Senpi session JSONL file.
 * @param options - Existing checkpoint, marker, and projection controls.
 * @returns One bounded projection pass and its opaque continuation checkpoint.
 */
export function tailSenpiSession(
  file: string,
  options: SenpiSessionTailOptions = {}
): Promise<SenpiSessionTailResult> {
  return tailSenpiSessionInternal(file, options).then(publicTailResult);
}

/** Public tail result, option, splice, leaf, and diagnostic contracts. */
export {
  type SenpiSessionSpliceMutation,
  type SenpiSessionTailOptions,
  type SenpiSessionTailResult,
  type SenpiTailDiagnostic,
  type SenpiTailDiagnosticCode,
  type SenpiTailLeaf,
} from './tail-types.js';
