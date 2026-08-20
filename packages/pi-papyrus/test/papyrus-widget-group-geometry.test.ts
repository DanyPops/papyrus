/**
 * Golden geometry test for PapyrusWidgetGroup's CardRow-based grid layout (bordered per-tool
 * cards, auto-fit tiled) -- exercises the REAL registered widget (not renderCardRow called
 * standalone) with a REAL ANSI-emitting Theme and realistic data, since a bracket-marker fake
 * theme is not equivalent for measuring physical/visible line width.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NoteOverlay, PapyrusWidgetGroup, TaskOverlay } from "../extension/src/index.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";
import { realTheme } from "./support/real-theme.ts";

function fakeUi(): { setWidget: (...args: unknown[]) => void; calls: unknown[][] } {
	const calls: unknown[][] = [];
	return { calls, setWidget: (...args: unknown[]) => calls.push(args) };
}

function renderRegisteredWidget(ui: { calls: unknown[][] }, theme: Theme, width: number): string[] {
	const [, factory] = ui.calls[ui.calls.length - 1] as [string, (tui: unknown, theme: Theme) => { render: (width: number) => string[] }];
	return factory({ requestRender: () => {} }, theme).render(width);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR escapes are real control characters -- stripping them is the whole point here.
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function strip(line: string): string {
	return line.replace(ANSI_SGR_PATTERN, "");
}

function taskGraph(titles: string[]) {
	return {
		nodes: titles.map((title, i) => ({
			task: {
				id: `t${i}`,
				alias: `t${i}`,
				kind: "task",
				title,
				status: "todo",
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
		})),
		rootIds: titles.map((_, i) => `t${i}`),
	};
}

async function buildWidget(tasks: string[], notes: number): Promise<{ ui: { calls: unknown[][] }; group: PapyrusWidgetGroup }> {
	setPapyrusClientConnectorForTests(async () => {
		return {
			async call(op: string) {
				if (op === "tasks.graph") return taskGraph(tasks);
				if (op === "notes.list")
					return Array.from({ length: notes }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, extra: { projectRoot: "/proj" } }));
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
	return { ui, group };
}

const LONG_TITLE = "Grant: a budget-gated, steer-resumable long-running Vehicle operation pattern (turns/tool-calls/tokens/wallclock)";

describe("PapyrusWidgetGroup CardRow grid geometry (golden, real ANSI theme)", () => {
	it("Tasks + Notes tile side by side as two bordered cards on a wide terminal -- borders align, real ANSI-colored over-length content stays in budget", async () => {
		const { ui } = await buildWidget([LONG_TITLE], 7);
		const width = 150;
		const lines = renderRegisteredWidget(ui, realTheme, width);

		// Two separate cards, each with its own full "Papyrus · <label>" title -- no shared owner
		// header line the way the old tree/split layout had.
		const headerLine = strip(lines[0]!);
		expect(headerLine).toContain("Papyrus · Tasks");
		expect(headerLine).toContain("Papyrus · Notes 7");

		// Every card's own bottom-border corner lands on the SAME physical line (pad-before-framing).
		const bottomLine = lines[lines.length - 1]!;
		expect((bottomLine.match(/╰/g) ?? []).length).toBe(2);
		expect((bottomLine.match(/╯/g) ?? []).length).toBe(2);

		// Every physical line, including the long ANSI-colored task row, stays within budget.
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

		resetPapyrusClientForTests();
	});

	it("regression guard: the naive ASCII measure alone (no ANSI awareness) really does misplace card widths on this exact shape -- proving the fix's own measure wiring is load-bearing, not cosmetic", async () => {
		const { renderCardRow } = await import("malevich-tui-components");
		const { buildTaskWidgetSection } = await import("../extension/src/index.ts");
		const { AutoRotatingWindow } = await import("malevich-tui-components");
		const { measure: realMeasure } = await import("../extension/src/tool-rendering/artifact-card.ts");
		const projection = {
			rows: [{ task: taskGraph([LONG_TITLE]).nodes[0]!.task, depth: 0, hasOpenChildren: false, active: false, parentCount: 1 }],
			openTotal: 1,
			total: 1,
			scopeLabel: "vehicle",
		} as Parameters<typeof buildTaskWidgetSection>[1];
		const taskSection = buildTaskWidgetSection(
			realTheme,
			projection,
			new AutoRotatingWindow({ totalRows: 1, pageSize: 3, intervalMs: 6000 }),
		)!;
		const noteSection = { label: "Notes 7", render: () => ["· a note"] };

		const withoutRealMeasure = renderCardRow([taskSection, noteSection], 150, { minCardWidth: 30 });
		const withRealMeasure = renderCardRow([taskSection, noteSection], 150, { minCardWidth: 30, measure: realMeasure });

		// Both stay within the requested width either way (renderBox truncates defensively) -- the
		// REAL bug is the naive measure counting the task row's own ANSI escape bytes as visible
		// width, believing the string is longer than it actually is and truncating strictly more
		// real title text than necessary.
		const naiveBody = strip(withoutRealMeasure[1]!);
		const realBody = strip(withRealMeasure[1]!);
		// How much of the real title survived before the truncation ellipsis -- the naive measure,
		// mistaking escape bytes for visible width, keeps strictly LESS of the real title.
		expect(realBody.indexOf("…")).toBeGreaterThan(naiveBody.indexOf("…"));
		for (const line of withRealMeasure) expect(visibleWidth(line)).toBeLessThanOrEqual(150);
	});

	it("golden: a single open Notes-only card renders as ONE full-width bordered card with the real note titles as body lines, not just a count", async () => {
		const { ui } = await buildWidget([], 2);
		const lines = renderRegisteredWidget(ui, realTheme, 80).map(strip);

		expect(lines[0]).toContain("Papyrus · Notes 2");
		expect(lines.some((line) => line.includes("· Note 0"))).toBe(true);
		expect(lines.some((line) => line.includes("· Note 1"))).toBe(true);
		// A lone card still fills the full given width.
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		expect(visibleWidth(lines[0]!)).toBe(80);

		resetPapyrusClientForTests();
	});

	it("golden: once a card's own rows genuinely outgrow its visible-row budget, its title shows a page/total rotation hint -- never for a card that already fits", async () => {
		// TASK_WIDGET_VISIBLE_ROWS is 3 -- 5 open tasks genuinely need 2 pages.
		const { ui } = await buildWidget(
			["Task A", "Task B", "Task C", "Task D", "Task E"],
			2, // 2 notes fit in one page (NOTE_WIDGET_VISIBLE_ROWS is 3) -- no hint expected here
		);
		const lines = renderRegisteredWidget(ui, realTheme, 150);
		const headerLine = strip(lines[0]!);

		expect(headerLine).toContain("Papyrus · Tasks");
		expect(headerLine).toMatch(/Tasks.*1\/2 ⟳/);
		expect(headerLine).toContain("Papyrus · Notes 2");
		expect(headerLine).not.toMatch(/Notes 2 · \d\/\d ⟳/);

		resetPapyrusClientForTests();
	});
});
