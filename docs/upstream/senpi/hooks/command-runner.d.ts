import { type HookOutputPolicy, type HookOutputSafetyMetadata } from "./safety.ts";
import type { ExecutableHookHandler, HookInputWire } from "./types.ts";
export type CommandHookRunOptions = {
    readonly cwd: string;
    readonly envPassthrough?: readonly string[];
    readonly outputPolicy?: HookOutputPolicy;
    readonly signal?: AbortSignal;
    readonly sourceEnv?: NodeJS.ProcessEnv;
};
export type CommandHookRunResult = {
    readonly command: string;
    readonly cwd: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly aborted: boolean;
    readonly durationMs: number;
    readonly outputSafety: HookOutputSafetyMetadata;
    readonly timeoutSeconds: number;
};
export declare function runCommandHook(handler: ExecutableHookHandler, input: HookInputWire, options: CommandHookRunOptions): Promise<CommandHookRunResult>;
export declare function selectCommandForPlatform(handler: ExecutableHookHandler, platform?: NodeJS.Platform): string;
//# sourceMappingURL=command-runner.d.ts.map