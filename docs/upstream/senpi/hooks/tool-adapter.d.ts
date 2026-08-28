import type { ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "../../types.ts";
import type { HookDispatchResult } from "./dispatcher.ts";
import type { HookInputWire } from "./types.ts";
export declare const PRE_TOOL_BLOCK_REASON = "PreToolUse hook blocked the tool call.";
export declare const POST_TOOL_BLOCK_REASON = "PostToolUse hook flagged the tool result.";
export declare function buildPreToolUseHookInput(event: ToolCallEvent, ctx: ExtensionContext): HookInputWire;
export declare function buildPostToolUseHookInput(event: ToolResultEvent, ctx: ExtensionContext): HookInputWire;
export declare function applyPreToolUseResult(event: ToolCallEvent, result: HookDispatchResult): ToolCallEventResult | undefined;
export declare function applyPostToolUseResult(event: ToolResultEvent, result: HookDispatchResult, preToolContexts?: readonly string[]): ToolResultEventResult | undefined;
export declare function toolContextsFromResult(result: HookDispatchResult): readonly string[];
//# sourceMappingURL=tool-adapter.d.ts.map