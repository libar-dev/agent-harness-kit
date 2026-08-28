/** Pack-relative path of the Claude standalone hook forwarder. */
export const STANDALONE_HOOK_FORWARDER_ASSET =
  'dist/standalone/hook-forwarder.mjs';

/** Pack-relative path of the Senpi observe-only standalone hook forwarder. */
export const STANDALONE_SENPI_HOOK_FORWARDER_ASSET =
  'dist/standalone/hook-forwarder-senpi.mjs';

/** Shell wrapper installed by endpoint-discovery consumers. */
export const RUN_HOOK_WRAPPER_SH = `#!/bin/sh
# libar-cockpit managed hook wrapper (v1). Safe to delete; the app rewrites it.
command -v node >/dev/null 2>&1 || exit 0
exec node "$HOME/.claude/libar-cockpit/hook-forwarder.mjs"
`;
