import { diagnostic } from "./diagnostics.js";
const SYSTEM_MESSAGE_EVENTS = new Set([
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
]);
export function parseHookOutput(input) {
    const state = { input, output: {}, diagnostics: [] };
    const stderr = text(input.stderr);
    if (input.exitCode === 2) {
        return { output: { decision: "block", ...(stderr === undefined ? {} : { reason: stderr }) }, diagnostics: [] };
    }
    const stdout = input.stdout.trim();
    if (stdout.length === 0)
        return parsedOutput(state);
    const parsed = parseStdoutJson(stdout, state);
    if (!isRecord(parsed))
        return parsedOutput(state);
    parseUniversal(parsed, state);
    const specific = parseSpecific(parsed.hookSpecificOutput, state);
    if (specific === "mismatched" || specific === "invalid")
        return parsedOutput(state);
    parseEvent(parsed, specific, state);
    return parsedOutput(state);
}
function parseStdoutJson(stdout, state) {
    try {
        const parsed = JSON.parse(stdout);
        if (isRecord(parsed))
            return parsed;
        add(state, "invalid_root", "stdout", "Hook stdout JSON must be an object.");
    }
    catch (error) {
        if (!(error instanceof SyntaxError))
            throw error;
        add(state, "invalid_root", "stdout", "Hook stdout must be valid JSON.");
    }
    return undefined;
}
function parseUniversal(parsed, state) {
    if (typeof parsed.continue === "boolean") {
        state.output.continue = parsed.continue;
        if (state.input.event === "Stop" && parsed.continue === false)
            state.output.decision = "block";
    }
    copyText(parsed.stopReason, "stopReason", state);
    if (typeof parsed.suppressOutput === "boolean")
        state.output.suppressOutput = parsed.suppressOutput;
    if (parsed.systemMessage === undefined)
        return;
    if (SYSTEM_MESSAGE_EVENTS.has(state.input.event)) {
        copyText(parsed.systemMessage, "systemMessage", state);
        return;
    }
    add(state, "unsupported_field", "stdout.systemMessage", "Hook systemMessage is not supported for this event.", "warning");
}
function parseSpecific(value, state) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        add(state, "invalid_event_config", "stdout.hookSpecificOutput", "Hook hookSpecificOutput field must be an object.");
        return "invalid";
    }
    const eventName = value.hookEventName;
    if (eventName === undefined || eventName === state.input.event)
        return value;
    add(state, "invalid_event_config", "stdout.hookSpecificOutput.hookEventName", `Hook output event ${String(eventName)} does not match ${state.input.event}.`);
    return "mismatched";
}
function parseEvent(parsed, specific, state) {
    switch (state.input.event) {
        case "PreToolUse":
            parsePreToolUse(parsed, specific, state);
            return;
        case "PostToolUse":
            blockOnlyDecision(parsed.decision, "PostToolUse", state);
            copyText(parsed.reason, "reason", state);
            copyText(specific?.additionalContext ?? parsed.additionalContext, "additionalContext", state);
            copyUnknown(specific?.updatedToolOutput ?? parsed.updatedToolOutput, "updatedToolOutput", state);
            return;
        case "UserPromptSubmit":
            blockOnlyDecision(parsed.decision, "UserPromptSubmit", state);
            copyText(parsed.reason, "reason", state);
            copyText(specific?.additionalContext ?? parsed.additionalContext, "additionalContext", state);
            rejectPromptReplacement(specific, state);
            return;
        case "Stop":
            if (parsed.decision === "block")
                state.output.decision = "block";
            else if (parsed.decision !== undefined && parsed.decision !== "continue") {
                add(state, "unsupported_field", "stdout.decision", "Stop only supports decision block or continue.", "warning");
            }
            copyText(parsed.reason, "reason", state);
            copyText(specific?.additionalContext ?? parsed.additionalContext, "additionalContext", state);
            return;
        case "SessionStart":
            copyText(specific?.additionalContext ?? parsed.additionalContext, "additionalContext", state);
            if (parsed.decision !== undefined) {
                add(state, "unsupported_field", "stdout.decision", "SessionStart does not support decisions.", "warning");
            }
            return;
        case "PreCompact":
        case "PostCompact":
            return;
    }
}
function parsePreToolUse(parsed, specific, state) {
    const decision = preToolUseDecision(specific?.permissionDecision ?? parsed.decision);
    if (decision !== undefined)
        state.output.decision = decision;
    copyText(specific?.permissionDecisionReason ?? parsed.reason, "reason", state);
    copyText(specific?.additionalContext ?? parsed.additionalContext, "additionalContext", state);
    const updatedInput = specific?.updatedInput ?? parsed.updatedInput;
    if (updatedInput === undefined)
        return;
    if (specific?.permissionDecision === "allow") {
        state.output.updatedInput = updatedInput;
        return;
    }
    add(state, "unsupported_field", "stdout.hookSpecificOutput.updatedInput", "PreToolUse updatedInput is only applied when permissionDecision is allow.", "warning");
}
function blockOnlyDecision(value, event, state) {
    if (value === "block")
        state.output.decision = "block";
    else if (value !== undefined)
        add(state, "unsupported_field", "stdout.decision", `${event} only supports decision block.`, "warning");
}
function rejectPromptReplacement(specific, state) {
    for (const field of ["prompt", "updatedPrompt", "replacementPrompt"]) {
        if (specific !== undefined && Object.hasOwn(specific, field)) {
            add(state, "unsupported_field", `stdout.hookSpecificOutput.${field}`, "UserPromptSubmit prompt replacement is not supported.", "warning");
        }
    }
}
function preToolUseDecision(value) {
    if (value === "allow" || value === "approve" || value === "ask")
        return value;
    if (value === "deny" || value === "block")
        return "deny";
    return undefined;
}
function copyText(value, field, state) {
    const normalized = text(value);
    if (normalized !== undefined)
        state.output[field] = normalized;
}
function copyUnknown(value, field, state) {
    if (value !== undefined)
        state.output[field] = value;
}
function add(state, code, path, message, severity) {
    state.diagnostics.push(diagnostic({ code, event: state.input.event, message, path, ...(severity === undefined ? {} : { severity }) }, state.input.source));
}
function text(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parsedOutput(state) {
    return { output: state.output, diagnostics: state.diagnostics };
}
//# sourceMappingURL=output-parser.js.map