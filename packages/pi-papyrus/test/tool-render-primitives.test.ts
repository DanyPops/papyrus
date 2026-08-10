import { describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { expandHint } from "@danypops/vehicle-client-pi/expand-hint";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ArtifactCard, countSummary, emptyState, kindGlyph, statusGlyph } from "../extension/src/tool-rendering/artifact-card.ts";
import { createArtifactDetails } from "../extension/src/tool-rendering/render-model.ts";

// expandHint() calls Pi's own keyHint(), which reads Pi's global theme singleton
// (not this file's own fake per-call theme below) -- matches vehicle-render.test.ts's
// own precedent for the same reason.
initTheme();

function theme(tag: string): Theme {
	return {
		bold: (text: string) => `<${tag}:bold>${text}</${tag}:bold>`,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		fg: (color: string, text: string) => `<${tag}:${color}>${text}</${tag}:${color}>`,
	} as Theme;
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "task-1",
		alias: "build-a-context-mesh",
		kind: "task",
		title: "Build a context mesh with a deliberately long title for narrow terminals",
		status: "in-progress",
		subtype: "architecture",
		body: "First paragraph with enough text to wrap safely at narrow widths.\n\nSecond paragraph.",
		labels: ["papyrus", "context-mesh"],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

describe("Papyrus tool rendering primitives", () => {
	it("renders collapsed and expanded artifact cards within responsive widths", () => {
		const details = createArtifactDetails("tasks.show", artifact());
		const card = new ArtifactCard(details, theme("one"), false);
		for (const width of [40, 80, 120]) {
			const lines = card.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.join("\n")).not.toContain("First paragraph");
		}

		card.update(details, theme("one"), true);
		const expanded = card.render(40).join("\n");
		expect(expanded).toContain("First paragraph");
		expect(expanded).toContain("papyrus");
	});

	it("reuses the component while applying a replacement theme after invalidation", () => {
		const details = createArtifactDetails("tasks.show", artifact());
		const card = new ArtifactCard(details, theme("one"), false);
		expect(card.render(80).join("\n")).toContain("<one:text>");

		card.update(details, theme("two"), false);
		card.invalidate();
		expect(card.render(80).join("\n")).toContain("<two:text>");
		expect(card.render(80).join("\n")).not.toContain("<one:text>");
	});

	it("labels every field instead of stacking bare values, aligned to a common column", () => {
		const details = createArtifactDetails("tasks.show", artifact());
		const card = new ArtifactCard(details, theme("one"), false);
		const collapsed = card.render(80).join("\n");
		// Widest collapsed label is "Status" (6) -- every label pads to that column.
		expect(collapsed).toContain("Title:  Build a context mesh");
		expect(collapsed).toContain("Alias:  build-a-context-mesh");
		expect(collapsed).toContain("Kind:   ◇ task");
		expect(collapsed).toContain("Status: ");
		expect(collapsed).not.toContain("ID:");

		card.update(details, theme("one"), true);
		const expanded = card.render(80).join("\n");
		// Widest expanded label is "Subtype" (7) -- every label pads to that column.
		expect(expanded).toContain("ID:      task-1");
		expect(expanded).toContain("Subtype: architecture");
		expect(expanded).toContain("Labels:  papyrus, context-mesh");
		expect(expanded).toContain("Body:");
	});

	it("provides one shared semantic grammar", () => {
		expect(kindGlyph("task")).toBe("◇");
		expect(kindGlyph("doc")).toBe("▤");
		expect(statusGlyph("done")).toBe("✓");
		expect(statusGlyph("rejected")).toBe("✗");
		expect(countSummary(3, 10)).toBe("3 of 10");
		expect(emptyState("tasks")).toBe("No tasks.");
		// The real hotkey (ctrl+o, Pi's "app.tools.expand" binding) needs a fully booted
		// interactive session to resolve -- not exercised here, matching vehicle-render.test.ts's
		// own precedent for the same keyHint()-produced text. The description text is what this
		// unit asserts; live wiring is proven by the ArtifactCard render tests above.
		expect(expandHint()).toContain("expand for details");
	});
});
