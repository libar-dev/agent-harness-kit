## Processing Module Boundary

`src/processing/` is the package's session-ingest surface.

- Keep imports one-way: `src/cli/*` may depend on `src/processing/*`, but `src/processing/*` must not depend on `src/cli/*`.
- Keep processing focused on parsing, denoising, formatting, structured block extraction, and tailing.
- Prefer adding opinionated consumers outside the core package rather than expanding this module into app-specific behavior.
