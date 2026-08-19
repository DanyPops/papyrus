/**
 * PapyrusWidgetGroup owns the ONE real aboveEditor widget registration for both TaskOverlay and
 * NoteOverlay, composing their own current sections into a shared tree ("Papyrus" once, with
 * "Tasks"/"Notes" as its own indented children) instead of each registering its own separate
 * flat-header widget.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { NoteOverlay, PapyrusWidgetGroup, TaskOverlay } from "../extension/src/index.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

function fakeUi(): { setWidget: (...args: unknown[]) => void; calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		setWidget: (...args: unknown[]) => {
			calls.push(args);
		},
	};
}

/** Runs a registered widget's factory + render, the same way Pi's own aboveEditor host would. */
function renderRegisteredWidget(ui: { calls: unknown[][] }, width: number): string[] {
	const [, factory] = ui.calls[ui.calls.length - 1] as [string, (tui: unknown, theme: Theme) => { render: (width: number) => string[] }];
	return factory({ requestRender: () => {} }, theme).render(width);
}

describe("PapyrusWidgetGroup", () => {
	it("registers nothing (no setWidget call at all) before either overlay has ever refreshed", () => {
		const ui = fakeUi();
		const group = new PapyrusWidgetGroup();
		group.setUI(ui as unknown as ExtensionUIContext);
		group.setOverlays(new TaskOverlay(), new NoteOverlay());
		expect(ui.calls).toHaveLength(0);
	});

	it("composes both overlays' own current sections under one shared 'Papyrus' owner header", async () => {
		setPapyrusClientConnectorForTests(async () => {
			return {
				async call(op: string) {
					if (op === "tasks.graph") {
						return {
							nodes: [
								{
									task: {
										id: "t1",
										alias: "t1",
										kind: "task",
										title: "Ship the widget group",
										status: "in-progress",
										subtype: "",
										body: "",
										labels: [],
										extra: {},
										created_at: "2026-01-01T00:00:00.000Z",
										updated_at: "2026-01-01T00:00:00.000Z",
									},
									active: false,
									parentIds: [],
									childIds: [],
									dependencyIds: [],
								},
							],
							rootIds: ["t1"],
						};
					}
					if (op === "notes.list") {
						return [{ id: "n1", title: "Follow up", extra: { projectRoot: "/proj" } }];
					}
					return undefined;
				},
			} as any;
		});

		const ui = fakeUi();
		const group = new PapyrusWidgetGroup();
		group.setUI(ui as unknown as ExtensionUIContext);
		const taskOverlay = new TaskOverlay();
		const noteOverlay = new NoteOverlay();
		taskOverlay.setWidgetGroup(group);
		noteOverlay.setWidgetGroup(group);
		taskOverlay.setProjectRoot("/proj");
		noteOverlay.setProjectRoot("/proj");
		group.setOverlays(taskOverlay, noteOverlay);

		await taskOverlay.refresh();
		await noteOverlay.refresh();

		// A wide viewport (>= renderWidgetSectionGroup's own default 2*minColumnWidth+1) lays Tasks
		// and Notes out side by side, not as separate stacked tree branches -- the grid path's own
		// bare "Papyrus" header line (no tree connector), with both column headers on the SAME line.
		const wideLines = renderRegisteredWidget(ui, 200);
		expect(wideLines[0]).toBe("Papyrus");
		expect(wideLines[1]).toContain("Tasks");
		expect(wideLines[1]).toContain("Notes 1");
		expect(wideLines.join("\n")).toContain("Ship the widget group");

		// A narrow viewport falls back to the stacked tree instead -- the owner is a plain,
		// unconnected label (matching Rich's own root convention), sections are its real children.
		const narrowLines = renderRegisteredWidget(ui, 40);
		expect(narrowLines[0]).toBe("Papyrus");
		const narrowJoined = narrowLines.join("\n");
		expect(narrowJoined).toContain("Tasks");
		expect(narrowJoined).toContain("Notes 1");
		resetPapyrusClientForTests();
	});

	it("renders just the one overlay's own section when the other has nothing open, still under the shared owner header", async () => {
		setPapyrusClientConnectorForTests(async () => {
			return {
				async call(op: string) {
					if (op === "tasks.graph") return { nodes: [], rootIds: [] };
					if (op === "notes.list") return [{ id: "n1", title: "Follow up", extra: { projectRoot: "/proj" } }];
					return undefined;
				},
			} as any;
		});

		const ui = fakeUi();
		const group = new PapyrusWidgetGroup();
		group.setUI(ui as unknown as ExtensionUIContext);
		const taskOverlay = new TaskOverlay();
		const noteOverlay = new NoteOverlay();
		taskOverlay.setWidgetGroup(group);
		noteOverlay.setWidgetGroup(group);
		taskOverlay.setProjectRoot("/proj");
		noteOverlay.setProjectRoot("/proj");
		group.setOverlays(taskOverlay, noteOverlay);

		await taskOverlay.refresh();
		await noteOverlay.refresh();

		const lines = renderRegisteredWidget(ui, 200);
		const joined = lines.join("\n");
		expect(joined).toContain("Papyrus");
		expect(joined).toContain("Notes 1");
		expect(joined).not.toContain("Tasks");
		resetPapyrusClientForTests();
	});

	it("hides entirely (unregisters, not just empty lines) once NEITHER overlay has anything open", async () => {
		setPapyrusClientConnectorForTests(async () => {
			return {
				async call(op: string) {
					if (op === "tasks.graph") return { nodes: [], rootIds: [] };
					if (op === "notes.list") return [];
					return undefined;
				},
			} as any;
		});

		const ui = fakeUi();
		const group = new PapyrusWidgetGroup();
		group.setUI(ui as unknown as ExtensionUIContext);
		const taskOverlay = new TaskOverlay();
		const noteOverlay = new NoteOverlay();
		taskOverlay.setWidgetGroup(group);
		noteOverlay.setWidgetGroup(group);
		taskOverlay.setProjectRoot("/proj");
		noteOverlay.setProjectRoot("/proj");
		group.setOverlays(taskOverlay, noteOverlay);

		await taskOverlay.refresh();
		await noteOverlay.refresh();

		// requestUpdate()'s own eager, theme-free hasOpenWork()/hasOpenNotes() check means the widget
		// is never even registered in the first place when both are empty from the start.
		expect(ui.calls).toHaveLength(0);
		resetPapyrusClientForTests();
	});

	it("unregisters an already-registered widget once a later refresh finds both overlays empty", async () => {
		let taskHasWork = true;
		setPapyrusClientConnectorForTests(async () => {
			return {
				async call(op: string) {
					if (op === "tasks.graph") {
						return taskHasWork
							? {
									nodes: [
										{
											task: {
												id: "t1",
												alias: "t1",
												kind: "task",
												title: "Ship it",
												status: "in-progress",
												subtype: "",
												body: "",
												labels: [],
												extra: {},
												created_at: "2026-01-01T00:00:00.000Z",
												updated_at: "2026-01-01T00:00:00.000Z",
											},
											active: false,
											parentIds: [],
											childIds: [],
											dependencyIds: [],
										},
									],
									rootIds: ["t1"],
								}
							: { nodes: [], rootIds: [] };
					}
					if (op === "notes.list") return [];
					return undefined;
				},
			} as any;
		});

		const ui = fakeUi();
		const group = new PapyrusWidgetGroup();
		group.setUI(ui as unknown as ExtensionUIContext);
		const taskOverlay = new TaskOverlay();
		const noteOverlay = new NoteOverlay();
		taskOverlay.setWidgetGroup(group);
		noteOverlay.setWidgetGroup(group);
		taskOverlay.setProjectRoot("/proj");
		noteOverlay.setProjectRoot("/proj");
		group.setOverlays(taskOverlay, noteOverlay);

		await taskOverlay.refresh();
		expect(ui.calls.length).toBeGreaterThan(0);
		expect(ui.calls[ui.calls.length - 1]![1]).toBeDefined();

		taskHasWork = false;
		await taskOverlay.refresh();
		expect(ui.calls[ui.calls.length - 1]).toEqual(["pi-papyrus", undefined]);
		resetPapyrusClientForTests();
	});

	it("dispose() unregisters the widget", () => {
		const ui = fakeUi();
		const group = new PapyrusWidgetGroup();
		group.setUI(ui as unknown as ExtensionUIContext);
		group.dispose();
		const [key, factory] = ui.calls[ui.calls.length - 1] as [string, unknown];
		expect(key).toBe("pi-papyrus");
		expect(factory).toBeUndefined();
	});
});
