import type { HookDiagnostic, HookDiscoveryTiming, HookSourceMetadata } from "./types.ts";
export declare const MANIFEST_PATH = ".codex-plugin/plugin.json";
export declare const DEFAULT_HOOK_PATH = "hooks/hooks.json";
export type PluginHookEnv = {
    readonly PLUGIN_ROOT: string;
    readonly PLUGIN_DATA: string;
    readonly CLAUDE_PLUGIN_ROOT: string;
    readonly CLAUDE_PLUGIN_DATA: string;
};
export type PluginHookSourceMetadata = HookSourceMetadata & {
    readonly pluginEnv: PluginHookEnv;
};
export type LoadPluginHookManifestOptions = {
    readonly pluginRoot: string;
    readonly displayOrder: number;
    readonly discoveredAt?: HookDiscoveryTiming;
    readonly dataRoot?: string;
    readonly includeDefaultHooks?: boolean;
};
export declare function buildPluginEnv(pluginRoot: string, dataRoot: string | undefined): PluginHookEnv;
export declare function pluginSource(input: {
    readonly discoveredAt: HookDiscoveryTiming;
    readonly displayOrder: number;
    readonly env: PluginHookEnv;
    readonly manifestPath: string;
    readonly pluginRoot: string;
    readonly sourcePath: string;
}): PluginHookSourceMetadata;
export declare function sourceForPath(options: LoadPluginHookManifestOptions, env: PluginHookEnv, sourcePath: string): PluginHookSourceMetadata;
export declare function resolveContainedPath(pluginRootInput: string, manifestPathInput: string): {
    readonly ok: true;
    readonly path: string;
} | {
    readonly ok: false;
    readonly message: string;
};
export declare function readJsonFile(path: string, manifestPath: string, source: PluginHookSourceMetadata): {
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly diagnostic: HookDiagnostic;
};
export declare function fileExists(path: string): boolean;
export declare function directoryExists(path: string): boolean;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
//# sourceMappingURL=plugin-manifest.d.ts.map