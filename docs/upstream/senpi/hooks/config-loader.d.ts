import type { ParsedHookConfig } from "./types.ts";
export type HookConfigFileSystem = {
    readonly readTextFile: (path: string) => string | undefined;
};
export type HookConfigLoaderOptions = {
    readonly cwd: string;
    readonly agentDir: string;
    readonly fileSystem: HookConfigFileSystem;
    readonly globalSettingsHooks?: unknown;
    readonly projectSettingsHooks?: unknown;
    readonly globalHooksPath?: string;
    readonly projectHooksPath?: string;
    readonly globalHookSourcePaths?: readonly string[];
    readonly projectHookSourcePaths?: readonly string[];
    readonly preSessionHookSourcePaths?: readonly string[];
    readonly runtimeHookSourcePaths?: readonly string[];
};
export declare function loadHookConfigSources(options: HookConfigLoaderOptions): ParsedHookConfig;
//# sourceMappingURL=config-loader.d.ts.map