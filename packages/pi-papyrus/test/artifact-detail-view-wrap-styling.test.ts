import { describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showArtifactDetailView } from "../extension/src/artifact/artifact-detail-view.ts";
import { realAnsiTheme } from "./support/real-ansi-theme.ts";

/**
 * ArtifactDetailViewport's own Labels/Metadata buildDetailLines call (unlike the sibling
 * ArtifactCard, already fixed) never passes a real `measure` -- same gap, same consequence:
 * a themed multi-line field value loses its color escape on every wrapped line but the
 * first and last. Reproduced against the real showArtifactDetailView entry point with a
 * real ANSI theme.
 */

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "artifact-1",
		alias: "artifact-1",
		kind: "task",
		title: "A task with many labels",
		status: "todo",
		subtype: "",
		body: "",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function tuiContext() {
	const renders: string[][] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/workspace/papyrus",
		ui: {
			notify() {},
			async custom(factory: any) {
				const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, realAnsiTheme(), {}, () => {});
				renders.push(component.render(80));
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, renders };
}

describe("ArtifactDetailViewport: wrapped Labels line keeps its intended foreground styling (regression)", () => {
	it("applies the field color to EVERY physical line of a wrapped Labels value, not just the first and last", async () => {
		const labels = [
			"first-long-label-value",
			"second-long-label-value",
			"third-long-label-value",
			"fourth-long-label-value",
			"fifth-long-label-value",
			"sixth-long-label-value",
		];
		const harness = tuiContext();
		await showArtifactDetailView(harness.ctx, artifact({ labels }));
		const lines = harness.renders[0]!;

		const labelContinuationLines = lines.filter(
			(line) => line.includes("fourth-long-label-value") || line.includes("sixth-long-label-value"),
		);
		expect(labelContinuationLines.length).toBeGreaterThan(0);
		for (const line of labelContinuationLines) {
			expect(line).toContain("\x1b[38;2;200;200;200m");
		}
	});
});
