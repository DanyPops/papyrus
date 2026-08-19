import { afterEach, describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { NoteOverlay, PapyrusWidgetGroup } from "../extension/src/index.ts";
import { buildNoteWidgetSection } from "../extension/src/note/note-widget.ts";
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

describe("buildNoteWidgetSection", () => {
	it("hides (returns undefined) when there are no open notes", () => {
		expect(buildNoteWidgetSection(0)).toBeUndefined();
	});

	it("shows a label with the open count, and no body lines of its own, when there are open notes", () => {
		const section = buildNoteWidgetSection(3);
		expect(section?.label).toBe("Notes 3");
		expect(section?.render(40)).toEqual([]);
	});
});

describe("NoteOverlay: counts only open notes for this session's own CWD, by default", () => {
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
