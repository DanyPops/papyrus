import { describe, expect, it } from "bun:test";
import { TOOL_COLLAPSED_ROW_LIMIT } from "@danypops/papyrus";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { createSemanticTextDetails } from "../extension/src/tool-rendering/render-model.ts";
import { papyrusVehiclePresentations } from "../extension/src/tools/vehicle-artifact-renderers.ts";

initTheme();
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const descriptor: VehicleOperationDescriptor = {
	name: "tasks.run_gates",
	version: 1,
	description: "",
	inputSchema: { type: "object" },
	outputSchema: { type: "object" },
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	streaming: false,
	longRunning: false,
	limits: { defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxRequestBytes: 1024, maxResponseBytes: 16384 },
	errors: [],
};
const contract = papyrusVehiclePresentations(descriptor);
const diagnostics =
	"✓ command: lint\n\u001b[49m\u001b[33mUnexpected any\u001b[0m\n\u001b[2J\u001b[Hsource.ts:135:11\r\n\tconst overlay = new TaskOverlay();\n\u001b]0;changed title\u0007Found 57 warnings.";

function component(text: string, expanded: boolean, legacy = false) {
	// Persisted presentations can predate display sanitization.
	const details = createSemanticTextDetails(descriptor.name, text);
	const presentation = { ...details, completeness: { ...details.completeness }, text };
	return contract.renderResult!(
		{
			content: [],
			details: {
				vehicle: { name: "papyrus", version: "1", operation: descriptor.name, operationVersion: 1, toolCallId: "render-test" },
				...(legacy ? { output: { content: [{ type: "text", text }] } } : { presentation }),
			},
		},
		{ isPartial: false, expanded },
		theme,
		{ cwd: "/tmp", isError: false } as never,
	);
}

describe("semantic text rendering", () => {
	it("projects plain diagnostics and preserves the operation output", async () => {
		const output = { gates: [], content: [{ type: "text", text: diagnostics }] };
		const projected = await contract.projector.project(output, {} as never);
		expect(projected).toMatchObject({ kind: "semantic-text" });
		expect(JSON.stringify(projected)).not.toContain("\\u001b");
		expect(output.content[0]?.text).toBe(diagnostics);
	});

	for (const legacy of [false, true]) {
		it(`sanitizes ${legacy ? "legacy output" : "persisted presentations"}`, () => {
			const text = component(diagnostics, true, legacy).render(80).join("\n");
			expect(text).toContain("Unexpected any");
			expect(text).toContain("Found 57 warnings.");
			expect(text).not.toContain("\u001b[49m");
			expect(text).not.toContain("\u001b[2J");
			expect(text).not.toContain("changed title");
			expect(text).not.toMatch(/[\r\t]/);
		});
	}

	it("preserves the enclosing tool background", () => {
		const background = "\u001b[48;2;27;40;32m";
		const reset = "\u001b[49m";
		const box = new Box(0, 0, (text) => `${background}${text}${reset}`);
		box.addChild(component(diagnostics, true));
		for (const line of box.render(80)) {
			expect(line.startsWith(background)).toBe(true);
			expect(line.indexOf(reset)).toBe(line.length - reset.length);
			expect(visibleWidth(line)).toBe(80);
		}
	});

	it("bounds wrapped rows and expands retained output", () => {
		const text = Array.from({ length: 30 }, (_, i) => `diagnostic ${i}: bounded output`).join("\n");
		const collapsed = component(text, false).render(40);
		expect(collapsed.length).toBeLessThanOrEqual(TOOL_COLLAPSED_ROW_LIMIT + 1);
		expect(collapsed.join("\n")).toContain("expand");
		const expanded = component(text, true).render(40);
		expect(expanded.join("\n")).toContain("diagnostic 29");
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("bounds expanded narrow output across resizing", () => {
		const view = component("界".repeat(1000), true);
		for (const width of [1, 10, 80]) {
			view.invalidate();
			const lines = view.render(width);
			expect(lines.length).toBeLessThanOrEqual(201);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders short text without an expansion hint", () => {
		expect(
			component("Passed", false)
				.render(80)
				.map((line) => line.trimEnd()),
		).toEqual(["Passed"]);
	});
});
