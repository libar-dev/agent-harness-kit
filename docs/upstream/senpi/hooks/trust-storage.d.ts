import { type HookTrustStorageScope } from "./trust.ts";
import type { HookTrustState } from "./types.ts";
export interface HookStateStorage {
    read(scope: HookTrustStorageScope): HookTrustState;
    update(scope: HookTrustStorageScope, updater: (current: HookTrustState) => HookTrustState): HookTrustState;
}
export type FileHookStateStorageOptions = {
    readonly agentDir?: string;
    readonly cwd: string;
};
export declare class FileHookStateStorage implements HookStateStorage {
    private readonly globalStatePath;
    private readonly projectStatePath;
    constructor(options: FileHookStateStorageOptions);
    read(scope: HookTrustStorageScope): HookTrustState;
    update(scope: HookTrustStorageScope, updater: (current: HookTrustState) => HookTrustState): HookTrustState;
}
export declare class InMemoryHookStateStorage implements HookStateStorage {
    private globalState;
    private projectState;
    read(scope: HookTrustStorageScope): HookTrustState;
    update(scope: HookTrustStorageScope, updater: (current: HookTrustState) => HookTrustState): HookTrustState;
}
//# sourceMappingURL=trust-storage.d.ts.map