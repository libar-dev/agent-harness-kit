import type { z } from 'zod';
import type {
  grokHookInputSchema,
  grokNotificationInputSchema,
  grokPermissionDeniedInputSchema,
  grokPostCompactInputSchema,
  grokPostToolUseFailureInputSchema,
  grokPostToolUseInputSchema,
  grokPreCompactInputSchema,
  grokPreToolUseInputSchema,
  grokSessionEndInputSchema,
  grokSessionStartInputSchema,
  grokStopFailureInputSchema,
  grokStopInputSchema,
  grokSubagentEndInputSchema,
  grokSubagentStartInputSchema,
  grokSubagentStopInputSchema,
  grokUserPromptSubmitInputSchema,
} from './validation.js';

/** Grok hook event names serialized in stdin envelopes. */
export const GrokHookEventName = [
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'permission_denied',
  'stop',
  'stop_failure',
  'notification',
  'subagent_start',
  'subagent_stop',
  'subagent_end',
  'pre_compact',
  'post_compact',
  'session_end',
] as const;

/** A Grok hook event name serialized in a stdin envelope. */
export type GrokHookEventName = (typeof GrokHookEventName)[number];

/** Validated Grok session_start hook input. */
export type GrokSessionStartInput = z.infer<typeof grokSessionStartInputSchema>;

/** Validated Grok user_prompt_submit hook input. */
export type GrokUserPromptSubmitInput = z.infer<
  typeof grokUserPromptSubmitInputSchema
>;

/** Validated Grok pre_tool_use hook input. */
export type GrokPreToolUseInput = z.infer<typeof grokPreToolUseInputSchema>;

/** Validated Grok post_tool_use hook input. */
export type GrokPostToolUseInput = z.infer<typeof grokPostToolUseInputSchema>;

/** Validated Grok post_tool_use_failure hook input. */
export type GrokPostToolUseFailureInput = z.infer<
  typeof grokPostToolUseFailureInputSchema
>;

/** Validated Grok permission_denied hook input. */
export type GrokPermissionDeniedInput = z.infer<
  typeof grokPermissionDeniedInputSchema
>;

/** Validated Grok stop hook input. */
export type GrokStopInput = z.infer<typeof grokStopInputSchema>;

/** Validated Grok stop_failure hook input. */
export type GrokStopFailureInput = z.infer<typeof grokStopFailureInputSchema>;

/** Validated Grok notification hook input. */
export type GrokNotificationInput = z.infer<typeof grokNotificationInputSchema>;

/** Validated Grok subagent_start hook input. */
export type GrokSubagentStartInput = z.infer<
  typeof grokSubagentStartInputSchema
>;

/** Validated Grok subagent_stop hook input. */
export type GrokSubagentStopInput = z.infer<typeof grokSubagentStopInputSchema>;

/** Validated Grok subagent_end compatibility hook input. */
export type GrokSubagentEndInput = z.infer<typeof grokSubagentEndInputSchema>;

/** Validated Grok pre_compact hook input. */
export type GrokPreCompactInput = z.infer<typeof grokPreCompactInputSchema>;

/** Validated Grok post_compact hook input. */
export type GrokPostCompactInput = z.infer<typeof grokPostCompactInputSchema>;

/** Validated Grok session_end hook input. */
export type GrokSessionEndInput = z.infer<typeof grokSessionEndInputSchema>;

/** Validated input for any Grok hook event. */
export type GrokHookInput = z.infer<typeof grokHookInputSchema>;
