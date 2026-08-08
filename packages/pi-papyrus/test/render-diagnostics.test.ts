/**
 * Temporary instrumentation for the /reload rendering-fallback investigation (papyrus
 * task 4930cd9b) -- see extension/src/tools/render-diagnostics.ts's own doc comment.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRenderDiagnostic, shapeFingerprint } from "../extension/src/tools/render-diagnostics.ts";

describe("recordRenderDiagnostic", () => {
	const directory = mkdtempSync(join(tmpdir(), "papyrus-render-diag-"));
	const path = join(directory, "render-diag.log");

	afterEach(() => {
		delete process.env.PAPYRUS_RENDER_DIAG;
		delete process.env.PAPYRUS_RENDER_DIAG_PATH;
		rmSync(directory, { recursive: true, force: true });
	});

	it("is a no-op when PAPYRUS_RENDER_DIAG isn't set to 1", () => {
		process.env.PAPYRUS_RENDER_DIAG_PATH = path;
		recordRenderDiagnostic({ event: "test" });
		expect(existsSync(path)).toBe(false);
	});

	it("appends a JSONL entry with a timestamp once enabled", () => {
		process.env.PAPYRUS_RENDER_DIAG = "1";
		process.env.PAPYRUS_RENDER_DIAG_PATH = path;
		recordRenderDiagnostic({ event: "invoked", operation: "tasks.update" });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]!);
		expect(entry.event).toBe("invoked");
		expect(entry.operation).toBe("tasks.update");
		expect(typeof entry.ts).toBe("string");
	});

	it("appends multiple entries across calls instead of overwriting", () => {
		process.env.PAPYRUS_RENDER_DIAG = "1";
		process.env.PAPYRUS_RENDER_DIAG_PATH = path;
		recordRenderDiagnostic({ event: "first" });
		recordRenderDiagnostic({ event: "second" });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("never throws even when the configured path is unwritable", () => {
		process.env.PAPYRUS_RENDER_DIAG = "1";
		process.env.PAPYRUS_RENDER_DIAG_PATH = "/nonexistent-root-owned-directory/render-diag.log";
		expect(() => recordRenderDiagnostic({ event: "test" })).not.toThrow();
	});
});

describe("shapeFingerprint", () => {
	it("reduces a string field to its length, never its content", () => {
		expect(shapeFingerprint({ body: "a".repeat(500) })).toEqual({
			type: "object",
			keys: ["body"],
			fields: { body: { type: "string", length: 500 } },
		});
	});

	it("preserves the literal value for a small allow-listed set of short categorical fields", () => {
		expect(shapeFingerprint({ id: "task-1", kind: "task", status: "todo", subtype: "", alias: "task-one" })).toEqual({
			type: "object",
			keys: ["id", "kind", "status", "subtype", "alias"],
			fields: { id: "task-1", kind: "task", status: "todo", subtype: "", alias: "task-one" },
		});
	});

	it("recurses into a nested object, still never exposing string content outside the allow-list", () => {
		expect(shapeFingerprint({ artifact: { id: "task-1", title: "Secret project name" } })).toEqual({
			type: "object",
			keys: ["artifact"],
			fields: {
				artifact: {
					type: "object",
					keys: ["id", "title"],
					fields: { id: "task-1", title: { type: "string", length: 19 } },
				},
			},
		});
	});

	it("summarizes an array by length plus one shape sample, not every element", () => {
		expect(shapeFingerprint([{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual({
			type: "array",
			length: 3,
			sample: { type: "object", keys: ["id"], fields: { id: "a" } },
		});
	});

	it("passes booleans, numbers, null, and undefined through unchanged", () => {
		expect(shapeFingerprint(true)).toBe(true);
		expect(shapeFingerprint(42)).toBe(42);
		expect(shapeFingerprint(null)).toBe(null);
		expect(shapeFingerprint(undefined)).toBe(undefined);
	});
});
