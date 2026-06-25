const SECRET_KEY_SEGMENT_SOURCE = String.raw`[A-Za-z0-9]+`;
// Both the prefix and suffix repetitions are bounded ({0,12}) to prevent
// quadratic ReDoS backtracking on adversarial inputs such as
// `token_token_token...` (unbounded `*` quantifiers here were O(n^2)). Twelve
// underscore/dash-delimited segments comfortably covers real key names like
// `aws_secret_access_key` while keeping matching linear.
const SECRET_KEY_SOURCE = String.raw`(?:[A-Za-z][A-Za-z0-9]*[_-]){0,12}(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|access[_-]?key|authorization|bearer|cookie|session|credential)(?:[_-]${SECRET_KEY_SEGMENT_SOURCE}){0,12}`;

const REDACTED_PLACEHOLDER_SOURCE = String.raw`\[REDACTED:[A-Z0-9_]+\]`;

const JSON_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `("(${SECRET_KEY_SOURCE})"\\s*:\\s*")([^"\\n]*)(")`,
  'gi'
);

const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_SOURCE})\\b(\\s*[:=]\\s*)(["'])(${REDACTED_PLACEHOLDER_SOURCE}|[^"'\\n]*)(\\3)`,
  'gi'
);

const BARE_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_SOURCE})\\b(\\s*[:=]\\s*)(${REDACTED_PLACEHOLDER_SOURCE}|[^\\s"'\`,}\\]]+)`,
  'gi'
);

const AUTHORIZATION_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*)(["']?)(?:bearer\s+[^\s"'\`,}\]]+|basic\s+[^\s"'\`,}\]]+|${REDACTED_PLACEHOLDER_SOURCE}|[^\s"'\`,}\]]+)(\2)`,
  'gi'
);

const URL_CREDENTIAL_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^\/\s@]+)@/gi;

const BARE_BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g;

// Standalone token patterns. Each uses a single bounded char-class repetition
// (no nested quantifiers) so matching stays linear / non-backtracking.
// OpenAI: catches classic `sk-<32+ alnum>` and project-scoped keys
// (`sk-proj-...`), whose embedded `-` broke the old `[A-Za-z0-9]{32,}` form.
const OPENAI_API_KEY_PATTERN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g;
const GITHUB_TOKEN_PATTERN = /\bghp_[A-Za-z0-9]{36,}\b/g;
// GitHub OAuth (gho_), app/installation (ghs_), refresh (ghr_), user-to-server
// (ghu_), and personal (ghp_ — also matched above) tokens carried free-floating.
const GITHUB_OAUTH_TOKEN_PATTERN = /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g;
// GitHub fine-grained personal access tokens.
const GITHUB_FINE_GRAINED_TOKEN_PATTERN = /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g;
// GitLab personal access tokens. No trailing \b because `-` is a non-word char
// (a `\b` after the prefix `glpat-` would never assert against `[A-Za-z0-9_-]`).
const GITLAB_TOKEN_PATTERN = /\bglpat-[A-Za-z0-9_-]{20,}/g;
// Google API keys are a fixed-length `AIza` + 35 chars.
const GOOGLE_API_KEY_PATTERN = /\bAIza[A-Za-z0-9_-]{35}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const AWS_ACCESS_KEY_ID_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;

// Bare numeric / boolean literals are benign config values (e.g.
// `session_count = 42`, `cookie_consent = true`) and must not be redacted even
// when the key matches a secret keyword. Opaque string values are still redacted.
const BENIGN_LITERAL_PATTERN = /^(?:true|false|-?\d+(?:\.\d+)?)$/;

export const MAX_TOOL_RESULT_LINES = 200;

export interface PreparedToolResultText {
  readonly content: string;
  readonly truncated: boolean;
  readonly originalLineCount: number;
}

export function redactRetainedToolResultText(text: string): string {
  if (text.length === 0) return text;

  let redacted = text.replace(
    URL_CREDENTIAL_PATTERN,
    (_match: string, protocol: string) =>
      `${protocol}${buildRedactionPlaceholder('URL_CREDENTIALS')}@`
  );

  redacted = redacted.replace(
    AUTHORIZATION_ASSIGNMENT_PATTERN,
    (_match: string, prefix: string, quote: string, closingQuote: string) =>
      `${prefix}${quote}${buildRedactionPlaceholder('AUTHORIZATION')}${closingQuote}`
  );

  redacted = redacted.replace(
    JSON_SECRET_ASSIGNMENT_PATTERN,
    (
      _match: string,
      prefix: string,
      key: string,
      _value: string,
      suffix: string
    ) => `${prefix}${buildRedactionPlaceholder(key)}${suffix}`
  );

  redacted = redacted.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (
      match: string,
      key: string,
      separator: string,
      quote: string,
      value: string,
      closingQuote: string
    ) => {
      // Leave benign numeric/boolean literals untouched (e.g. `count = "42"`).
      if (BENIGN_LITERAL_PATTERN.test(value)) return match;
      return `${key}${separator}${quote}${isRedactedPlaceholder(value) ? value : buildRedactionPlaceholder(key)}${closingQuote}`;
    }
  );

  redacted = redacted.replace(
    BARE_SECRET_ASSIGNMENT_PATTERN,
    (match: string, key: string, separator: string, value: string) => {
      // Leave benign numeric/boolean literals untouched (e.g. `session_count = 42`).
      if (BENIGN_LITERAL_PATTERN.test(value)) return match;
      return `${key}${separator}${isRedactedPlaceholder(value) ? value : buildRedactionPlaceholder(key)}`;
    }
  );

  redacted = redacted.replace(
    BARE_BEARER_TOKEN_PATTERN,
    `Bearer ${buildRedactionPlaceholder('AUTHORIZATION')}`
  );
  redacted = redacted.replace(
    OPENAI_API_KEY_PATTERN,
    buildRedactionPlaceholder('OPENAI_API_KEY')
  );
  redacted = redacted.replace(
    GITHUB_TOKEN_PATTERN,
    buildRedactionPlaceholder('GITHUB_TOKEN')
  );
  redacted = redacted.replace(
    GITHUB_OAUTH_TOKEN_PATTERN,
    buildRedactionPlaceholder('GITHUB_TOKEN')
  );
  redacted = redacted.replace(
    GITHUB_FINE_GRAINED_TOKEN_PATTERN,
    buildRedactionPlaceholder('GITHUB_TOKEN')
  );
  redacted = redacted.replace(
    GITLAB_TOKEN_PATTERN,
    buildRedactionPlaceholder('GITLAB_TOKEN')
  );
  redacted = redacted.replace(
    GOOGLE_API_KEY_PATTERN,
    buildRedactionPlaceholder('GOOGLE_API_KEY')
  );
  redacted = redacted.replace(
    SLACK_TOKEN_PATTERN,
    buildRedactionPlaceholder('SLACK_TOKEN')
  );
  redacted = redacted.replace(
    AWS_ACCESS_KEY_ID_PATTERN,
    buildRedactionPlaceholder('AWS_ACCESS_KEY_ID')
  );

  return redacted;
}

export function truncateByLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, maxLines).join('\n');
  return `${head}\n\n[...${String(lines.length - maxLines)} more lines truncated...]`;
}

export function prepareToolResultForRetention(
  text: string,
  maxLines: number = MAX_TOOL_RESULT_LINES
): PreparedToolResultText {
  const originalLineCount = text.split('\n').length;
  const redacted = redactRetainedToolResultText(text);
  const truncated = originalLineCount > maxLines;

  return {
    content: truncated ? truncateByLines(redacted, maxLines) : redacted,
    truncated,
    originalLineCount,
  };
}

function buildRedactionPlaceholder(label: string): string {
  const normalized = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `[REDACTED:${normalized}]`;
}

function isRedactedPlaceholder(value: string): boolean {
  return /^\[REDACTED:[A-Z0-9_]+\]$/.test(value);
}
