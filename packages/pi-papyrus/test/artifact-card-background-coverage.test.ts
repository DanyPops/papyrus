import { describe, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ArtifactCard } from "../extension/src/tool-rendering/artifact-card.ts";
import { createArtifactDetails } from "../extension/src/tool-rendering/render-model.ts";
import { assertFullBackgroundCoverage, wrapInRealToolBox } from "./support/background-coverage.ts";
import { realAnsiTheme } from "./support/real-ansi-theme.ts";

// expandHint() calls Pi's own keyHint(), which reads Pi's global theme singleton.
initTheme();

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "4213ca51-844e-4de4-8273-dd92e7f31bc0",
		alias: "test-anchored-dataflow-narratives-using-bounded-ca",
		kind: "doc",
		title: "Test-anchored dataflow narratives: using bounded call-stack analysis from test cases as domain-logic documentation",
		status: "active",
		subtype: "",
		body:
			"## The idea\n\n" +
			"A test's own name/description already states what it verifies; a comment restating " +
			"that in different words is a real, callable Test's Own Documentation smell. Anchoring " +
			"a narrative doc to the exact symbols a test's own call stack touches keeps the doc " +
			"honest: it can only describe what real, currently-passing code actually does.",
		labels: [],
		extra: {},
		created_at: "2026-08-04T06:45:51.095Z",
		updated_at: "2026-08-04T06:45:51.095Z",
		...overrides,
	};
}

describe("ArtifactCard: full-width background coverage under the real tool Box (regression)", () => {
	it("covers every cell of the collapsed card with no gaps, at a realistic terminal width", async () => {
		const details = createArtifactDetails("docs.update", artifact());
		const card = new ArtifactCard(details, realAnsiTheme(), false);
		const boxed = wrapInRealToolBox(card, 100);
		await assertFullBackgroundCoverage(boxed, 100);
	});

	it("covers every cell of the expanded card's multi-paragraph body, at a realistic terminal width", async () => {
		const details = createArtifactDetails("docs.update", artifact());
		const card = new ArtifactCard(details, realAnsiTheme(), true);
		const boxed = wrapInRealToolBox(card, 100);
		await assertFullBackgroundCoverage(boxed, 100);
	});

	it("covers every cell of the expanded card's body at several realistic widths", async () => {
		const details = createArtifactDetails("docs.update", artifact());
		for (const width of [60, 80, 120, 160]) {
			const card = new ArtifactCard(details, realAnsiTheme(), true);
			const boxed = wrapInRealToolBox(card, width);
			await assertFullBackgroundCoverage(boxed, width);
		}
	});
});
