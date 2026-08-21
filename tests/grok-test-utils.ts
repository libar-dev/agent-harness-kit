type GrokEnvelopeBase = {
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  timestamp: string;
  transcriptPath?: string;
  clientIdentifier?: string;
  promptId?: string;
  permissionMode?: string;
};

/**
 * Creates a Grok hook envelope with stable common metadata.
 *
 * @param hookEventName - Snake-case event name placed on the wire.
 * @param payload - Event-specific fields flattened into the envelope.
 * @param overrides - Common envelope fields to replace.
 * @returns A Grok-shaped hook envelope suitable for boundary validation.
 */
export function createGrokHookEnvelope<
  TPayload extends Record<string, unknown>,
>(
  hookEventName: string,
  payload: TPayload,
  overrides: Partial<GrokEnvelopeBase> = {}
): GrokEnvelopeBase & TPayload & { hookEventName: string } {
  return {
    sessionId: 'test-session-123',
    cwd: '/tmp/test-workspace',
    workspaceRoot: '/tmp/test-workspace',
    timestamp: '2026-08-13T04:00:00Z',
    ...overrides,
    ...payload,
    hookEventName,
  };
}

function patchStreamWrite(
  stream: NodeJS.WriteStream,
  capture: (chunk: unknown) => void
): () => void {
  const originalWrite = stream.write;
  stream.write = ((chunk: unknown) => {
    capture(chunk);
    return true;
  }) as typeof stream.write;
  return () => {
    stream.write = originalWrite;
  };
}

function isCapturedRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCapturedJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCapturedRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Creates an injectable stdin stream carrying a Grok hook payload.
 *
 * String input is streamed verbatim so tests can feed malformed or truncated
 * JSON; any other value is JSON-serialized. Pass the result as
 * `GrokHookRunnerOptions.stdin`.
 *
 * @param input - Envelope object or raw string to stream.
 * @returns An async-iterable stream of one UTF-8 buffer that then ends.
 */
export function createGrokStdinMock(input: unknown): AsyncIterable<Buffer> {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf-8');
    },
  };
}

/**
 * Creates an injectable stdin stream that never yields and never closes, for
 * exercising the runner's stdin timeout with a shortened injected timeout.
 *
 * @returns An async-iterable stream whose reads never settle.
 */
export function createNeverEndingGrokStdinMock(): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Buffer>>(() => {}),
      };
    },
  };
}

/**
 * Creates a process.exit replacement that records exit codes instead of
 * ending the process. Pass `exit` as `GrokHookRunnerOptions.exit`.
 *
 * @returns The injectable exit function and the ordered list of recorded codes.
 */
export function createGrokExitRecorder(): {
  exit: (code: number) => void;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    exit: (code: number) => {
      calls.push(code);
    },
  };
}

/**
 * Captures writes to process.stdout by patching the stream's write method, so
 * code holding the imported stdout binding is observed as well.
 *
 * @returns Mock controls plus accessors for the captured text and parsed JSON.
 */
export function createGrokStdoutMock(): {
  mockStdout: () => void;
  restoreStdout: () => void;
  getOutput: () => string;
  getOutputAsJson: () => Record<string, unknown>;
} {
  let capturedOutput = '';
  let restore: () => void = () => {};

  const mockStdout = (): void => {
    capturedOutput = '';
    restore = patchStreamWrite(process.stdout, chunk => {
      capturedOutput += typeof chunk === 'string' ? chunk : String(chunk);
    });
  };

  const restoreStdout = (): void => {
    restore();
    restore = () => {};
  };

  const getOutput = (): string => capturedOutput;

  const getOutputAsJson = (): Record<string, unknown> =>
    parseCapturedJson(capturedOutput);

  return { mockStdout, restoreStdout, getOutput, getOutputAsJson };
}

/**
 * Captures writes to process.stderr by patching the stream's write method, so
 * stderr logging through imported bindings is observed as well.
 *
 * @returns Mock controls plus an accessor for the captured text.
 */
export function createGrokStderrMock(): {
  mockStderr: () => void;
  restoreStderr: () => void;
  getOutput: () => string;
} {
  let capturedOutput = '';
  let restore: () => void = () => {};

  const mockStderr = (): void => {
    capturedOutput = '';
    restore = patchStreamWrite(process.stderr, chunk => {
      capturedOutput += typeof chunk === 'string' ? chunk : String(chunk);
    });
  };

  const restoreStderr = (): void => {
    restore();
    restore = () => {};
  };

  const getOutput = (): string => capturedOutput;

  return { mockStderr, restoreStderr, getOutput };
}
