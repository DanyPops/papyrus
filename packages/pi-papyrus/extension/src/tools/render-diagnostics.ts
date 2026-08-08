/**
 * Temporary diagnostic instrumentation for the still-open /reload rendering-fallback
 * investigation (papyrus task 4930cd9b): a Vehicle tool call executes and returns real
 * data but renders as raw JSON (call args and result both) instead of through its
 * registered renderCall/renderResult. Leading theory: a timing race between
 * registerVehicleToolsWhenReady's fire-and-forget registration attempt and Pi resolving
 * a tool's ToolDefinition (session.getToolDefinition(name), read live from Pi's own
 * _toolDefinitions Map at the moment a tool-call message streams in -- see
 * @earendil-works/pi-coding-agent's agent-session.js/interactive-mode.ts).
 *
 * Opt-in (PAPYRUS_RENDER_DIAG=1) and best-effort (never throws, never blocks a real
 * call) -- appends JSONL to PAPYRUS_RENDER_DIAG_PATH (default
 * ~/.cache/papyrus/render-diag.log). Content-safe: never logs artifact body/title text,
 * only lengths and a small allow-listed set of short categorical fields (id/kind/status/
 * subtype/alias), matching the same discipline as every other diagnostic log in this
 * ecosystem (e.g. pi-web-spider's own diag.log).
 *
 * Remove once the investigation concludes either way.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SAFE_LITERAL_KEYS = new Set(["id", "kind", "status", "subtype", "alias"]);

function isEnabled(): boolean {
	return process.env.PAPYRUS_RENDER_DIAG === "1";
}

function diagPath(): string {
	return process.env.PAPYRUS_RENDER_DIAG_PATH ?? join(homedir(), ".cache", "papyrus", "render-diag.log");
}

/** Redacts to shape + length, never content -- except a small allow-listed set of short, non-sensitive categorical fields. */
export function shapeFingerprint(value: unknown, key?: string): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value))
		return { type: "array", length: value.length, sample: value.length > 0 ? shapeFingerprint(value[0]) : undefined };
	if (typeof value === "string") return key && SAFE_LITERAL_KEYS.has(key) ? value : { type: "string", length: value.length };
	if (typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "object") {
		const row = value as Record<string, unknown>;
		const fields: Record<string, unknown> = {};
		for (const [fieldKey, fieldValue] of Object.entries(row)) fields[fieldKey] = shapeFingerprint(fieldValue, fieldKey);
		return { type: "object", keys: Object.keys(row), fields };
	}
	return { type: typeof value };
}

export function recordRenderDiagnostic(entry: Record<string, unknown>): void {
	if (!isEnabled()) return;
	try {
		const path = diagPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		/* best-effort -- a broken diagnostic log must never break a real render or invocation */
	}
}
