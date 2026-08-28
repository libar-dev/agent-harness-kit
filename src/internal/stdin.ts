/**
 * Bounded, timed stdin reader for adapter execute paths.
 *
 * Adapters own timeout message wording and timeout error classes. This
 * module owns the shared truncation policy (stop consuming at the byte
 * cap; abandon unread bytes), the timeout race, and the one-log-then-exit-1
 * timeout side effects.
 */

/** Minimal writable sink for timeout logging. */
export interface StdinTextSink {
  /** Writes one chunk of text. May return anything (or nothing). */
  readonly write: (text: string) => unknown;
}

/** Options for {@link readBoundedTimedStdin}. */
export interface ReadBoundedTimedStdinOptions {
  /** Stream to read. */
  readonly stdin: AsyncIterable<Buffer>;
  /**
   * Byte cap for the retained prefix. Reading stops as soon as accumulated
   * bytes reach this value; any remaining source bytes are abandoned unread.
   */
  readonly maxBytes: number;
  /** Milliseconds to wait before the timeout path fires. */
  readonly timeoutMs: number;
  /** Sink receiving the timeout error log. */
  readonly stderr: StdinTextSink;
  /** Exit hook invoked with 1 on timeout. */
  readonly exit: (code: number) => void;
  /**
   * Adapter-owned timeout message body (without the shared timestamp /
   * `ERROR:` prefix). Example: `Timeout waiting for Senpi hook stdin input`.
   */
  readonly timeoutMessage: string;
  /**
   * Factory for the rejection thrown after the timeout log and exit hook.
   * Adapters supply their typed timeout error class here.
   */
  readonly createTimeoutError: () => Error;
}

/**
 * Read stdin until EOF, the byte cap, or the timeout.
 *
 * Truncation policy: stop consuming as soon as {@link ReadBoundedTimedStdinOptions.maxBytes}
 * bytes have accumulated. Whatever the source still holds is abandoned unread.
 * The retained prefix is decoded as UTF-8 (a multi-byte character split at a
 * chunk boundary decodes to replacement characters).
 *
 * Timeout policy: one stderr log of the form
 * `[<ISO>] ERROR: <timeoutMessage>\n`, then `exit(1)`, then rejection with
 * {@link ReadBoundedTimedStdinOptions.createTimeoutError}. Callers that own
 * process lifetime recognize that typed error and must not log or exit again.
 *
 * @param options - Stream, caps, log sink, exit hook, and adapter-owned
 * timeout wording / error factory.
 * @returns The UTF-8 decoded retained prefix.
 * @throws The error from {@link ReadBoundedTimedStdinOptions.createTimeoutError}
 * after the timeout log and exit hook have run.
 */
export async function readBoundedTimedStdin(
  options: ReadBoundedTimedStdinOptions
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  let rejectOnTimeout: ((error: Error) => void) | undefined;
  const timeout = setTimeout(() => {
    options.stderr.write(
      `[${new Date().toISOString()}] ERROR: ${options.timeoutMessage}\n`
    );
    options.exit(1);
    rejectOnTimeout?.(options.createTimeoutError());
  }, options.timeoutMs);

  try {
    await Promise.race([
      (async () => {
        // Truncation policy: stop consuming as soon as the byte cap is
        // reached. Whatever the source still holds is abandoned unread.
        for await (const chunk of options.stdin) {
          const remaining = options.maxBytes - totalBytes;
          if (chunk.byteLength > remaining) {
            // Cap is per-byte: keep only the remaining budget from this
            // chunk, then stop consuming (abandon unread source bytes).
            chunks.push(chunk.subarray(0, remaining));
            totalBytes += remaining;
            break;
          }
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
          if (totalBytes >= options.maxBytes) {
            break;
          }
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        rejectOnTimeout = reject;
      }),
    ]);

    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    clearTimeout(timeout);
  }
}
