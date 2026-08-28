import { createHash } from "node:crypto";
import { DEFAULT_HOOK_TIMEOUT_SECONDS, isValidHookTimeoutSeconds } from "./safety.js";
const HOOK_STATE_VERSION = 1;
export function emptyHookTrustState() {
    return { version: HOOK_STATE_VERSION, hooks: {} };
}
export function hookTrustId(handler) {
    return `hk_${sourceKeyHash(handler.source)}_${handler.event}_${handler.groupIndex}_${handler.handlerIndex}`;
}
export function buildHookTrustRecord(handler, options = {}) {
    const id = hookTrustId(handler);
    const currentHash = hashCommandHook(handler, options);
    const commandPreview = selectedCommand(handler, options.platform ?? process.platform);
    return {
        id,
        currentHash,
        enabled: true,
        trusted: false,
        executable: false,
        scope: handler.source.scope,
        sourcePath: handler.source.sourcePath,
        ...(handler.matcher === undefined ? {} : { matcher: handler.matcher }),
        commandPreview,
    };
}
export function createHookTrustEntry(handler, options = {}) {
    const commandPreview = selectedCommand(handler, options.platform ?? process.platform);
    return {
        enabled: true,
        trustedHash: hashCommandHook(handler, options),
        scope: handler.source.scope,
        sourcePath: handler.source.sourcePath,
        ...(handler.matcher === undefined ? {} : { matcher: handler.matcher }),
        commandPreview,
        updatedAt: options.updatedAt ?? new Date().toISOString(),
    };
}
export function hashCommandHook(handler, options = {}) {
    const platform = options.platform ?? process.platform;
    const hook = {
        async: false,
        command: handler.config.command,
        commandWindows: handler.config.commandWindows,
        platformCommand: selectedCommand(handler, platform),
        statusMessage: handler.config.statusMessage,
        timeout: normalizedTimeout(handler.config.timeout),
        type: "command",
    };
    const identity = {
        event: handler.event,
        hook,
        matcher: handler.matcher,
        sourceKeyHash: sourceKeyHash(handler.source),
    };
    return `sha256:${sha256Hex(JSON.stringify(canonicalJson(identity)))}`;
}
export function isCommandHookTrusted(handler, state, options = {}) {
    const record = buildStatefulHookTrustRecord(handler, state, options);
    return record.executable;
}
export function listHookTrustRecords(handlers, state, options = {}) {
    return handlers.map((handler) => buildStatefulHookTrustRecord(handler, state, options));
}
export function filterExecutableTrustedHooks(handlers, state, options = {}) {
    return handlers.filter((handler) => buildStatefulHookTrustRecord(handler, state, options).executable);
}
export function readHookTrustStateJson(input) {
    if (input === undefined || input.trim() === "") {
        return emptyHookTrustState();
    }
    try {
        return parseHookTrustState(JSON.parse(input));
    }
    catch (error) {
        if (error instanceof Error) {
            return emptyHookTrustState();
        }
        return emptyHookTrustState();
    }
}
export function hookTrustStorageScope(handler, options) {
    if (handler.source.scope === "project") {
        return options.projectTrusted ? "project" : undefined;
    }
    return "global";
}
function buildStatefulHookTrustRecord(handler, state, options) {
    const base = buildHookTrustRecord(handler, options);
    const entry = state.hooks[base.id];
    const enabled = entry?.enabled ?? true;
    const trusted = entry?.trustedHash === base.currentHash;
    return {
        ...base,
        enabled,
        trusted,
        executable: enabled && trusted,
        ...(entry === undefined ? {} : { entry }),
    };
}
function parseHookTrustState(input) {
    if (!isRecord(input) || input.version !== HOOK_STATE_VERSION || !isRecord(input.hooks)) {
        return emptyHookTrustState();
    }
    const hooks = {};
    for (const [id, entry] of Object.entries(input.hooks)) {
        const parsed = parseHookTrustEntry(entry);
        if (parsed !== undefined) {
            hooks[id] = parsed;
        }
    }
    return { version: HOOK_STATE_VERSION, hooks };
}
function parseHookTrustEntry(input) {
    if (!isRecord(input)) {
        return undefined;
    }
    const enabled = input.enabled;
    const trustedHash = input.trustedHash;
    const scope = input.scope;
    const sourcePath = input.sourcePath;
    const matcher = input.matcher;
    const commandPreview = input.commandPreview;
    const updatedAt = input.updatedAt;
    if (typeof enabled !== "boolean" ||
        (trustedHash !== undefined && typeof trustedHash !== "string") ||
        !isHookSourceScope(scope) ||
        typeof sourcePath !== "string" ||
        (matcher !== undefined && typeof matcher !== "string") ||
        typeof commandPreview !== "string" ||
        typeof updatedAt !== "string") {
        return undefined;
    }
    return {
        enabled,
        ...(trustedHash === undefined ? {} : { trustedHash }),
        scope,
        sourcePath,
        ...(matcher === undefined ? {} : { matcher }),
        commandPreview,
        updatedAt,
    };
}
function selectedCommand(handler, platform) {
    if (platform === "win32" && handler.config.commandWindows !== undefined) {
        return handler.config.commandWindows;
    }
    return handler.config.command;
}
function normalizedTimeout(timeout) {
    if (timeout === undefined) {
        return DEFAULT_HOOK_TIMEOUT_SECONDS;
    }
    if (!isValidHookTimeoutSeconds(timeout)) {
        throw new Error("Invalid command hook timeout reached trust hashing.");
    }
    return timeout;
}
function sourceKeyHash(source) {
    return sha256Hex([source.scope, source.sourcePath, source.pluginRoot ?? "", source.manifestPath ?? ""].join("\0")).slice(0, 12);
}
function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalJson);
    }
    if (!isJsonRecord(value)) {
        return value;
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        const child = value[key];
        if (child !== undefined) {
            result[key] = canonicalJson(child);
        }
    }
    return result;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isHookSourceScope(value) {
    return (value === "global" ||
        value === "project" ||
        value === "plugin" ||
        value === "runtime" ||
        value === "cli" ||
        value === "managed");
}
//# sourceMappingURL=trust.js.map