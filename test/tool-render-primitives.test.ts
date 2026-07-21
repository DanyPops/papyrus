import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ArtifactCard,
	countSummary,
	emptyState,
	expandHint,
	kindGlyph,
	statusGlyph,
	treeConnector,
} from "../extension/src/tool-rendering/artifact-card.ts";
import { createArtifactDetails } from "../extension/src/tool-rendering/render-model.ts";
import type { Artifact } from "../src/domain/artifact.ts";

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
		expect(card.render(80).join("\n")).toContain("<one:toolTitle>");

		card.update(details, theme("two"), false);
		card.invalidate();
		expect(card.render(80).join("\n")).toContain("<two:toolTitle>");
		expect(card.render(80).join("\n")).not.toContain("<one:toolTitle>");
	});

	it("provides one shared semantic grammar", () => {
		expect(kindGlyph("task")).toBe("◇");
		expect(kindGlyph("doc")).toBe("▤");
		expect(statusGlyph("done")).toBe("✓");
		expect(statusGlyph("rejected")).toBe("✗");
		expect(countSummary(3, 10)).toBe("3 of 10");
		expect(emptyState("tasks")).toBe("No tasks.");
		expect(treeConnector(true)).toBe("└─");
		expect(treeConnector(false)).toBe("├─");
		expect(expandHint()).toBe("expand for details");
	});
});
