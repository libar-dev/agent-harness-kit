# ADR 0001: @noble/hashes for grok BLAKE3 parity

Status: accepted.

## Context

`package.json` `dependencies` lists `@noble/hashes` at `^2.3.0` beside `zod`. The kit otherwise refuses new runtime dependencies.

Grok session discovery must land long working-directory names in the same filesystem slots as grok-build. `encodeGrokCwdDirname` in `src/grok/processing/discovery.ts` URL-encodes `cwd`. Encoded names that exceed 255 bytes become `<slug-of-basename>-<first 16 hex characters of BLAKE3(cwd)>`. That digest has to match upstream `encode_cwd_dirname`. SHA-256 does not.

`docs/upstream/grok/pin.json` notes record the choice and defer this write-up:

> The blake3 implementation decision for session discovery (@noble/hashes) is recorded separately during execution.

> Session discovery (src/grok/processing/discovery.ts) uses @noble/hashes for BLAKE3 (audited, ESM, zero runtime dependencies) so >255-byte CWD directory names exactly match upstream encode_cwd_dirname; SHA-256 is not compatible.

## Decision

Keep `@noble/hashes` as a runtime dependency. `encodeGrokCwdDirname` imports `blake3` from `@noble/hashes/blake3.js` and takes the first 16 hex characters of `blake3(cwd)`. This file is the documented exception to the no-new-runtime-dependencies culture. BLAKE3 is not replaced with SHA-256 or another digest.

## Consequences

Long-CWD session directories stay locatable against grok-build. Other runtime packages still need their own decision record. The pin.json notes above are fulfilled by this file.
