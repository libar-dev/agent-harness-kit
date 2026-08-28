/** Stable machine-consumed code on every missing Senpi session source. */
export const SENPI_MISSING_SESSION_SOURCE_CODE = 'missing_session_source';

/**
 * Thrown when a required Senpi session JSONL file is absent.
 *
 * Watch absorbs only this typed error. Every other failure rethrows.
 */
export class SenpiMissingSessionSourceError extends Error {
  readonly code: typeof SENPI_MISSING_SESSION_SOURCE_CODE =
    SENPI_MISSING_SESSION_SOURCE_CODE;
  readonly sessionPath: string;

  /**
   * @param sessionPath - Absolute path of the missing session file.
   */
  constructor(sessionPath: string) {
    super(`Missing required Senpi session source '${sessionPath}'`);
    this.name = 'SenpiMissingSessionSourceError';
    this.sessionPath = sessionPath;
  }
}

/**
 * Throw {@link SenpiMissingSessionSourceError} for an absent session file.
 *
 * @param sessionPath - Absolute path of the missing session file.
 * @returns Never. Always throws the typed missing-source error.
 */
export function throwMissingSenpiSessionSource(sessionPath: string): never {
  throw new SenpiMissingSessionSourceError(sessionPath);
}
