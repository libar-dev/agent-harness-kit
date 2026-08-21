/**
 * Public Grok hook API.
 *
 * Grok hook output interfaces declared in `execute.ts` are intentionally not
 * re-exported here. The canonical output types come from validation and the
 * output builder, avoiding duplicate names and contracts in this barrel.
 */

import {
  GrokHookEventName as GrokHookEventNameValues,
  type GrokHookEventName as GrokHookEventNameType,
} from './types.js';

/** Grok hook event names serialized in stdin envelopes. */
export const GrokHookEventName = GrokHookEventNameValues;
export type GrokHookEventName = GrokHookEventNameType;

export type {
  GrokHookInput,
  GrokSessionStartInput,
  GrokUserPromptSubmitInput,
  GrokPreToolUseInput,
  GrokPostToolUseInput,
  GrokPostToolUseFailureInput,
  GrokPermissionDeniedInput,
  GrokStopInput,
  GrokStopFailureInput,
  GrokNotificationInput,
  GrokSubagentStartInput,
  GrokSubagentStopInput,
  GrokSubagentEndInput,
  GrokPreCompactInput,
  GrokPostCompactInput,
  GrokSessionEndInput,
} from './types.js';

export {
  grokGateOutputSchema,
  grokHookInputSchema,
  grokStopOutputSchema,
  validateGrokHookInput,
} from './validation.js';

export { GrokHookOutputBuilder } from './output-builder.js';
export type { GrokGateOutput, GrokStopOutput } from './output-builder.js';

export {
  executeGrokHook,
  outputGrokJson,
  readGrokStdinJson,
} from './execute.js';
export type { GrokHookRunnerOptions } from './execute.js';

export { validateGrokHooksConfig, validateGrokHooksToml } from './settings.js';
export type {
  GrokHandler,
  GrokHooksConfig,
  GrokHooksTomlValidationResult,
  GrokMatcherGroupConfig,
} from './settings.js';
