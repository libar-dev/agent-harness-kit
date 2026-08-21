import type { ExecutableHookHandler, HookSourceScope, HookTrustEntry, HookTrustState } from "./types.ts";
export type HookTrustPlatform = NodeJS.Platform;
export type HookTrustStorageScope = "global" | "project";
export type HookTrustOptions = {
    readonly platform?: HookTrustPlatform;
};
export type HookTrustStorageOptions = {
    readonly projectTrusted: boolean;
};
export type HookTrustRecord = {
    readonly id: string;
    readonly currentHash: string;
    readonly enabled: boolean;
    readonly trusted: boolean;
    readonly executable: boolean;
    readonly scope: HookSourceScope;
    readonly sourcePath: string;
    readonly matcher?: string;
    readonly commandPreview: string;
    readonly entry?: HookTrustEntry;
};
export declare function emptyHookTrustState(): HookTrustState;
export declare function hookTrustId(handler: ExecutableHookHandler): string;
export declare function buildHookTrustRecord(handler: ExecutableHookHandler, options?: HookTrustOptions): HookTrustRecord;
export declare function createHookTrustEntry(handler: ExecutableHookHandler, options?: HookTrustOptions & {
    readonly updatedAt?: string;
}): HookTrustEntry;
export declare function hashCommandHook(handler: ExecutableHookHandler, options?: HookTrustOptions): string;
export declare function isCommandHookTrusted(handler: ExecutableHookHandler, state: HookTrustState, options?: HookTrustOptions): boolean;
export declare function listHookTrustRecords(handlers: readonly ExecutableHookHandler[], state: HookTrustState, options?: HookTrustOptions): readonly HookTrustRecord[];
export declare function filterExecutableTrustedHooks(handlers: readonly ExecutableHookHandler[], state: HookTrustState, options?: HookTrustOptions): readonly ExecutableHookHandler[];
export declare function readHookTrustStateJson(input: string | undefined): HookTrustState;
export declare function hookTrustStorageScope(handler: ExecutableHookHandler, options: HookTrustStorageOptions): HookTrustStorageScope | undefined;
//# sourceMappingURL=trust.d.ts.map