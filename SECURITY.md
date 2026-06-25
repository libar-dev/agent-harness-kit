# Security Policy

## Supported Versions

This library is a pre-1.0 release candidate and published from the `main` branch. Security
fixes are applied to the latest released version. Older versions are not maintained.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Provide a description, reproduction steps, affected versions, and any potential impact.

We aim to acknowledge reports within a few business days and to provide a remediation
timeline after triage. Please give us a reasonable window to address the issue before any
public disclosure.

## Scope

This is a TypeScript library that processes Claude Code hook I/O and session transcripts.
Particularly relevant areas:

- **Untrusted transcript content** parsed by the `processing/` and tail subsystems
  (JSONL validation, secret redaction, regex safety).
- **Hook input validation** in `validation/` (Zod schemas at trust boundaries).

**Known limitation — secret redaction scope.** Redaction covers tool-**result**
bodies and error strings (Bash stdout, file contents, diffs, and the like). It
does **not** redact tool-**call inputs** — for example a Bash command such as
`export API_KEY=...`, or a URL with embedded credentials passed as a tool
argument — nor the one-line tool-call summaries derived from those inputs.
Consumers should treat tool-call inputs as potentially containing secrets and
handle them accordingly. The `--format raw-records` path is unredacted by
design and is gated behind an explicit `--unsafe-raw-unredacted` opt-in.

When reporting, noting which subsystem is involved helps us triage quickly.
