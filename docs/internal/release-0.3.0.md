# Release 0.3.0

Preparation notes for `@libar-dev/agent-harness-kit@0.3.0`. This document does
not authorize publication.

## Version

Publish the exact version `0.3.0`. Do not retag a different number onto these
bytes.

## Runtime

`engines.node` is `>=22.0.0`. CI verifies Node 22 and Node 24, including a
clean-consumer job that packs the tarball and installs it with scripts enabled.
A separate engine-mismatch job installs that tarball under Node 20 and requires
the declared engine mismatch to be surfaced. Development uses Node 24 without
raising the consumer floor.

Do not advertise Node 20, browsers, Deno, or Windows.

## Public contract

Documented package subpaths:

| Subpath | Role |
| --- | --- |
| `.` | Claude types, utils, and validation |
| `./types` `./utils` `./validation` | Claude hook I/O |
| `./pre-tool-use` `./post-tool-use` `./lifecycle` | Claude reference handlers |
| `./processing` | Claude session parse, export, and raw transcript tail |
| `./grok` `./grok/processing` | Attach-only Grok Build observe/hook surface |
| `./senpi` `./senpi/processing` | Attach-only OmO-native (senpi) observe/hook surface. Mutating register/trust helpers are consent-gated library primitives, not a Cockpit integration. |
| `./endpoint-discovery` | Hook-endpoint file contract |
| `./forwarder` | Standalone forwarder asset paths and POSIX wrapper string. Not an install. |

Packed bytes must include compiled runtime (`.js`), declarations (`.d.ts`),
`LICENSE`, `README.md`, `CHANGELOG.md`, and the standalone forwarders:

- `dist/standalone/hook-forwarder.mjs`
- `dist/standalone/hook-forwarder-senpi.mjs`

Undocumented deep paths (`./processing/internal`, `./senpi/trust`, cursor
modules) must fail Node resolution with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Observe and processing boundaries

Grok and Senpi are attach/observe contracts. Callers may validate hook
envelopes, answer hook stdin, and read on-disk session files. This library does
not spawn, drive, Commit, or translate Claude hook scripts to those engines.

Claude `/processing` remains a separate session pipeline. There is no public
plugin ABI and no shared cross-harness `SessionBlock`.

This package is a library. It does not ship a Cockpit (or any other) product
integration, daemon, or UI. Cockpit is observe-only for OmO/Senpi: it must not
register hooks, grant trust, install the Senpi forwarder, or enforce a Senpi
Stop gate. Callers of mutating primitives own consent, the target directory,
and uninstall.

## Provenance (do not run until authorized)

The Release workflow is inert until an `NPM_TOKEN` repository secret exists. It
never runs on push to a branch. Publication is owner-authorized only.

When authorized, the intended path is:

1. Confirm `package.json` `version` is exactly `0.3.0`.
2. Confirm the candidate SHA and packed file list match the release evidence.
3. Push an annotated `v0.3.0` tag, or dispatch `.github/workflows/release.yml`.
4. Let GitHub Actions run `npm publish --provenance --access public` on Node 22.

Requirements already encoded in the workflow:

- `permissions.id-token: write` for npm provenance
- `permissions.contents: read`
- `NPM_TOKEN` secret (workflow exits 1 when missing)
- `publishConfig.access: public` and `publishConfig.provenance: true`

Do not publish from a laptop. Do not use `npm publish` without `--provenance`.
Do not npm-tag, git-tag, or push as part of contract preparation.
