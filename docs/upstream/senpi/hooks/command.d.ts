import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import type { HookStateStorage } from "./trust-storage.ts";
import type { HookDiagnostic, HookRuntimeState } from "./types.ts";
type HookCommandRuntimeState = HookRuntimeState & {
    readonly storage: HookStateStorage;
};
export declare function registerHooksCommand(pi: ExtensionAPI, refreshState: (ctx: ExtensionContext) => HookCommandRuntimeState): void;
export declare function formatHookStatus(state: HookCommandRuntimeState): string;
export declare function formatHookDiagnostics(diagnostics: readonly HookDiagnostic[]): string;
export {};
//# sourceMappingURL=command.d.ts.map