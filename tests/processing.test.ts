import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  denoiseSession,
  toMarkdown,
  toCompactSummary,
  extractBlocks,
  toJsonlBlocks,
  exportSession,
  type SessionBlock,
  type UserTextBlock,
} from '../src/processing/index.js';
import {
  parseJsonlContent,
  parseSessionContent,
} from '../src/processing/internal.js';
import { imagePlaceholder } from '../src/processing/image-placeholder.js';
import { redactRetainedToolResultText } from '../src/processing/tool-result-redaction.js';
import { must } from './test-utils.js';

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object, got ${String(parsed)}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const USER_TEXT_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: 'What files handle routing in this project?',
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:00.000Z',
  uuid: 'u-001',
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Based on my analysis, the routing is handled by `src/routes/index.ts` which uses a pattern-based router.',
      },
    ],
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 450 },
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:05.000Z',
  uuid: 'a-001',
});

const ASSISTANT_TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tu-001',
        name: 'Read',
        input: { file_path: '/project/src/routes/index.ts' },
      },
    ],
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'tool_use',
    usage: { input_tokens: 800, output_tokens: 120 },
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:02.000Z',
  uuid: 'a-002',
});

const USER_TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu-001',
        content:
          'import { Router } from "express";\nconst router = Router();\nrouter.get("/api/users", getUsers);\nrouter.post("/api/users", createUser);\nexport default router;',
      },
    ],
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:03.000Z',
  uuid: 'u-002',
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:10.000Z',
  uuid: 'r-001',
  costUSD: 0.0234,
  duration: 10000,
  result: 'Session completed',
});

const ASSISTANT_MIXED_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Let me search for the configuration files.',
      },
      {
        type: 'tool_use',
        id: 'tu-002',
        name: 'Glob',
        input: { pattern: '**/*.config.{ts,js}' },
      },
      {
        type: 'tool_use',
        id: 'tu-003',
        name: 'Grep',
        input: { pattern: 'export default', path: 'src/' },
      },
    ],
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'tool_use',
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:07.000Z',
  uuid: 'a-003',
});

const SIDECHAIN_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'This approach was rejected.' }],
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:06.000Z',
  uuid: 'a-sidechain',
  isSidechain: true,
});

const USER_ERROR_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu-004',
        content: 'Error: ENOENT: no such file or directory',
        is_error: true,
      },
    ],
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:08.000Z',
  uuid: 'u-003',
});

const THINKING_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking:
          'I need to consider the architecture carefully before making changes.',
      },
      { type: 'text', text: 'Here is my recommendation.' },
    ],
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:09.000Z',
  uuid: 'a-004',
});

const ASSISTANT_IMAGE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'raw-base64-image-data',
        },
      },
    ],
  },
  sessionId: 'test-session-001',
  timestamp: '2026-02-16T20:00:11.000Z',
  uuid: 'a-image',
});

function makeImageLine(
  role: 'user' | 'assistant',
  source: unknown,
  uuid: string
): string {
  return JSON.stringify({
    type: role,
    message: {
      role,
      content: [{ type: 'image', source }],
    },
    sessionId: 'test-session-001',
    timestamp: '2026-02-16T20:00:15.000Z',
    uuid,
  });
}

const FULL_SESSION_JSONL = [
  USER_TEXT_LINE,
  ASSISTANT_TOOL_USE_LINE,
  USER_TOOL_RESULT_LINE,
  ASSISTANT_TEXT_LINE,
  SIDECHAIN_LINE,
  ASSISTANT_MIXED_LINE,
  USER_ERROR_RESULT_LINE,
  THINKING_LINE,
  RESULT_LINE,
].join('\n');

describe('Processing Pipeline', () => {
  describe('parseJsonlContent', () => {
    it('should parse valid JSONL lines', () => {
      const lines = parseJsonlContent(FULL_SESSION_JSONL);
      expect(lines).toHaveLength(9);
    });

    it('should skip malformed lines', () => {
      const content = `${USER_TEXT_LINE}\n{broken json\n${ASSISTANT_TEXT_LINE}`;
      const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];
      const lines = parseJsonlContent(content, diagnostics);
      expect(lines).toHaveLength(2);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.kind).toBe('invalid_json');
      expect(diagnostics[0]?.lineNumber).toBe(2);
    });

    it('should handle empty content', () => {
      const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];
      const lines = parseJsonlContent('', diagnostics);
      expect(lines).toHaveLength(0);
      expect(diagnostics).toHaveLength(0);
    });

    it('parses JSONL with image blocks without invalid-shape diagnostics', () => {
      const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];
      const lines = parseJsonlContent(ASSISTANT_IMAGE_LINE, diagnostics);

      expect(lines).toHaveLength(1);
      expect(
        diagnostics.filter(diagnostic => diagnostic.kind === 'invalid_shape')
      ).toHaveLength(0);
    });

    it('should parse BOM-prefixed JSONL content', () => {
      const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];
      const lines = parseJsonlContent(`\uFEFF${USER_TEXT_LINE}`, diagnostics);

      expect(lines).toHaveLength(1);
      expect(lines[0]?.uuid).toBe('u-001');
      expect(diagnostics).toHaveLength(0);
    });

    it('should skip wrong-shape JSON lines with diagnostics', () => {
      const wrongShapeLine = JSON.stringify({
        type: 'assistant',
        sessionId: 'test-session-001',
        timestamp: '2026-02-16T20:00:05.000Z',
        uuid: 'bad-shape',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-missing-name', input: {} }],
        },
      });
      const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];
      const lines = parseJsonlContent(
        `${USER_TEXT_LINE}\n${wrongShapeLine}\n${ASSISTANT_TEXT_LINE}`,
        diagnostics
      );

      expect(lines).toHaveLength(2);
      expect(lines.map(line => line.uuid)).toEqual(['u-001', 'a-001']);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.kind).toBe('invalid_shape');
      expect(diagnostics[0]?.lineNumber).toBe(2);
      expect(diagnostics[0]?.validation?.issues.length).toBeGreaterThan(0);
    });

    it('applies default session IDs while surfacing missing typed metadata diagnostics', () => {
      const missingSessionLine = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'uses parser fallback' },
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'u-default-session',
      });
      const missingTimestampLine = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'missing timestamp' },
        sessionId: 'test-session-001',
        uuid: 'u-missing-timestamp',
      });
      const missingUuidLine = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'no uuid' }],
        },
        sessionId: 'test-session-001',
        timestamp: '2026-02-16T20:00:01.000Z',
      });
      const missingToolUseIdLine = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
        sessionId: 'test-session-001',
        timestamp: '2026-02-16T20:00:02.000Z',
        uuid: 'a-missing-tool-use-id',
      });
      const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];

      const lines = parseJsonlContent(
        [
          missingSessionLine,
          missingTimestampLine,
          missingUuidLine,
          missingToolUseIdLine,
        ].join('\n'),
        diagnostics,
        { defaultSessionId: 'fallback-session' }
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        sessionId: 'fallback-session',
        uuid: 'u-default-session',
      });
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics.map(diagnostic => diagnostic.kind)).toEqual([
        'invalid_shape',
        'invalid_shape',
        'invalid_shape',
      ]);
      const issuePaths = diagnostics.flatMap(
        diagnostic =>
          diagnostic.validation?.issues.map(issue => issue.path.join('.')) ?? []
      );
      expect(issuePaths).toContain('timestamp');
      expect(issuePaths).toContain('uuid');
      expect(issuePaths).toContain('message.content.0.id');
    });

    it('should skip blank lines', () => {
      const content = `${USER_TEXT_LINE}\n\n\n${ASSISTANT_TEXT_LINE}\n`;
      const lines = parseJsonlContent(content);
      expect(lines).toHaveLength(2);
    });
  });

  describe('denoiseSession', () => {
    it('imagePlaceholder only includes safe media_type metadata', () => {
      expect(
        imagePlaceholder({ media_type: 'image/png', data: 'secret' })
      ).toBe('[Image: image/png]');
      expect(imagePlaceholder({ media_type: 'image/png;data=secret' })).toBe(
        '[Image]'
      );
      expect(imagePlaceholder([{ media_type: 'image/png' }])).toBe('[Image]');
    });

    it('should extract user text messages', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const userMsgs = clean.messages.filter(m => m.role === 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(must(userMsgs[0]).text).toContain('routing');
    });

    it('should extract assistant text from content blocks', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const assistantMsgs = clean.messages.filter(m => m.role === 'assistant');
      const textMsg = assistantMsgs.find(m => m.text.includes('routing'));
      expect(textMsg).toBeDefined();
    });

    it('extracts image placeholders from assistant image blocks', () => {
      const clean = denoiseSession(
        parseSessionContent('test', ASSISTANT_IMAGE_LINE)
      );

      expect(clean.messages[0]?.text).toBe('[Image: image/png]');
      expect(clean.messages[0]?.text).not.toContain('raw-base64-image-data');
    });

    it('preserves mixed text and image order in denoised text', () => {
      const session = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before' },
            {
              type: 'image',
              source: { media_type: 'image/jpeg', data: 'secret-image-data' },
            },
            { type: 'text', text: 'After' },
          ],
        },
        sessionId: 'test-session-001',
        timestamp: '2026-02-16T20:00:12.000Z',
        uuid: 'a-image-mixed',
      });

      const clean = denoiseSession(parseSessionContent('test', session));

      expect(clean.messages[0]?.text).toBe(
        'Before\n\n[Image: image/jpeg]\n\nAfter'
      );
      expect(clean.messages[0]?.text).not.toContain('secret-image-data');
    });

    it('extracts generic image placeholders when source is missing', () => {
      const session = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'image' }] },
        sessionId: 'test-session-001',
        timestamp: '2026-02-16T20:00:13.000Z',
        uuid: 'u-image-missing-source',
      });

      const clean = denoiseSession(parseSessionContent('test', session));

      expect(clean.messages[0]?.text).toBe('[Image]');
    });

    it('denoiseSession image source as array', () => {
      const clean = denoiseSession(
        parseSessionContent(
          'test',
          makeImageLine(
            'assistant',
            [{ media_type: 'image/png' }],
            'a-image-array'
          )
        )
      );

      expect(clean.messages[0]?.text).toBe('[Image]');
    });

    it('denoiseSession image source as null', () => {
      const clean = denoiseSession(
        parseSessionContent(
          'test',
          makeImageLine('assistant', null, 'a-image-null')
        )
      );

      expect(clean.messages[0]?.text).toBe('[Image]');
    });

    it('denoiseSession image source as primitive', () => {
      const clean = denoiseSession(
        parseSessionContent(
          'test',
          makeImageLine('assistant', 'image/png', 'a-image-primitive')
        )
      );

      expect(clean.messages[0]?.text).toBe('[Image]');
    });

    it('should summarize tool calls', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const assistantMsgs = clean.messages.filter(m => m.role === 'assistant');
      const withTools = assistantMsgs.filter(
        m => m.toolCalls && m.toolCalls.length > 0
      );
      expect(withTools.length).toBeGreaterThanOrEqual(1);

      const readCall = withTools.find(m =>
        m.toolCalls?.some(tc => tc.includes('Read('))
      );
      expect(readCall).toBeDefined();
      const firstToolCall = must(must(readCall).toolCalls)[0];
      expect(firstToolCall).toContain('/project/src/routes/index.ts');
    });

    it('should drop tool_result content from user messages (file contents = noise)', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const allText = clean.messages.map(m => m.text).join(' ');
      expect(allText).not.toContain('Router()');
      expect(allText).not.toContain('getUsers');
    });

    it('should drop result lines (session summary)', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const allText = clean.messages.map(m => m.text).join(' ');
      expect(allText).not.toContain('Session completed');
    });

    it('should exclude sidechain messages by default', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const allText = clean.messages.map(m => m.text).join(' ');
      expect(allText).not.toContain('rejected');
    });

    it('should include sidechain messages when configured', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw, { includeSidechains: true });

      const sidechain = clean.messages.find(m => m.isSidechain);
      expect(sidechain).toBeDefined();
      expect(sidechain?.text).toContain('rejected');
    });

    it('should extract errors from tool results', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const withErrors = clean.messages.filter(
        m => m.errors && m.errors.length > 0
      );
      expect(withErrors.length).toBeGreaterThanOrEqual(1);
      expect(must(must(withErrors[0]).errors)[0]).toContain('ENOENT');
    });

    it('should exclude thinking blocks by default', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      const allText = clean.messages.map(m => m.text).join(' ');
      expect(allText).not.toContain('[thinking]');
      expect(allText).toContain('recommendation');
    });

    it('should include thinking blocks when configured', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw, { includeThinking: true });

      const allText = clean.messages.map(m => m.text).join(' ');
      expect(allText).toContain('[thinking]');
      expect(allText).toContain('architecture carefully');
    });

    it('should calculate stats correctly', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);

      expect(clean.stats.totalRawLines).toBe(9);
      expect(clean.stats.costUSD).toBeCloseTo(0.0234);
      expect(clean.stats.toolCalls).toBeGreaterThanOrEqual(3); // Read, Glob, Grep
      expect(clean.stats.errors).toBeGreaterThanOrEqual(1);
    });

    it('should summarize Bash tool calls with truncated command', () => {
      const bashLine = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-bash',
              name: 'Bash',
              input: {
                command:
                  'cd /very/long/path && pnpm run test:run 2>&1 | tail -30',
              },
            },
          ],
        },
        sessionId: 'test',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'bash-test',
      });
      const raw = parseSessionContent('test', bashLine);
      const clean = denoiseSession(raw);

      const msg = must(clean.messages[0]);
      const toolCalls = must(msg.toolCalls);
      expect(toolCalls[0]).toContain('Bash(');
      expect(toolCalls[0]).toContain('pnpm run test');
    });

    function makeToolUseLine(
      name: string,
      input: Record<string, unknown>
    ): string {
      return JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-x', name, input }],
        },
        sessionId: 'test',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'a-x',
      });
    }

    function summarize(name: string, input: Record<string, unknown>): string {
      const raw = parseSessionContent('test', makeToolUseLine(name, input));
      const clean = denoiseSession(raw);
      const msg = must(clean.messages[0]);
      return must(must(msg.toolCalls)[0]);
    }

    it('summarizes Agent with description', () => {
      expect(summarize('Agent', { description: 'Audit tool handling' })).toBe(
        'Agent(Audit tool handling)'
      );
    });

    it('summarizes Agent falling back to subagent_type', () => {
      expect(summarize('Agent', { subagent_type: 'Explore' })).toBe(
        'Agent(Explore)'
      );
    });

    it('summarizes TaskCreate with subject', () => {
      expect(
        summarize('TaskCreate', { subject: 'Fix Edit/Read regression' })
      ).toBe('TaskCreate(Fix Edit/Read regression)');
    });

    it('summarizes TaskUpdate with id and status', () => {
      expect(
        summarize('TaskUpdate', { taskId: '3', status: 'completed' })
      ).toBe('TaskUpdate(3: completed)');
    });

    it('summarizes TaskUpdate with id only', () => {
      expect(summarize('TaskUpdate', { taskId: '3' })).toBe('TaskUpdate(3)');
    });

    it('summarizes ToolSearch with query', () => {
      expect(summarize('ToolSearch', { query: 'select:Read,Edit' })).toBe(
        'ToolSearch(select:Read,Edit)'
      );
    });

    it('summarizes AskUserQuestion with first question text', () => {
      expect(
        summarize('AskUserQuestion', {
          questions: [{ question: 'Which env to deploy?' }],
        })
      ).toBe('AskUserQuestion(Which env to deploy?)');
    });

    it('summarizes Skill with skill name', () => {
      expect(summarize('Skill', { skill: 'using-superpowers' })).toBe(
        'Skill(using-superpowers)'
      );
    });

    it('summarizes ScheduleWakeup with delay and reason', () => {
      expect(
        summarize('ScheduleWakeup', {
          delaySeconds: 1200,
          reason: 'check build',
        })
      ).toBe('ScheduleWakeup(1200s: check build)');
    });

    it('summarizes ExitPlanMode with the first markdown heading', () => {
      expect(
        summarize('ExitPlanMode', {
          plan: 'Preamble\n\n## Silence hook errors\n\nDetails',
        })
      ).toBe('plan: Silence hook errors');
    });

    it('summarizes MultiEdit by file_path', () => {
      expect(
        summarize('MultiEdit', { file_path: '/repo/src/main.ts', edits: [] })
      ).toBe('MultiEdit(/repo/src/main.ts)');
    });

    it('summarizes MCP tools as mcp:server.tool with first arg', () => {
      expect(
        summarize('mcp__plugin_slack_slack__slack_send_message', {
          channel: 'C123',
          text: 'hi',
        })
      ).toBe('mcp:plugin_slack_slack.slack_send_message(channel: C123)');
    });

    it('summarizes MCP tools with hyphenated server name', () => {
      expect(
        summarize('mcp__claude-in-chrome__navigate', { url: 'https://x.test' })
      ).toBe('mcp:claude-in-chrome.navigate(url: https://x.test)');
    });

    it('falls back gracefully for unknown tools', () => {
      expect(summarize('SomeFutureTool', { thing: 'value' })).toBe(
        'SomeFutureTool(thing: value)'
      );
    });

    it('captures tool_result content with resolved tool name', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-cap',
                name: 'Bash',
                input: { command: 'echo hi' },
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-cap',
                content: 'hi\n',
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u1',
        }),
      ].join('\n');

      const raw = parseSessionContent('t', session);
      const clean = denoiseSession(raw);
      const userMsg = clean.messages.find(m => m.role === 'user');
      const results = must(userMsg?.toolResults);
      expect(results).toHaveLength(1);
      const first = must(results[0]);
      expect(first.toolName).toBe('Bash');
      expect(first.content).toBe('hi\n');
    });

    it('redacts secret-like tool_result content in denoised messages and errors', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-secret',
                name: 'Bash',
                input: { command: 'printenv' },
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-secret',
                is_error: true,
                content: [
                  {
                    type: 'text',
                    text: [
                      'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuv',
                      'ghp_1234567890abcdefghijklmnopqrstuvABCD',
                      'token=abc123supersecret',
                      'Authorization: Bearer very-secret-bearer-token',
                      'postgres://claude:secretpass@db.example.com/app',
                      '{"api_key":"nested-secret-value"}',
                      'safe output',
                    ].join('\n'),
                  },
                ],
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u1',
        }),
      ].join('\n');

      const clean = denoiseSession(parseSessionContent('t', session));
      const userMsg = clean.messages.find(m => m.role === 'user');
      const result = must(must(userMsg?.toolResults)[0]);
      const error = must(must(userMsg?.errors)[0]);

      expect(result.content).toContain(
        'OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]'
      );
      expect(result.content).toContain('[REDACTED:GITHUB_TOKEN]');
      expect(result.content).toContain('token=[REDACTED:TOKEN]');
      expect(result.content).toContain(
        'Authorization: [REDACTED:AUTHORIZATION]'
      );
      expect(result.content).toContain(
        'postgres://[REDACTED:URL_CREDENTIALS]@db.example.com/app'
      );
      expect(result.content).toContain('{"api_key":"[REDACTED:API_KEY]"}');
      expect(result.content).toContain('safe output');
      expect(result.content).not.toContain(
        'sk-1234567890abcdefghijklmnopqrstuv'
      );
      expect(result.content).not.toContain(
        'ghp_1234567890abcdefghijklmnopqrstuvABCD'
      );
      expect(result.content).not.toContain('very-secret-bearer-token');
      expect(result.content).not.toContain('secretpass@db.example.com');
      expect(error).toContain('[REDACTED:OPENAI_API_KEY]');
      expect(error).not.toContain('sk-1234567890abcdefghijklmnopqrstuv');
    });

    it('keeps Authorization placeholder formatting stable across repeated safe redaction', () => {
      const input = 'Authorization: Bearer abcdefghijklmnop';

      const once = redactRetainedToolResultText(input);
      const twice = redactRetainedToolResultText(once);

      expect(once).toBe('Authorization: [REDACTED:AUTHORIZATION]');
      expect(twice).toBe('Authorization: [REDACTED:AUTHORIZATION]');
      expect(twice).not.toContain(']]');
    });

    it('redacts suffixed secret key names without losing bare-key coverage', () => {
      const input = [
        'authorization_header=Bearer abcdefghijklmnop',
        'api_key_id=internal-key-id',
        'token=plain-token-value',
        'api_key=plain-api-key-value',
      ].join('\n');

      const redacted = redactRetainedToolResultText(input);

      expect(redacted).toContain(
        'authorization_header=[REDACTED:AUTHORIZATION_HEADER]'
      );
      expect(redacted).toContain('api_key_id=[REDACTED:API_KEY_ID]');
      expect(redacted).toContain('token=[REDACTED:TOKEN]');
      expect(redacted).toContain('api_key=[REDACTED:API_KEY]');
    });

    it('keeps pathological token separator runs bounded', () => {
      const pathologicalInput = `token_${'a_'.repeat(30)}`;
      const startedAt = process.hrtime.bigint();

      const redacted = redactRetainedToolResultText(pathologicalInput);

      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      expect(redacted).toBe(pathologicalInput);
      expect(elapsedMs).toBeLessThan(250);
    });

    it('extracts text from array-shaped tool_result content (Task/Agent SDK shape)', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-arr',
                name: 'Agent',
                input: { description: 'Survey' },
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-arr',
                content: [
                  { type: 'text', text: 'Found 3 things.' },
                  { type: 'text', text: 'Done.' },
                ],
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u1',
        }),
      ].join('\n');

      const raw = parseSessionContent('t', session);
      const clean = denoiseSession(raw);
      const userMsg = clean.messages.find(m => m.role === 'user');
      const results = must(userMsg?.toolResults);
      const first = must(results[0]);
      expect(first.toolName).toBe('Agent');
      expect(first.content).toBe('Found 3 things.\n\nDone.');
    });

    it('truncates tool_result content over 200 lines', () => {
      const longContent = Array.from(
        { length: 250 },
        (_, i) => `line ${i}`
      ).join('\n');
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-big',
                name: 'Bash',
                input: { command: 'cat big' },
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-big',
                content: longContent,
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u1',
        }),
      ].join('\n');

      const raw = parseSessionContent('t', session);
      const clean = denoiseSession(raw);
      const results = must(
        clean.messages.find(m => m.role === 'user')?.toolResults
      );
      const result = must(results[0]);
      expect(result.content).toContain('line 199');
      expect(result.content).not.toContain('line 200');
      expect(result.content).toContain('50 more lines truncated');
    });

    it('extractBlocks emits typed blocks with stable IDs', () => {
      const session = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'find routing' },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'msg-1',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Looking now.' },
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'Read',
                input: { file_path: '/p/x.ts' },
              },
            ],
          },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'msg-2',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-1',
                content: 'export const x = 1;',
              },
            ],
          },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:02.000Z',
          uuid: 'msg-3',
        }),
      ].join('\n');

      const raw = parseSessionContent('s1', session);
      const blocks = extractBlocks(raw);

      expect(blocks.map(b => b.type)).toEqual([
        'user_text',
        'assistant_text',
        'tool_use',
        'tool_result',
      ]);

      expect(must(blocks[0]).id).toBe('msg-1:0');
      expect(must(blocks[1]).id).toBe('msg-2:0');
      expect(must(blocks[2]).id).toBe('msg-2:1');
      expect(must(blocks[3]).id).toBe('msg-3:0');

      const blocks2 = extractBlocks(raw);
      expect(blocks2.map(b => b.id)).toEqual(blocks.map(b => b.id));
    });

    it('extractBlocks resolves tool_use_id → toolName on tool_result', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-bash',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'msg-a',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-bash',
                content: 'foo\nbar',
              },
            ],
          },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'msg-b',
        }),
      ].join('\n');

      const blocks = extractBlocks(parseSessionContent('s1', session));
      const result = blocks.find(b => b.type === 'tool_result');
      expect(result).toBeDefined();
      if (result?.type === 'tool_result') {
        expect(result.toolName).toBe('Bash');
        expect(result.toolUseId).toBe('tu-bash');
        expect(result.content).toBe('foo\nbar');
        expect(result.truncated).toBe(false);
      }
    });

    it('extractBlocks redacts tool_result content without changing stable ids', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-redact',
                name: 'Read',
                input: { file_path: '/repo/.env' },
              },
            ],
          },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'msg-a',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-redact',
                content: [
                  'token=plain-secret-token',
                  'xoxb-REDACTED-TEST-TOKEN',
                  'AKIA1234567890ABCDEF',
                  'safe line',
                ].join('\n'),
              },
            ],
          },
          sessionId: 's1',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'msg-b',
        }),
      ].join('\n');

      const raw = parseSessionContent('s1', session);
      const first = extractBlocks(raw);
      const second = extractBlocks(raw);
      const result = first.find(block => block.type === 'tool_result');

      expect(first.map(block => block.id)).toEqual(
        second.map(block => block.id)
      );
      expect(result).toBeDefined();
      if (result?.type === 'tool_result') {
        expect(result.id).toBe('msg-b:0');
        expect(result.content).toContain('token=[REDACTED:TOKEN]');
        expect(result.content).toContain('[REDACTED:SLACK_TOKEN]');
        expect(result.content).toContain('[REDACTED:AWS_ACCESS_KEY_ID]');
        expect(result.content).toContain('safe line');
        expect(result.content).not.toContain('plain-secret-token');
        expect(result.content).not.toContain('xoxb-REDACTED-TEST-TOKEN');
        expect(result.content).not.toContain('AKIA1234567890ABCDEF');
      }
    });

    it('extractBlocks decomposes tool_use carrying full input + summary', () => {
      const session = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-edit',
              name: 'Edit',
              input: {
                file_path: '/repo/x.ts',
                old_string: 'a',
                new_string: 'b',
              },
            },
          ],
        },
        sessionId: 's',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'msg-x',
      });

      const blocks = extractBlocks(parseSessionContent('s', session));
      const tu = blocks.find(b => b.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect(tu.toolName).toBe('Edit');
        expect(tu.summary).toBe('Edit(/repo/x.ts)');
        expect(tu.input).toEqual({
          file_path: '/repo/x.ts',
          old_string: 'a',
          new_string: 'b',
        });
      }
    });

    it('extractBlocks renders MCP tool names in summary', () => {
      const session = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-mcp',
              name: 'mcp__claude-in-chrome__navigate',
              input: { url: 'https://x.test' },
            },
          ],
        },
        sessionId: 's',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'msg-m',
      });
      const blocks = extractBlocks(parseSessionContent('s', session));
      const tu = blocks.find(b => b.type === 'tool_use');
      if (tu?.type === 'tool_use') {
        expect(tu.summary).toBe(
          'mcp:claude-in-chrome.navigate(url: https://x.test)'
        );
        expect(tu.toolName).toBe('mcp__claude-in-chrome__navigate');
      }
    });

    it('extractBlocks marks truncated tool_result with originalLineCount', () => {
      const big = Array.from({ length: 250 }, (_, i) => `L${String(i)}`).join(
        '\n'
      );
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu',
                name: 'Bash',
                input: { command: 'x' },
              },
            ],
          },
          sessionId: 's',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu', content: big }],
          },
          sessionId: 's',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u',
        }),
      ].join('\n');

      const blocks = extractBlocks(parseSessionContent('s', session));
      const result = blocks.find(b => b.type === 'tool_result');
      if (result?.type === 'tool_result') {
        expect(result.truncated).toBe(true);
        expect(result.originalLineCount).toBe(250);
        expect(result.content).toContain('50 more lines truncated');
      }
    });

    it('extractBlocks can omit tool_result blocks for structured exports', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-hide',
                name: 'Read',
                input: { file_path: '/repo/.env' },
              },
            ],
          },
          sessionId: 's',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-hide',
                content: 'API_KEY=secret',
              },
            ],
          },
          sessionId: 's',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u1',
        }),
      ].join('\n');

      const blocks = extractBlocks(parseSessionContent('s', session), {
        includeToolResults: false,
      });

      expect(blocks.map(block => block.type)).toEqual(['tool_use']);
    });

    it('extractBlocks filters system-reminder noise from text blocks', () => {
      const session = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<system-reminder>internal</system-reminder>',
        },
        sessionId: 's',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'msg-1',
      });
      const blocks = extractBlocks(parseSessionContent('s', session));
      expect(blocks).toHaveLength(0);
    });

    it('extractBlocks emits image placeholders as text blocks', () => {
      const blocks = extractBlocks(
        parseSessionContent('test-session-001', ASSISTANT_IMAGE_LINE)
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        id: 'a-image:0',
        type: 'assistant_text',
        content: '[Image: image/png]',
      });
      expect(JSON.stringify(blocks)).not.toContain('raw-base64-image-data');
    });

    it('extractBlocks emits one placeholder per image block', () => {
      const session = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { media_type: 'image/png', data: 'one' } },
            {
              type: 'image',
              source: { media_type: 'image/webp', data: 'two' },
            },
          ],
        },
        sessionId: 'test-session-001',
        timestamp: '2026-02-16T20:00:14.000Z',
        uuid: 'u-image-multiple',
      });

      const blocks = extractBlocks(parseSessionContent('test', session));

      const imageBlocks = blocks.filter(
        (block): block is UserTextBlock => block.type === 'user_text'
      );

      expect(blocks.map(block => block.type)).toEqual([
        'user_text',
        'user_text',
      ]);
      expect(imageBlocks.map(block => block.content)).toEqual([
        '[Image: image/png]',
        '[Image: image/webp]',
      ]);
      expect(JSON.stringify(blocks)).not.toContain('one');
      expect(JSON.stringify(blocks)).not.toContain('two');
    });

    it('extractBlocks image source as array', () => {
      const blocks = extractBlocks(
        parseSessionContent(
          'test',
          makeImageLine('user', [{ media_type: 'image/png' }], 'u-image-array')
        )
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        id: 'u-image-array:0',
        type: 'user_text',
        content: '[Image]',
      });
    });

    it('extractBlocks image source as null', () => {
      const blocks = extractBlocks(
        parseSessionContent('test', makeImageLine('user', null, 'u-image-null'))
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        id: 'u-image-null:0',
        type: 'user_text',
        content: '[Image]',
      });
    });

    it('extractBlocks image source as primitive', () => {
      const blocks = extractBlocks(
        parseSessionContent(
          'test',
          makeImageLine('user', 42, 'u-image-primitive')
        )
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        id: 'u-image-primitive:0',
        type: 'user_text',
        content: '[Image]',
      });
    });

    it('extractBlocks emits agent_boundary blocks bracketing subagents', () => {
      const main = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        sessionId: 's',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'main-1',
      });
      const subLine = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'sub work' }],
        },
        sessionId: 's',
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'sub-1',
        isSidechain: true,
      });
      const raw = parseSessionContent('s', main, [
        { filename: 'agent-abc123', content: subLine },
      ]);
      const blocks = extractBlocks(raw);
      const boundaries = blocks.filter(b => b.type === 'agent_boundary');
      expect(boundaries).toHaveLength(2);
      const enter = must(boundaries[0]);
      const exit = must(boundaries[1]);
      if (enter.type === 'agent_boundary') {
        expect(enter.direction).toBe('enter');
        expect(enter.agentFile).toBe('agent-abc123');
      }
      if (exit.type === 'agent_boundary') {
        expect(exit.direction).toBe('exit');
      }
    });

    it('extractBlocks namespaces agent_boundary ids by session', () => {
      const subLine = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'sub work' }],
        },
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'sub-1',
        isSidechain: true,
      });

      const first = extractBlocks(
        parseSessionContent('session-a', '', [
          { filename: 'agent-shared', content: subLine },
        ])
      );
      const second = extractBlocks(
        parseSessionContent('session-b', '', [
          { filename: 'agent-shared', content: subLine },
        ])
      );

      const firstBoundary = first.find(b => b.type === 'agent_boundary');
      const secondBoundary = second.find(b => b.type === 'agent_boundary');

      expect(firstBoundary).toBeDefined();
      expect(secondBoundary).toBeDefined();
      expect(firstBoundary?.id).toBe('session-a:agent-enter:agent-shared');
      expect(secondBoundary?.id).toBe('session-b:agent-enter:agent-shared');
      expect(firstBoundary?.id).not.toBe(secondBoundary?.id);
    });

    it('extractBlocks attaches subagentId to subagent blocks', () => {
      const subLine = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'sub' }],
        },
        sessionId: 's',
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'sub-1',
        isSidechain: true,
      });
      const raw = parseSessionContent('s', '', [
        { filename: 'agent-foo', content: subLine },
      ]);
      const blocks = extractBlocks(raw);
      const textBlock = blocks.find(b => b.type === 'assistant_text');
      expect(textBlock).toBeDefined();
      expect(textBlock?.subagentId).toBe('agent-foo');
    });

    it('extractBlocks includes session_header when parsed session passed', () => {
      const main = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        sessionId: 'sess-123',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'msg-1',
      });
      const raw = parseSessionContent('sess-123', main);
      const parsed = denoiseSession(raw);
      const blocks = extractBlocks(raw, { parsed, projectDir: '/p' });
      const first = must(blocks[0]);
      expect(first.type).toBe('session_header');
      if (first.type === 'session_header') {
        expect(first.sessionId).toBe('sess-123');
        expect(first.projectDir).toBe('/p');
        expect(first.userMessages).toBe(1);
      }
    });

    it('extractBlocks keeps session_header timestamps from raw session bounds', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-header',
                name: 'Read',
                input: { file_path: '/repo/.env' },
              },
            ],
          },
          sessionId: 'sess-header',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a-1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-header',
                content: 'API_KEY=secret',
              },
            ],
          },
          sessionId: 'sess-header',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u-1',
        }),
      ].join('\n');

      const raw = parseSessionContent('sess-header', session);
      const parsed = denoiseSession(raw, { includeToolResults: false });
      const blocks = extractBlocks(raw, { parsed });
      const header = blocks.find(b => b.type === 'session_header');

      expect(header).toBeDefined();
      if (header?.type === 'session_header') {
        expect(header.startTime).toBe('2026-02-16T20:00:00.000Z');
        expect(header.endTime).toBe('2026-02-16T20:00:01.000Z');
      }
    });

    it('toJsonlBlocks emits one JSON record per line with trailing newline', () => {
      const blocks: SessionBlock[] = [
        {
          id: 'a:0',
          type: 'user_text',
          sessionId: 's',
          timestamp: '2026-02-16T20:00:00.000Z',
          messageUuid: 'a',
          content: 'hi',
        },
        {
          id: 'b:0',
          type: 'assistant_text',
          sessionId: 's',
          timestamp: '2026-02-16T20:00:01.000Z',
          messageUuid: 'b',
          content: 'hello',
        },
      ];
      const jsonl = toJsonlBlocks(blocks);
      const lines = jsonl.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe('');
      const parsed = parseJsonObject(must(lines[0]));
      expect(parsed['id']).toBe('a:0');
    });

    it('toJsonlBlocks returns an empty string for no blocks', () => {
      expect(toJsonlBlocks([])).toBe('');
    });

    it('drops tool_results when includeToolResults is false', () => {
      const session = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-x',
                name: 'Bash',
                input: { command: 'x' },
              },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:00.000Z',
          uuid: 'a1',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu-x', content: 'output' },
            ],
          },
          sessionId: 't',
          timestamp: '2026-02-16T20:00:01.000Z',
          uuid: 'u1',
        }),
      ].join('\n');

      const raw = parseSessionContent('t', session);
      const clean = denoiseSession(raw, { includeToolResults: false });
      const userMsg = clean.messages.find(m => m.role === 'user');
      expect(userMsg).toBeUndefined();
    });
  });

  describe('toMarkdown', () => {
    it('should produce valid markdown with frontmatter', () => {
      const raw = parseSessionContent('test-session-001', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);
      const md = toMarkdown(clean);

      expect(md).toContain('---');
      expect(md).toContain('session: test-session-001');
      expect(md).toContain('# Session test-ses');
      expect(md).toContain('### User');
      expect(md).toContain('### Assistant');
    });

    it('should include tool annotations', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);
      const md = toMarkdown(clean);

      expect(md).toContain('*Tools:*');
      expect(md).toContain('Read(');
    });

    it('should include error annotations', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);
      const md = toMarkdown(clean);

      expect(md).toContain('*Errors:*');
      expect(md).toContain('ENOENT');
    });

    it('should not include tool annotations when disabled', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);
      const md = toMarkdown(clean, { includeToolAnnotations: false });

      expect(md).not.toContain('*Tools:*');
    });

    it('includes image placeholders without raw image data', () => {
      const raw = parseSessionContent('test', ASSISTANT_IMAGE_LINE);
      const clean = denoiseSession(raw);
      const md = toMarkdown(clean);

      expect(md).toContain('[Image: image/png]');
      expect(md).not.toContain('raw-base64-image-data');
      expect(md).not.toContain('data:image');
    });

    it('renders image-only messages with an image placeholder', () => {
      const raw = parseSessionContent('test', ASSISTANT_IMAGE_LINE);
      const md = toMarkdown(denoiseSession(raw));

      expect(md).toContain('[Image: image/png]');
    });
  });

  describe('toCompactSummary', () => {
    it('should produce a shorter output', () => {
      const raw = parseSessionContent('test', FULL_SESSION_JSONL);
      const clean = denoiseSession(raw);
      const full = toMarkdown(clean);
      const compact = toCompactSummary(clean);

      expect(compact.length).toBeLessThan(full.length);
      expect(compact).toContain('Session test');
      expect(compact).toContain('exchanges');
    });
  });

  describe('parseSessionContent with subagents', () => {
    it('should include subagent messages', () => {
      const subagentContent = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Explore the test directory' },
          sessionId: 'sub-001',
          timestamp: '2026-02-16T20:01:00.000Z',
          uuid: 'sub-u-001',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Found 12 test files with vitest configuration.',
              },
            ],
          },
          sessionId: 'sub-001',
          timestamp: '2026-02-16T20:01:05.000Z',
          uuid: 'sub-a-001',
        }),
      ].join('\n');

      const raw = parseSessionContent('test', FULL_SESSION_JSONL, [
        { filename: 'agent-explore', content: subagentContent },
      ]);
      const clean = denoiseSession(raw);

      expect(clean.subagentSessions).toHaveLength(1);
      const sub = must(clean.subagentSessions[0]);
      expect(sub.agentFile).toBe('agent-explore');
      expect(sub.messages).toHaveLength(2);
      expect(must(sub.messages[1]).text).toContain('12 test files');
    });

    it('should mark subagent messages with agent name', () => {
      const subContent = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Subagent result' }],
        },
        sessionId: 'sub',
        timestamp: '2026-02-16T20:01:00.000Z',
        uuid: 'sub-1',
      });

      const raw = parseSessionContent('test', USER_TEXT_LINE, [
        { filename: 'agent-research', content: subContent },
      ]);
      const clean = denoiseSession(raw);

      const subMsg = must(must(clean.subagentSessions[0]).messages[0]);
      expect(subMsg.subagent).toBe('agent-research');
    });

    it('should exclude subagents when configured', () => {
      const subContent = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Should not appear' }],
        },
        sessionId: 'sub',
        timestamp: '2026-02-16T20:01:00.000Z',
        uuid: 'sub-1',
      });

      const raw = parseSessionContent('test', USER_TEXT_LINE, [
        { filename: 'agent-hidden', content: subContent },
      ]);
      const clean = denoiseSession(raw, { includeSubagents: false });

      expect(clean.subagentSessions).toHaveLength(0);
    });
  });

  describe('markdown with subagents', () => {
    it('should render subagent sections', () => {
      const subContent = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Research findings here.' }],
          },
          sessionId: 'sub',
          timestamp: '2026-02-16T20:01:00.000Z',
          uuid: 'sub-1',
        }),
      ].join('\n');

      const raw = parseSessionContent('test', FULL_SESSION_JSONL, [
        { filename: 'agent-research', content: subContent },
      ]);
      const clean = denoiseSession(raw);
      const md = toMarkdown(clean);

      expect(md).toContain('## Subagent: agent-research');
      expect(md).toContain('Research findings');
    });
  });

  describe('exportSession', () => {
    it('keeps public markdown exports free of raw tool_result content by default', async () => {
      const projectDir = await mkdtemp(join(tmpdir(), 'processing-export-'));
      const sessionId = '33333333-3333-3333-3333-333333333333';

      try {
        await writeFile(
          join(projectDir, `${sessionId}.jsonl`),
          `${JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-export-helper',
                  name: 'Read',
                  input: { file_path: '/repo/.env' },
                },
              ],
            },
            sessionId,
            timestamp: '2026-02-16T20:00:00.000Z',
            uuid: 'a-1',
          })}\n${JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-export-helper',
                  content: 'API_KEY=secret',
                },
              ],
            },
            sessionId,
            timestamp: '2026-02-16T20:00:01.000Z',
            uuid: 'u-1',
          })}\n`
        );

        const markdown = await exportSession(projectDir, sessionId);

        expect(markdown).toContain('### Tool: Read(/repo/.env)');
        expect(markdown).not.toContain('### Read Result');
        expect(markdown).not.toContain('API_KEY=secret');
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });
});
