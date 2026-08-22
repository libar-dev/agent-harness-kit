/**
 * Public Senpi attach API.
 *
 * Initial Wave 1-3 surface: agent-home resolution, session v3 types,
 * hooks-config validation, and the vendored hook-contract manifest.
 * This is the stable `/senpi` subpath. Hook wire schemas, the command
 * runner, output builder, and trust modules are intentionally absent
 * here and land later through the finalized barrel. Cursor and
 * checkpoint marker internals are never exported from this package.
 *
 * Do not import this surface from the kit root barrel.
 */

export {
  AGENT_DIR_ENV_NAMES,
  AGENT_HOME_SENTINEL,
  resolveSenpiAgentHome,
} from './home.js';
export type { ResolveSenpiAgentHomeOptions } from './home.js';

export type {
  SenpiAgentMessage,
  SenpiAssistantMessage,
  SenpiBashExecutionMessage,
  SenpiBranchSummaryEntry,
  SenpiBranchSummaryMessage,
  SenpiCompactionEntry,
  SenpiCompactionSummaryMessage,
  SenpiCustomEntry,
  SenpiCustomMessage,
  SenpiCustomMessageEntry,
  SenpiEntryTag,
  SenpiImageContent,
  SenpiLabelEntry,
  SenpiMessageEntry,
  SenpiModelChangeEntry,
  SenpiSessionEntry,
  SenpiSessionHeader,
  SenpiSessionInfoEntry,
  SenpiTextContent,
  SenpiThinkingContent,
  SenpiThinkingLevelChangeEntry,
  SenpiToolCall,
  SenpiToolResultMessage,
  SenpiUsage,
  SenpiUserMessage,
} from './types.js';

export {
  SENPI_HOOK_EVENT_NAMES,
  SENPI_UNSUPPORTED_HANDLER_TYPES,
  SENPI_UNSUPPORTED_HOOK_EVENT_NAMES,
  validateSenpiHooksConfig,
} from './settings.js';
export type {
  SenpiCommandHookConfig,
  SenpiExecutableHookHandler,
  SenpiHookDiagnostic,
  SenpiHookDiagnosticCode,
  SenpiHookEventName,
  SenpiHookSourceMetadata,
  SenpiHooksConfig,
} from './settings.js';

export { HOOK_DECISIONS, HOOK_INPUT_BRANCHES } from './hook-contract.js';
export type { SenpiHookWireField } from './hook-contract.js';
