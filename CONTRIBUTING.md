# Contributing

Thank you for your interest in contributing to `@libar-dev/agent-harness-kit`.

## Getting Started

```bash
git clone https://github.com/libar-dev/agent-harness-kit.git
cd agent-harness-kit
pnpm install
```

## The Four Commands

```bash
pnpm run check          # TypeScript type-check + ESLint (run this before every commit)
pnpm run test:run       # Run all tests once (Vitest, no build needed)
pnpm run fix            # Auto-fix lint/formatting + type-check
pnpm run build          # Compile src/ → dist/ (only needed before publishing)
```

## Code Rules

**No `any` types — ever.** This is an absolute rule enforced by `noImplicitAny: true`. Use `unknown` with a validator instead:

```typescript
// Wrong
const data: any = input.tool_input;

// Right
const bashInput = validateBashToolInput(input); // returns BashToolInput
```

**Schema-first for new types.** Define the Zod schema in `src/validation/schemas.ts`, infer the TypeScript type from it, then validate at the boundary. See `src/validation/validators.ts` for the pattern.

**Standard hook module pattern:**

```typescript
import { executeHook, outputJson } from '../utils/index.js';
import { HookOutputBuilder, type PreToolUseInput } from '../types/index.js';

async function myHook(input: PreToolUseInput): Promise<void> {
  outputJson(HookOutputBuilder.permission('allow', 'Approved'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(myHook);
}
```

**ES module imports** — all intra-package imports must use `.js` extensions (even for `.ts` source files).

## Commit Style

Follow the existing convention:

```
fix: short description of the bug fixed
feat: short description of the new feature
docs: documentation changes only
chore: tooling, deps, config — no user-facing change
test: test additions or fixes only
```

Keep the subject line under 72 characters. Reference issues in the body if applicable.

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] `pnpm run check` passes with no errors or warnings
- [ ] `pnpm run test:run` passes
- [ ] New behaviour is covered by tests in `tests/`
- [ ] `CHANGELOG.md` `[Unreleased]` section updated
- [ ] If adding a new hook event: schema added to `src/validation/schemas.ts`, type in `src/types/index.ts`, validator in `src/validation/validators.ts`, and test in `tests/`

## Architecture Notes

The high-level structure and the reasoning behind it lives in [docs/README.md](docs/README.md). The maintainer API-update checklist for tracking Claude Code API changes is in [docs/internal/api-update-checklist.md](docs/internal/api-update-checklist.md).
