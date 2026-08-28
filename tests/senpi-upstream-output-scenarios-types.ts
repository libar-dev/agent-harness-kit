/** Shared scenario type + parser source fixture. */

export const PARSER_SOURCE = {
  scope: 'runtime',
  sourcePath: 'drift',
  displayOrder: 0,
  discoveredAt: 'pre-session',
} as const;

export type Scenario = {
  readonly id: string;
  readonly event: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly body?: unknown;
  readonly expectOutput: unknown;
  readonly expectDiagnostics?: readonly unknown[];
};

export type ParseHookOutputFn = (input: {
  readonly event: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly source: typeof PARSER_SOURCE;
}) => {
  readonly output: unknown;
  readonly diagnostics: unknown;
};
