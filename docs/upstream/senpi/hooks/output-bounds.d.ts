export declare const DEFAULT_STDOUT_LIMIT_BYTES: number;
export declare const DEFAULT_STDERR_LIMIT_BYTES: number;
export type HookOutputPolicy = {
    readonly maxStdoutBytes?: number;
    readonly maxStderrBytes?: number;
    readonly spillDir?: string;
};
export type HookStreamSafetyMetadata = {
    readonly originalBytes: number;
    readonly returnedBytes: number;
    readonly redacted: boolean;
    readonly spilled: boolean;
    readonly truncated: boolean;
    readonly spillPath?: string;
};
export type HookOutputSafetyMetadata = {
    readonly stdout: HookStreamSafetyMetadata;
    readonly stderr: HookStreamSafetyMetadata;
};
export type HookSafeOutput = {
    readonly text: string;
    readonly safety: HookStreamSafetyMetadata;
};
export declare function applyHookOutputSafety(stream: "stderr" | "stdout", text: string, policy: HookOutputPolicy | undefined, capture?: {
    readonly originalBytes: number;
    readonly truncated: boolean;
}): HookSafeOutput;
export declare function redactHookTokenValues(text: string, replacement?: string): string;
//# sourceMappingURL=output-bounds.d.ts.map