import { z } from 'zod';

/** Canonical event keys used by Grok hook configuration. */
export const grokHookConfigEventKeys = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'SubagentEnd',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;

type GrokHookConfigEventKey = (typeof grokHookConfigEventKeys)[number];

const eventKeyAliases: Readonly<Record<string, GrokHookConfigEventKey>> = {
  SessionStart: 'SessionStart',
  session_start: 'SessionStart',
  sessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  user_prompt_submit: 'UserPromptSubmit',
  beforeSubmitPrompt: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  pre_tool_use: 'PreToolUse',
  preToolUse: 'PreToolUse',
  beforeShellExecution: 'PreToolUse',
  beforeMCPExecution: 'PreToolUse',
  beforeReadFile: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  post_tool_use: 'PostToolUse',
  postToolUse: 'PostToolUse',
  afterShellExecution: 'PostToolUse',
  afterMCPExecution: 'PostToolUse',
  afterFileEdit: 'PostToolUse',
  afterAgentResponse: 'PostToolUse',
  afterAgentThought: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  post_tool_use_failure: 'PostToolUseFailure',
  postToolUseFailure: 'PostToolUseFailure',
  PermissionDenied: 'PermissionDenied',
  permission_denied: 'PermissionDenied',
  permissionDenied: 'PermissionDenied',
  Stop: 'Stop',
  stop: 'Stop',
  StopFailure: 'StopFailure',
  stop_failure: 'StopFailure',
  stopFailure: 'StopFailure',
  Notification: 'Notification',
  notification: 'Notification',
  SubagentStart: 'SubagentStart',
  subagent_start: 'SubagentStart',
  subagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  subagent_stop: 'SubagentStop',
  subagentStop: 'SubagentStop',
  SubagentEnd: 'SubagentEnd',
  subagent_end: 'SubagentEnd',
  subagentEnd: 'SubagentEnd',
  PreCompact: 'PreCompact',
  pre_compact: 'PreCompact',
  preCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  post_compact: 'PostCompact',
  postCompact: 'PostCompact',
  SessionEnd: 'SessionEnd',
  session_end: 'SessionEnd',
  sessionEnd: 'SessionEnd',
};

/** Schema for command and HTTP handlers accepted by Grok hook settings. */
export const grokHandlerSchema = z
  .object({
    type: z.enum(['command', 'http']),
    command: z.string().optional(),
    url: z.string().optional(),
    /** Timeout in seconds. */
    timeout: z.number().int().nonnegative().optional(),
    env: z.record(z.string(), z.string()).nullable().optional(),
  })
  .superRefine((handler, context) => {
    if (handler.type === 'command' && handler.command === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: "command handler requires a 'command' field",
      });
    }
    if (handler.type === 'http' && handler.url === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: "http handler requires a 'url' field",
      });
    }
  });

/** Schema for one matcher group in Grok hook settings. */
export const grokMatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(grokHandlerSchema),
});

const rawGrokHooksConfigSchema = z.object({
  hooks: z.record(z.string(), z.unknown()),
});

type GrokMatcherGroup = z.infer<typeof grokMatcherGroupSchema>;
type NormalizedGrokHooksConfig = {
  hooks: Partial<Record<GrokHookConfigEventKey, GrokMatcherGroup[]>>;
};

function appendGroups(
  config: NormalizedGrokHooksConfig,
  eventKey: GrokHookConfigEventKey,
  groups: GrokMatcherGroup[]
): void {
  const existing = config.hooks[eventKey];
  if (existing === undefined) {
    config.hooks[eventKey] = groups;
  } else {
    existing.push(...groups);
  }
}

/**
 * Schema for a Grok JSON hook configuration.
 *
 * Recognized event aliases are normalized to PascalCase keys. Unknown event
 * keys are omitted, while malformed recognized events fail parsing.
 */
export const grokHooksConfigSchema = rawGrokHooksConfigSchema.transform(
  (raw, context): NormalizedGrokHooksConfig => {
    const config: NormalizedGrokHooksConfig = { hooks: {} };

    for (const [sourceKey, value] of Object.entries(raw.hooks)) {
      const eventKey = eventKeyAliases[sourceKey];
      if (eventKey === undefined) {
        continue;
      }

      const groups = z.array(grokMatcherGroupSchema).safeParse(value);
      if (!groups.success) {
        for (const issue of groups.error.issues) {
          context.addIssue({
            ...issue,
            path: ['hooks', sourceKey, ...issue.path],
          });
        }
        continue;
      }
      appendGroups(config, eventKey, groups.data);
    }

    return config;
  }
);

/** Handler configuration inferred from {@link grokHandlerSchema}. */
export type GrokHandler = z.infer<typeof grokHandlerSchema>;

/** Matcher-group configuration inferred from {@link grokMatcherGroupSchema}. */
export type GrokMatcherGroupConfig = z.infer<typeof grokMatcherGroupSchema>;

/** Normalized hook configuration inferred from {@link grokHooksConfigSchema}. */
export type GrokHooksConfig = z.infer<typeof grokHooksConfigSchema>;

/** Result of validating an already-parsed Grok TOML hook configuration. */
export interface GrokHooksTomlValidationResult {
  config: GrokHooksConfig;
  skipped: string[];
}

/**
 * Validates a JSON-shaped Grok hook configuration.
 *
 * Unknown event keys are skipped. A malformed recognized event throws a
 * {@link z.ZodError} and rejects the complete configuration.
 *
 * @param json - Parsed JSON value.
 * @returns A configuration with normalized event keys.
 * @throws {@link z.ZodError} If the root or a recognized event is malformed.
 */
export function validateGrokHooksConfig(json: unknown): GrokHooksConfig {
  return grokHooksConfigSchema.parse(json);
}

/**
 * Validates an already-parsed TOML-shaped Grok hook configuration.
 *
 * Parse TOML with `smol-toml` or a similar parser before calling this function.
 * Unknown and malformed event keys are skipped and named in the result. A
 * malformed root still throws because there is no usable `hooks` table.
 *
 * @param parsedToml - Object produced by a TOML parser.
 * @returns The valid events and original keys that were skipped.
 * @throws {@link z.ZodError} If the root configuration is malformed.
 */
export function validateGrokHooksToml(
  parsedToml: unknown
): GrokHooksTomlValidationResult {
  const raw = rawGrokHooksConfigSchema.parse(parsedToml);
  const config: NormalizedGrokHooksConfig = { hooks: {} };
  const skipped: string[] = [];

  for (const [sourceKey, value] of Object.entries(raw.hooks)) {
    const eventKey = eventKeyAliases[sourceKey];
    if (eventKey === undefined) {
      skipped.push(sourceKey);
      continue;
    }

    const groups = z.array(grokMatcherGroupSchema).safeParse(value);
    if (!groups.success) {
      skipped.push(sourceKey);
      continue;
    }
    appendGroups(config, eventKey, groups.data);
  }

  return { config, skipped };
}
