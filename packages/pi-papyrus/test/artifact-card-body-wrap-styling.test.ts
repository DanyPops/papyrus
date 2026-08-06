import { describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { ArtifactCard } from "../extension/src/tool-rendering/artifact-card.ts";
import { createArtifactDetails } from "../extension/src/tool-rendering/render-model.ts";
import { realAnsiTheme } from "./support/real-ansi-theme.ts";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "4213ca51-844e-4de4-8273-dd92e7f31bc0",
		alias: "test-anchored-dataflow-narratives-using-bounded-ca",
		kind: "doc",
		title: "Test-anchored dataflow narratives",
		status: "active",
		subtype: "",
		body:
			"## The idea\n\n" +
			"A test's own name/description already states what it verifies; a comment restating " +
			"that in different words is a real, callable Test's Own Documentation smell.",
		labels: [],
		extra: {},
		created_at: "2026-08-04T06:45:51.095Z",
		updated_at: "2026-08-04T06:45:51.095Z",
		...overrides,
	};
}

describe("ArtifactCard: every wrapped body line keeps its intended foreground styling (regression)", () => {
	it("applies the fg color to EVERY physical line of a wrapped multi-paragraph body, not just the first and last", () => {
		const details = createArtifactDetails("docs.update", artifact());
		const card = new ArtifactCard(details, realAnsiTheme(), true);
		const lines = card.render(80);

		// The body's own wrapped continuation lines must each carry the real color
		// escape -- not just the fragment that happened to sit at the very start/end
		// of the pre-wrap-styled blob. ArtifactCard calls buildDetailLines without a
		// real ANSI-aware `measure` (unlike vehicle-render.ts's own CollapsibleText
		// calls, which correctly pass one) -- Malevich's asciiTextMeasure fallback
		// styles the WHOLE body text once, then slices it by raw character index,
		// so only the first/last resulting fragments keep the color code.
		const bodyContinuationLines = lines.filter((line) => line.includes("A test's own name") || line.includes("that in different words"));
		expect(bodyContinuationLines.length).toBeGreaterThan(0);
		for (const line of bodyContinuationLines) {
			expect(line).toContain("\x1b[38;2;200;200;200m");
		}
	});
});
