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
