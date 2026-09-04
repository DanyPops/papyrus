import { describe, expect, it } from "bun:test";
import type { Artifact, GraphRenderer } from "@danypops/papyrus";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { showArtifactDetailView } from "../extension/src/artifact/artifact-detail-view.ts";
import { realAnsiTheme } from "./support/real-ansi-theme.ts";

function longArtifact(): Artifact {
	return {
		id: "artifact-1",
		alias: "artifact-1",
		kind: "doc",
		title: "Long artifact",
		status: "active",
		subtype: "",
		body: Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n\n"),
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		edges: [{ from: "artifact-1", relation: "relates_to", to: "a-related-artifact-with-a-long-identifier" }],
	};
}

describe("artifact detail navigation", () => {
	it("preserves independent viewport state across resize and repeated toggles", async () => {
		let component: any;
		let closed = false;
		const tui = { terminal: { rows: 50 }, requestRender() {} };
		const keybindings = {
			matches(data: string, binding: string) {
				const key = binding.endsWith(".up")
					? "up"
					: binding.endsWith(".down")
						? "down"
						: binding.endsWith(".pageUp")
							? "pageUp"
							: binding.endsWith(".pageDown")
								? "pageDown"
								: "escape";
				return matchesKey(data, key as never);
			},
		};
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/workspace/papyrus",
			ui: {
				notify() {},
				async custom(factory: any) {
					component = await factory(tui, realAnsiTheme(), keybindings, () => {
						closed = true;
					});
				},
			},
		} as unknown as ExtensionCommandContext;

		const renderer: GraphRenderer = { render: () => ({ lines: ["relationship ".repeat(12)] }) };
		await showArtifactDetailView(ctx, longArtifact(), renderer);
		const compact = component.render(24);
		component.handleInput("G");
		component.handleInput("l");
		const compactAtEnd = component.render(24);
		component.handleInput("f");
		const expanded = component.render(24);
		tui.terminal.rows = 70;
		const resized = component.render(24);
		component.handleInput("g");
		component.handleInput("f");
		const restoredCompact = component.render(24);
		component.handleInput("f");
		const restoredExpanded = component.render(24);

		expect(expanded.length).toBeGreaterThan(compact.length);
		expect(resized.length).toBeGreaterThan(expanded.length);
		expect(compactAtEnd.join("\n")).toContain("line 60");
		expect(compactAtEnd.join("\n")).toContain("tionship relationship");
		expect(restoredCompact).toEqual(compactAtEnd);
		expect(restoredExpanded.join("\n")).toContain("line 1");
		expect(restoredExpanded.length).toBe(resized.length);
		component.handleInput("G");
		component.handleInput("h");
		expect(component.render(24).join("\n")).toContain("relationship relations");
		component.handleInput("q");
		expect(closed).toBe(true);
	});
});
