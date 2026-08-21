import type { ExecutableHookHandler, HookDiagnostic, HookSourceMetadata, SupportedHookEvent } from "./types.ts";
type HandlerParseContext = {
    readonly event: SupportedHookEvent;
    readonly matcher?: string;
    readonly groupIndex: number;
    readonly handlerIndex: number;
    readonly source: HookSourceMetadata;
    readonly diagnostics: HookDiagnostic[];
};
export declare function parseHandler(handler: unknown, context: HandlerParseContext): ExecutableHookHandler | undefined;
export {};
//# sourceMappingURL=handler.d.ts.map