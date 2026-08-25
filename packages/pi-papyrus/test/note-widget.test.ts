import { afterEach, describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { NoteOverlay, PapyrusWidgetGroup } from "../extension/src/index.ts";
import { buildNoteWidgetSection, type NoteWidgetRow } from "../extension/src/note/note-widget.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

function note(id: string, title: string, projectRoot: string): Artifact {
	return {
		id,
		title,
		status: "active",
		kind: "doc",
		subtype: "note",
		body: "",
		labels: ["note", "inbox"],
		extra: { projectRoot },
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		alias: id,
	};
}

function rows(count: number): NoteWidgetRow[] {
	return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: `Note ${i}` }));
}

function rotation(pageSize: number, totalRows: number, now: () => number = () => 0): AutoRotatingWindow {
	const window = new AutoRotatingWindow({ totalRows, pageSize, intervalMs: 1000, now });
	return window;
}

describe("buildNoteWidgetSection", () => {
	it("hides (returns undefined) when there are no open notes", () => {
		expect(buildNoteWidgetSection([], 0, rotation(3, 0))).toBeUndefined();
	});

	it("shows a label with the TRUE open count and renders the actual note titles as real body lines, not just a count", () => {
		const section = buildNoteWidgetSection(rows(2), 2, rotation(3, 2));
		expect(section?.label).toBe("Notes 2");
		expect(section?.render(40)).toEqual(["· Note 0", "· Note 1"]);
	});

	it("the label's own open count reflects the TRUE total even when fewer titles are actually kept/shown (bounded)", () => {
		const section = buildNoteWidgetSection(rows(3), 23, rotation(3, 3));
		expect(section?.label).toBe("Notes 23");
	});

	it("appends a page/total rotation hint to the label once the notes genuinely outgrow one page, never when they already fit", () => {
		const fits = buildNoteWidgetSection(rows(2), 2, rotation(3, 2));
		expect(fits?.label).toBe("Notes 2");

		let now = 0;
		const paging = rotation(3, 7, () => now);
		const overflow = buildNoteWidgetSection(rows(7), 7, paging);
		expect(overflow?.label).toBe("Notes 7 · 1/3 ⟳");
		now = 1000;
		expect(buildNoteWidgetSection(rows(7), 7, paging)?.label).toBe("Notes 7 · 2/3 ⟳");
	});

	it("renders only the current page's own titles, advancing as the injected clock advances", () => {
		let now = 0;
		const paging = rotation(2, 5, () => now);
		expect(buildNoteWidgetSection(rows(5), 5, paging)?.render(40)).toEqual(["· Note 0", "· Note 1"]);
		now = 1000;
		expect(buildNoteWidgetSection(rows(5), 5, paging)?.render(40)).toEqual(["· Note 2", "· Note 3"]);
		now = 2000;
		expect(buildNoteWidgetSection(rows(5), 5, paging)?.render(40)).toEqual(["· Note 4"]);
		now = 3000; // wraps back to page 0
		expect(buildNoteWidgetSection(rows(5), 5, paging)?.render(40)).toEqual(["· Note 0", "· Note 1"]);
	});

	it("truncates an overlong note title to the given width", () => {
		const section = buildNoteWidgetSection([{ id: "n1", title: "x".repeat(200) }], 1, rotation(3, 1));
		const lines = section?.render(20) ?? [];
		// visibleWidth, not raw .length -- truncateToWidth may embed zero-width ANSI reset codes
		// around the ellipsis even for otherwise plain text.
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
	});
});

describe("NoteOverlay: fetches and bounds real note titles for this session's own CWD, by default", () => {
	afterEach(resetPapyrusClientForTests);

	it("refresh() passes the overlay's project root through to notes.list, scoping the count to the CWD it was set to", async () => {
		let seenInput: Record<string, unknown> | undefined;
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call(_operation: string, input: Record<string, unknown>) {
						seenInput = input;
						return [note("a", "Follow up on X", "/workspace/one"), note("b", "Follow up on Y", "/workspace/one")];
					},
				}) as any,
		);
		const overlay = new NoteOverlay();
		overlay.setWidgetGroup(new PapyrusWidgetGroup());
		overlay.setProjectRoot("/workspace/one");

		await overlay.refresh();

		expect(seenInput).toMatchObject({ project_root: "/workspace/one" });
	});

	it("exposes the actual note titles (bounded), not just a count", async () => {
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call() {
						return [note("a", "Follow up on X", "/workspace/one"), note("b", "Follow up on Y", "/workspace/one")];
					},
				}) as any,
		);
		const overlay = new NoteOverlay();
		overlay.setWidgetGroup(new PapyrusWidgetGroup());
		overlay.setProjectRoot("/workspace/one");

		await overlay.refresh();

		const section = overlay.buildSection();
		expect(section?.label).toBe("Notes 2");
		expect(section?.render(40)).toEqual(["· Follow up on X", "· Follow up on Y"]);
	});

	it("retains note titles and marks them stale after a refresh failure", async () => {
		let calls = 0;
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call() {
						calls += 1;
						if (calls > 1) throw new Error("daemon unavailable");
						return [note("a", "Follow up on X", "/workspace/one")];
					},
				}) as any,
		);
		const overlay = new NoteOverlay();
		overlay.setWidgetGroup(new PapyrusWidgetGroup());
		overlay.setProjectRoot("/workspace/one");

		await overlay.refresh();
		await overlay.refresh();

		expect(overlay.hasOpenNotes()).toBe(true);
		expect(overlay.buildSection()?.label).toContain("stale");
		expect(overlay.buildSection()?.render(40)).toContain("· Follow up on X");
	});

	it("shows an unavailable section when the first refresh fails", async () => {
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call() {
						throw new Error("daemon unavailable");
					},
				}) as any,
		);
		const overlay = new NoteOverlay();
		overlay.setWidgetGroup(new PapyrusWidgetGroup());
		overlay.setProjectRoot("/workspace/one");

		await overlay.refresh();

		expect(overlay.hasOpenNotes()).toBe(true);
		expect(overlay.buildSection()?.label).toContain("unavailable");
	});

	it("never throws, even when the daemon is unreachable or rendering itself fails", async () => {
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call() {
						throw new Error("daemon unavailable");
					},
				}) as any,
		);
		const overlay = new NoteOverlay();
		overlay.setWidgetGroup({
			requestUpdate: () => {
				throw new Error("boom");
			},
		} as unknown as PapyrusWidgetGroup);
		overlay.setProjectRoot("/workspace/one");

		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("startPolling/stopPolling/dispose manage a bounded fallback poll, same as TaskOverlay", async () => {
		let calls = 0;
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call() {
						calls += 1;
						return [];
					},
				}) as any,
		);
		const overlay = new NoteOverlay();
		overlay.setWidgetGroup(new PapyrusWidgetGroup());
		overlay.setProjectRoot("/workspace/one");

		overlay.startPolling(10);
		await new Promise((resolve) => setTimeout(resolve, 35));
		overlay.dispose();
		const callsAtDispose = calls;
		await new Promise((resolve) => setTimeout(resolve, 35));

		expect(calls).toBe(callsAtDispose);
		expect(callsAtDispose).toBeGreaterThanOrEqual(2);
	});
});
