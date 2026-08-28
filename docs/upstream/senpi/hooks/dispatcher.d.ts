import { type CommandHookRunOptions, type CommandHookRunResult } from "./command-runner.ts";
import { type ParsedHookOutput } from "./output-parser.ts";
import { type HookOutputPolicy } from "./safety.ts";
import { type HookTrustOptions, type HookTrustRecord } from "./trust.ts";
import type { ExecutableHookHandler, HookDiagnostic, HookInputWire, HookSourceMetadata, HookTrustState } from "./types.ts";
export type HookCommandRunner = (handler: ExecutableHookHandler, input: HookInputWire, options: CommandHookRunOptions) => Promise<CommandHookRunResult>;
export type HookDispatchDecision = {
    readonly kind: "none";
} | {
    readonly kind: "allow" | "block";
    readonly reason?: string;
    readonly source: HookSourceMetadata;
    readonly sourceCommand: string;
    readonly updatedInput?: unknown;
} | {
    readonly fallback: {
        readonly kind: "block";
        readonly reason: string;
    };
    readonly kind: "ask";
    readonly nativeRepresentable: false;
    readonly reason?: string;
    readonly source: HookSourceMetadata;
    readonly sourceCommand: string;
};
export type HookDispatchSkipped = {
    readonly diagnostics: readonly HookDiagnostic[];
    readonly handler: ExecutableHookHandler;
    readonly reason: "disabled" | "untrusted" | "unsafe";
    readonly record: HookTrustRecord;
};
export type HookDispatchSummary = {
    readonly completionIndex: number;
    readonly diagnostics: readonly HookDiagnostic[];
    readonly handler: ExecutableHookHandler;
    readonly output: ParsedHookOutput["output"];
    readonly run: CommandHookRunResult;
};
export type HookDispatchResult = {
    readonly decision: HookDispatchDecision;
    readonly diagnostics: readonly HookDiagnostic[];
    readonly executableHandlers: readonly ExecutableHookHandler[];
    readonly matchedHandlers: readonly ExecutableHookHandler[];
    readonly skipped: readonly HookDispatchSkipped[];
    readonly summaries: readonly HookDispatchSummary[];
};
export type HookDispatchOptions = {
    readonly cwd: string;
    readonly envPassthrough?: readonly string[];
    readonly handlers: readonly ExecutableHookHandler[];
    readonly input: HookInputWire;
    readonly onRunningHandlersChange?: (running: readonly ExecutableHookHandler[]) => void;
    readonly outputPolicy?: HookOutputPolicy;
    readonly runCommand?: HookCommandRunner;
    readonly signal?: AbortSignal;
    readonly sourceEnv?: NodeJS.ProcessEnv;
    readonly trustOptions?: HookTrustOptions;
    readonly trustState: HookTrustState;
};
export declare function dispatchHookEvent(options: HookDispatchOptions): Promise<HookDispatchResult>;
export declare function runningHookHandlersStatusLabel(handlers: readonly ExecutableHookHandler[], platform?: NodeJS.Platform): string;
//# sourceMappingURL=dispatcher.d.ts.map