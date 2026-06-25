import { describe, it, expect } from 'vitest';

import { redactRetainedToolResultText } from '../src/processing/tool-result-redaction.js';

describe('redactRetainedToolResultText', () => {
  describe('ReDoS regression', () => {
    // The secret-key regex previously had two unbounded `*` quantifiers, which
    // backtracked quadratically on adversarial `token_token_token...` /
    // `session_session_...` inputs. Both are bounded ({0,12}); these inputs
    // must process in linear time.
    for (const seed of ['token_', 'session_'] as const) {
      it(`processes 20k '${seed}' repetitions quickly and still redacts a real secret`, () => {
        // A non-word separator (line break) keeps the trailing `\bghp_...` token
        // boundary intact so the genuine secret is still detected/redacted.
        const input = `${seed.repeat(20000)}\nghp_1234567890abcdefghijklmnopqrstuvABCD`;

        const startedAt = process.hrtime.bigint();
        const redacted = redactRetainedToolResultText(input);
        const elapsedMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        expect(elapsedMs).toBeLessThan(200);
        expect(redacted).toContain('[REDACTED:GITHUB_TOKEN]');
        expect(redacted).not.toContain(
          'ghp_1234567890abcdefghijklmnopqrstuvABCD'
        );
      });
    }
  });

  describe('standalone token patterns', () => {
    it('redacts free-floating GitHub OAuth/app tokens (gho_ / ghs_)', () => {
      const input =
        'gho_1234567890abcdefghijklmnopqrstuvABCD ghs_1234567890abcdefghijklmnopqrstuvABCD';

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toBe('[REDACTED:GITHUB_TOKEN] [REDACTED:GITHUB_TOKEN]');
      expect(redacted).not.toContain('gho_1234567890');
      expect(redacted).not.toContain('ghs_1234567890');
    });

    it('redacts free-floating GitHub fine-grained PATs (github_pat_)', () => {
      const token = `github_pat_${'A'.repeat(70)}`;
      const input = `before ${token} after`;

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toBe('before [REDACTED:GITHUB_TOKEN] after');
      expect(redacted).not.toContain(token);
    });

    it('redacts free-floating OpenAI project keys (sk-proj-)', () => {
      const key = 'sk-proj-AbCdEf1234567890AbCdEf1234567890XyZ';
      const input = `key=${key}`;

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toContain('[REDACTED:OPENAI_API_KEY]');
      expect(redacted).not.toContain(key);
    });

    it('redacts free-floating GitLab PATs (glpat-)', () => {
      const token = 'glpat-abcdefghijABCDEFGHIJ123';
      const input = `prefix ${token}`;

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toContain('[REDACTED:GITLAB_TOKEN]');
      expect(redacted).not.toContain(token);
    });

    it('redacts free-floating Google API keys (AIza)', () => {
      const key = `AIza${'A'.repeat(35)}`;
      const input = `google_key ${key} done`;

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toBe('google_key [REDACTED:GOOGLE_API_KEY] done');
      expect(redacted).not.toContain(key);
    });

    it('still redacts the classic free-floating token shapes', () => {
      const ghp = 'ghp_1234567890abcdefghijklmnopqrstuvABCD';
      const akia = 'AKIA1234567890ABCDEF';
      const xox = 'xoxb-REDACTED-TEST-TOKEN';
      // Classic OpenAI key: sk- followed by 32+ alphanumerics.
      const classicSk = 'sk-1234567890abcdefghijklmnopqrstuv';
      const input = [ghp, akia, xox, classicSk].join('\n');

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toContain('[REDACTED:GITHUB_TOKEN]');
      expect(redacted).toContain('[REDACTED:AWS_ACCESS_KEY_ID]');
      expect(redacted).toContain('[REDACTED:SLACK_TOKEN]');
      expect(redacted).toContain('[REDACTED:OPENAI_API_KEY]');
      for (const secret of [ghp, akia, xox, classicSk]) {
        expect(redacted).not.toContain(secret);
      }
    });
  });

  describe('benign numeric/boolean literal guard', () => {
    it('does not redact a numeric value assigned to a secret-like key', () => {
      expect(redactRetainedToolResultText('session_count = 42')).toBe(
        'session_count = 42'
      );
    });

    it('does not redact a boolean value assigned to a secret-like key', () => {
      expect(redactRetainedToolResultText('cookie_consent = true')).toBe(
        'cookie_consent = true'
      );
    });

    it('still redacts opaque string secret values', () => {
      const input = 'api_key = sk-livesecretvaluexxxxxxxxxxxxxxxxxx';

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toContain('[REDACTED');
      expect(redacted).not.toContain('sk-livesecretvalue');
    });

    it('does not redact benign numeric/boolean literals in quoted assignments', () => {
      // Unquoted key + quoted value routes through QUOTED_SECRET_ASSIGNMENT_PATTERN.
      expect(redactRetainedToolResultText('session_count = "42"')).toBe(
        'session_count = "42"'
      );
      expect(redactRetainedToolResultText('cookie_consent = "false"')).toBe(
        'cookie_consent = "false"'
      );
    });

    it('still redacts opaque quoted string secret values', () => {
      expect(
        redactRetainedToolResultText('api_key = "opaque-secret-string"')
      ).toBe('api_key = "[REDACTED:API_KEY]"');
    });
  });

  describe('idempotency', () => {
    it('is stable when re-redacting already-redacted text', () => {
      const input = [
        'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuv',
        'ghp_1234567890abcdefghijklmnopqrstuvABCD',
        'token=abc123supersecret',
        'Authorization: Bearer very-secret-bearer-token',
        'postgres://claude:secretpass@db.example.com/app',
        '{"api_key":"nested-secret-value"}',
        'session_count = 42',
        'safe output',
      ].join('\n');

      const once = redactRetainedToolResultText(input);
      const twice = redactRetainedToolResultText(once);

      expect(twice).toBe(once);
      expect(twice).not.toContain(']]');
    });
  });
});
