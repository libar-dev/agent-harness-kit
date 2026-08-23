/**
 * Public Senpi attach API.
 *
 * Final `/senpi` surface: agent-home resolution, session v3 types,
 * hooks-config validation, vendored hook-contract manifest, hook wire
 * schemas and validators, command runner, output builder, read-only
 * trust inspection, consent-gated trust write/revoke, and observe-only
 * hooks.json register/inspect/unregister helpers. Mutating primitives
 * require an explicit options object and never run at import. This
 * barrel is now complete; later work must not add wildcard re-exports.
 * Cursor and checkpoint marker internals are never exported from this
 * package. Library capability is not Cockpit product integration;
 * Cockpit remains observe-only and must not call these writers.
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

export {
  senpiHookInputSchema,
  senpiHookOutputSchema,
  validateSenpiHookInput,
} from './hook-wire.js';
export type { SenpiHookInput, SenpiHookOutput } from './hook-wire.js';

export {
  executeSenpiHook,
  outputSenpiJson,
  readSenpiStdinJson,
} from './execute.js';
export type {
  SenpiHookRunnerOptions,
  SenpiStdinReadOptions,
} from './execute.js';

export { SenpiHookOutputBuilder } from './output-builder.js';

export {
  SENPI_HOOKS_STATE_FILENAME,
  SENPI_PROJECT_CONFIG_DIR,
  isSenpiCommandHookTrusted,
  readSenpiHookTrustState,
  resolveSenpiHookTrustStatePath,
  senpiHashCommandHook,
  senpiHookTrustId,
} from './trust.js';
export type {
  SenpiHookSourceScope,
  SenpiHookTrustEntry,
  SenpiHookTrustOptions,
  SenpiHookTrustPlatform,
  SenpiHookTrustState,
  SenpiHookTrustStateReadResult,
  SenpiHookTrustStorageScope,
  SenpiTrustCommandHookConfig,
  SenpiTrustCommandHookHandler,
  SenpiTrustHookSource,
} from './trust.js';

export {
  SenpiTrustConsentError,
  SenpiTrustLockError,
  SenpiTrustStateMalformedError,
  removeSenpiHookTrustEntry,
  writeSenpiHookTrustEntry,
} from './trust-writer.js';
export type {
  RemoveSenpiHookTrustEntryOptions,
  RemoveSenpiHookTrustEntryResult,
  WriteSenpiHookTrustEntryOptions,
  WriteSenpiHookTrustEntryResult,
  WrittenSenpiHookTrustEntry,
} from './trust-writer.js';

export {
  SENPI_HOOKS_CONFIG_FILENAME,
  SenpiHooksConsentError,
  buildSenpiHooksRegistration,
  readSenpiHooksConfig,
  removeSenpiHooksConfig,
  resolveSenpiHooksConfigPath,
  writeSenpiHooksConfig,
} from './registration.js';
export type {
  ReadSenpiHooksConfigOptions,
  RemoveSenpiHooksConfigOptions,
  RemoveSenpiHooksConfigResult,
  SenpiHooksConfigReadResult,
  SenpiHooksConfigTarget,
  SenpiHooksRegistrationDocument,
  SenpiHooksRegistrationGroup,
  SenpiHooksRegistrationHandler,
  WriteSenpiHooksConfigOptions,
  WriteSenpiHooksConfigResult,
} from './registration.js';
