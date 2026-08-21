import type { HookDiagnostic, HookSourceMetadata, SupportedHookEvent } from "./types.ts";
export type HookOutputParseInput = {
    readonly event: SupportedHookEvent;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly source: HookSourceMetadata;
};
type HookDecision = "allow" | "approve" | "ask" | "block" | "deny";
type MutableHookOutput = {
    decision?: HookDecision;
    reason?: string;
    additionalContext?: string;
    updatedInput?: unknown;
    updatedToolOutput?: unknown;
    continue?: boolean;
    stopReason?: string;
    suppressOutput?: boolean;
    systemMessage?: string;
};
export type ParsedHookOutput = {
    readonly output: Readonly<MutableHookOutput>;
    readonly diagnostics: readonly HookDiagnostic[];
};
export declare function parseHookOutput(input: HookOutputParseInput): ParsedHookOutput;
export {};
//# sourceMappingURL=output-parser.d.ts.map