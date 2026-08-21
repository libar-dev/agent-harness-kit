import type { HookDiagnostic, HookDiagnosticCode, HookSourceMetadata } from "./types.ts";
export type DiagnosticDraft = {
    readonly code: HookDiagnosticCode;
    readonly message: string;
    readonly path: string;
    readonly event?: string;
    readonly severity?: "error" | "warning";
};
export declare function diagnostic(draft: DiagnosticDraft, source: HookSourceMetadata): HookDiagnostic;
//# sourceMappingURL=diagnostics.d.ts.map