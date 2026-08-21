import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import type { HookDispatchResult } from "./dispatcher.ts";
import type { HookInputWire } from "./types.ts";
export declare const STOP_STATE_CUSTOM_TYPE = "senpi.hooks.stop-state";
export declare const STOP_DIAGNOSTICS_CUSTOM_TYPE = "senpi.hooks.stop-diagnostics";
export declare const STOP_OUTPUT_CUSTOM_TYPE = "senpi.hooks.stop-output";
type StopRuntime = Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">;
export declare function buildStopHookInput(event: {
    readonly messages: readonly AgentMessage[];
}, ctx: ExtensionContext): HookInputWire;
export declare function createStopTurnTracker(): {
    readonly reset: () => void;
    readonly turnKey: (ctx: ExtensionContext) => string;
};
export declare function applyStopHookResult(pi: StopRuntime, ctx: ExtensionContext, result: HookDispatchResult, turnKey: string): Promise<void>;
export {};
//# sourceMappingURL=stop-adapter.d.ts.map