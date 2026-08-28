import { type LoadPluginHookManifestOptions, type PluginHookSourceMetadata } from "./plugin-manifest.ts";
import type { ExecutableHookHandler, HookDiagnostic, ParsedHookConfig } from "./types.ts";
export type { LoadPluginHookManifestOptions, PluginHookEnv, PluginHookSourceMetadata } from "./plugin-manifest.ts";
export type PluginHookManifestLoadResult = {
    readonly sources: readonly PluginHookSourceMetadata[];
    readonly parsed: ParsedHookConfig;
    readonly diagnostics: readonly HookDiagnostic[];
};
export declare function loadPluginHookManifest(options: LoadPluginHookManifestOptions): PluginHookManifestLoadResult;
export declare function selectHookCommandForPlatform(handler: ExecutableHookHandler, platform?: NodeJS.Platform): string;
//# sourceMappingURL=plugin-loader.d.ts.map