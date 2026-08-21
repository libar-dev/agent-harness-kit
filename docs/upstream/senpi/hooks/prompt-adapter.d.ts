import type { HookDispatchResult } from "./dispatcher.ts";
import type { HookDiagnostic, HookInputWire } from "./types.ts";
export declare const HOOK_CUSTOM_MESSAGE_TYPE = "senpi.hook";
export declare const USER_PROMPT_BLOCK_REASON = "UserPromptSubmit hook blocked the prompt.";
export type UserPromptHookInputOptions = {
    readonly cwd: string;
    readonly permissionMode: string;
    readonly prompt: string;
    readonly sessionId: string;
    readonly transcriptPath?: string;
};
export type PendingPromptHookContext = {
    readonly additionalContext: readonly string[];
    readonly diagnostics: readonly HookDiagnostic[];
    readonly systemMessages: readonly string[];
};
export declare function buildUserPromptHookInput(options: UserPromptHookInputOptions): HookInputWire;
export declare function promptContextFromResult(result: HookDispatchResult): PendingPromptHookContext | undefined;
export declare function promptBlockReasonFromResult(result: HookDispatchResult): string;
export declare function formatPromptContextMessage(pending: PendingPromptHookContext): string | undefined;
export declare function appendSystemMessages(systemPrompt: string, messages: readonly string[]): string;
export declare function safeDiagnosticDetails(diagnostic: HookDiagnostic): {
    readonly code: HookDiagnostic["code"];
    readonly event?: string;
    readonly message: string;
    readonly path: string;
    readonly severity: HookDiagnostic["severity"];
    readonly sourcePath: string;
};
//# sourceMappingURL=prompt-adapter.d.ts.map