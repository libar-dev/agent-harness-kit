import type { ExecutableHookHandler, HookDiagnostic, HookInputWire } from "./types.ts";
export type HookMatcherResult = {
    readonly handlers: readonly ExecutableHookHandler[];
    readonly diagnostics: readonly HookDiagnostic[];
};
export declare function matchingHookHandlers(input: HookInputWire, handlers: readonly ExecutableHookHandler[]): HookMatcherResult;
//# sourceMappingURL=matcher.d.ts.map