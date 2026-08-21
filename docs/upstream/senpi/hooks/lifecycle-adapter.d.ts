import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionCompactEvent, SessionStartEvent } from "../../types.ts";
import { type HookDispatchResult } from "./dispatcher.ts";
import type { ExecutableHookHandler, HookDiagnostic, HookInputWire, HookTrustState } from "./types.ts";
type LifecycleHookEvent = "SessionStart" | "PreCompact" | "PostCompact";
type LifecycleDispatchOptions = {
    readonly cwd: string;
    readonly handlers: readonly ExecutableHookHandler[];
    readonly input: HookInputWire;
    readonly matcherInputs: readonly string[];
    readonly signal?: AbortSignal;
    readonly trustState: HookTrustState;
};
type LifecycleResultDetails = {
    readonly cancel: boolean;
    readonly contexts: readonly string[];
    readonly diagnostics: readonly HookDiagnostic[];
    readonly reason?: string;
};
export declare function buildSessionStartHookInput(event: SessionStartEvent, ctx: ExtensionContext): HookInputWire;
export declare function buildPreCompactHookInput(event: SessionBeforeCompactEvent, ctx: ExtensionContext): HookInputWire;
export declare function buildPostCompactHookInput(event: SessionCompactEvent, ctx: ExtensionContext): HookInputWire;
export declare function dispatchLifecycleHookEvent(options: LifecycleDispatchOptions): Promise<HookDispatchResult | undefined>;
export declare function sessionStartResultDetails(result: HookDispatchResult | undefined): LifecycleResultDetails;
export declare function preCompactResultDetails(result: HookDispatchResult | undefined): LifecycleResultDetails;
export declare function postCompactResultDetails(result: HookDispatchResult | undefined): LifecycleResultDetails;
export declare function sessionBeforeCompactResult(details: LifecycleResultDetails): SessionBeforeCompactResult | undefined;
export declare function recordLifecycleHookResult(pi: Pick<ExtensionAPI, "sendMessage">, event: LifecycleHookEvent, details: LifecycleResultDetails, options?: {
    compactionRequestId?: string;
}): void;
export {};
//# sourceMappingURL=lifecycle-adapter.d.ts.map