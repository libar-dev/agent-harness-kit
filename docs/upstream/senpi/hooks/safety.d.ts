import type { ExecutableHookHandler, HookDiagnostic, HookInputWire } from "./types.ts";
export { applyHookOutputSafety, DEFAULT_STDERR_LIMIT_BYTES, DEFAULT_STDOUT_LIMIT_BYTES, type HookOutputPolicy, type HookOutputSafetyMetadata, type HookSafeOutput, type HookStreamSafetyMetadata, } from "./output-bounds.ts";
export declare const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
type HookEnvironmentOptions = {
    readonly handler: ExecutableHookHandler;
    readonly input: HookInputWire;
    readonly sourceEnv: NodeJS.ProcessEnv;
    readonly envPassthrough?: readonly string[];
};
export declare function resolveHookTimeoutSeconds(handler: ExecutableHookHandler): number;
export declare function isValidHookTimeoutSeconds(timeout: number): boolean;
export declare function buildHookEnvironment(options: HookEnvironmentOptions): NodeJS.ProcessEnv;
export declare function validateHookHandlerSafety(handler: ExecutableHookHandler): readonly HookDiagnostic[];
//# sourceMappingURL=safety.d.ts.map