import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSensitiveOutput, redactSensitiveTokenValues } from "../../../sensitive-output.js";
export const DEFAULT_STDOUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
export function applyHookOutputSafety(stream, text, policy, capture) {
    const originalBytes = capture?.originalBytes ?? Buffer.byteLength(text);
    const redactedText = redactHookOutput(text);
    const redacted = redactedText !== text;
    const limit = stream === "stdout" ? policy?.maxStdoutBytes : policy?.maxStderrBytes;
    const maxBytes = limit ?? (stream === "stdout" ? DEFAULT_STDOUT_LIMIT_BYTES : DEFAULT_STDERR_LIMIT_BYTES);
    const redactedBytes = Buffer.byteLength(redactedText);
    const truncated = capture?.truncated === true || redactedBytes > maxBytes;
    const spillPath = truncated ? spillRedactedOutput(stream, redactedText, policy) : undefined;
    const returnedText = truncated ? Buffer.from(redactedText).subarray(0, maxBytes).toString("utf8") : redactedText;
    return {
        safety: {
            originalBytes,
            redacted,
            returnedBytes: Buffer.byteLength(returnedText),
            spilled: spillPath !== undefined,
            ...(spillPath === undefined ? {} : { spillPath }),
            truncated,
        },
        text: returnedText,
    };
}
function redactHookOutput(text) {
    return redactSensitiveOutput(text);
}
export function redactHookTokenValues(text, replacement = "[REDACTED]") {
    return redactSensitiveTokenValues(text, replacement);
}
function spillRedactedOutput(stream, text, policy) {
    const spillDir = policy?.spillDir ?? join(tmpdir(), "senpi-hook-output");
    mkdirSync(spillDir, { recursive: true });
    const path = join(spillDir, `hook-${stream}-${process.pid}-${randomUUID()}.txt`);
    writeFileSync(path, text);
    return path;
}
//# sourceMappingURL=output-bounds.js.map