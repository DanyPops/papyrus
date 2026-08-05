import { describe, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import { ArtifactCard } from "../extension/src/tool-rendering/artifact-card.ts";
import { createArtifactDetails } from "../extension/src/tool-rendering/render-model.ts";
import { assertFullBackgroundCoverage } from "./support/background-coverage.ts";

/**
 * A real ANSI-emitting theme, matching production Theme.fg/bg exactly (narrow
 * resets only -- \x1b[39m for fg, \x1b[49m for bg -- never a full \x1b[0m).
 * The existing tool-render-primitives.test.ts fixture uses bracket-tag markers
 * instead of real escape codes, which can never exercise whether wrapping
 * correctly preserves ANSI state across lines -- this is why this real gap
 * went uncaught.
 */
function realAnsiTheme(): Theme {
	return {
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		fg: (_color: string, text: string) => `\x1b[38;2;200;200;200m${text}\x1b[39m`,
	} as Theme;
}

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

/** Matches pi-mono's own tool-execution.ts wiring exactly: a Box(1, 1, bgFn) is the
 * one and only thing responsible for full-width background coverage of ANY child
 * component's output -- this is the real contract every result renderer relies on. */
function wrapInRealToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1, (text: string) => `\x1b[48;2;20;30;20m${text}\x1b[49m`);
	box.addChild(component);
	return box.render(width);
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
