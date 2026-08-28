import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.js";
import { emptyHookTrustState, readHookTrustStateJson } from "./trust.js";
export class FileHookStateStorage {
    constructor(options) {
        const agentDir = options.agentDir ?? getAgentDir();
        this.globalStatePath = join(agentDir, "hooks-state.json");
        this.projectStatePath = join(options.cwd, CONFIG_DIR_NAME, "hooks-state.json");
    }
    read(scope) {
        return withHookStateFileLock(statePathForScope(scope, this.globalStatePath, this.projectStatePath), (path) => readHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined));
    }
    update(scope, updater) {
        return withHookStateFileLock(statePathForScope(scope, this.globalStatePath, this.projectStatePath), (path) => {
            const current = readHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined);
            const next = updater(current);
            writeFileSync(path, serializeHookTrustState(next), "utf-8");
            return next;
        });
    }
}
export class InMemoryHookStateStorage {
    constructor() {
        this.globalState = emptyHookTrustState();
        this.projectState = emptyHookTrustState();
    }
    read(scope) {
        return scope === "global" ? this.globalState : this.projectState;
    }
    update(scope, updater) {
        const next = updater(this.read(scope));
        if (scope === "global") {
            this.globalState = next;
        }
        else {
            this.projectState = next;
        }
        return next;
    }
}
function statePathForScope(scope, globalStatePath, projectStatePath) {
    return scope === "global" ? globalStatePath : projectStatePath;
}
function serializeHookTrustState(state) {
    const sortedHooks = {};
    for (const key of Object.keys(state.hooks).sort()) {
        const entry = state.hooks[key];
        if (entry !== undefined) {
            sortedHooks[key] = entry;
        }
    }
    return `${JSON.stringify({ version: 1, hooks: sortedHooks }, null, 2)}\n`;
}
function acquireHookStateLockSync(path) {
    const stateDir = dirname(path);
    mkdirSync(stateDir, { recursive: true });
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return lockfile.lockSync(stateDir, { realpath: false, lockfilePath: `${path}.lock` });
        }
        catch (error) {
            const code = errorCode(error);
            if (code !== "ELOCKED" || attempt === maxAttempts) {
                throw error;
            }
            lastError = error;
            const start = Date.now();
            while (Date.now() - start < delayMs) {
                Date.now();
            }
        }
    }
    if (lastError instanceof Error) {
        throw lastError;
    }
    throw new Error("Failed to acquire hook state lock");
}
function errorCode(error) {
    if (!isRecord(error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function withHookStateFileLock(path, fn) {
    const release = acquireHookStateLockSync(path);
    try {
        return fn(path);
    }
    finally {
        release();
    }
}
//# sourceMappingURL=trust-storage.js.map