/**
 * Golden geometry test for PapyrusWidgetGroup's two-column grid layout -- a real, live incident:
 * renderWidgetSectionGroup was wired with NO `measure` option, silently defaulting to malevich's
 * own asciiTextMeasure (documented as having "no ANSI-escape awareness"). Every task row is real
 * ANSI-colored content (theme.fg() for focus/status glyphs), so the naive measure mismeasured its
 * true visible width -- the SplitPane border landed at the wrong visible column on the task row's
 * own line, one column per rendered row instead of a single consistent column for the whole grid.
 *
 * Exercises the REAL registered widget (not renderWidgetSectionGroup called standalone) with a
 * REAL ANSI-emitting Theme (a bracket-marker fake theme is not equivalent for measuring physical/
 * visible line width) and a realistic long task title -- exactly the shape that broke in
 * production -- asserting every line's border character sits at the SAME visible column.
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

/** The border char's own visible COLUMN index within `line`, or undefined if this line carries none
 * (e.g. a stacked-tree line, or a grid row with nothing on the right side that line). Strips ANSI
 * SGR escapes first -- a naive raw-character indexOf would count invisible escape bytes as columns. */
function borderColumn(line: string): number | undefined {
	const stripped = line.replace(ANSI_SGR_PATTERN, "");
	const index = stripped.indexOf("│");
	return index === -1 ? undefined : index;
}

const REALISTIC_TASK_GRAPH = {
	nodes: [
		{
			task: {
				id: "t1",
				alias: "t1",
				kind: "task",
				title: "Grant: a budget-gated, steer-resumable long-running Vehicle operation pattern (turns/tool-calls/tokens/wallclock)",
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
		},
	],
	rootIds: ["t1"],
};

describe("PapyrusWidgetGroup grid geometry (golden, real ANSI theme)", () => {
	it("keeps the SplitPane border at the same visible column on every line, including a real ANSI-colored, over-length task row", async () => {
		setPapyrusClientConnectorForTests(async () => {
			return {
				async call(op: string) {
					if (op === "tasks.graph") return REALISTIC_TASK_GRAPH;
					if (op === "notes.list") return Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, extra: { projectRoot: "/proj" } }));
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

		const width = 150;
		const lines = renderRegisteredWidget(ui, realTheme, width);

		// Confirms the grid path (not the narrow stacked-tree fallback) actually fired -- the grid's
		// own bare owner header line, no tree connector (real theme colors it, so strip ANSI first).
		expect(lines[0]!.replace(ANSI_SGR_PATTERN, "")).toBe("Papyrus");

		const borderColumns = lines.map(borderColumn).filter((column): column is number => column !== undefined);
		expect(borderColumns.length).toBeGreaterThan(0);
		const firstColumn = borderColumns[0]!;
		for (const column of borderColumns) expect(column).toBe(firstColumn);

		// Every physical line, including the long ANSI-colored task row, stays within budget.
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

		resetPapyrusClientForTests();
	});

	it("regression guard: the naive ASCII measure alone (no ANSI awareness) really does misplace the border on this exact shape -- proving the fix's own measure wiring is load-bearing, not cosmetic", async () => {
		const { renderWidgetSectionGroup } = await import("malevich-tui-components");
		const { buildTaskWidgetSection } = await import("../extension/src/index.ts");
		const { measure: realMeasure } = await import("../extension/src/tool-rendering/artifact-card.ts");
		const projection = {
			rows: [
				{
					task: REALISTIC_TASK_GRAPH.nodes[0]!.task,
					depth: 0,
					hasOpenChildren: false,
					active: false,
					parentCount: 1,
				},
			],
			openTotal: 1,
			total: 1,
			scopeLabel: "vehicle",
		} as Parameters<typeof buildTaskWidgetSection>[1];
		const taskSection = buildTaskWidgetSection(realTheme, projection)!;
		const noteSection = { label: "Notes 7", render: () => [] };

		const withoutRealMeasure = renderWidgetSectionGroup({ owner: "Papyrus", sections: [taskSection, noteSection], minColumnWidth: 30 }).render(150);
		const withRealMeasure = renderWidgetSectionGroup({
			owner: "Papyrus",
			sections: [taskSection, noteSection],
			minColumnWidth: 30,
			measure: realMeasure,
		}).render(150);

		const naiveColumns = withoutRealMeasure.map(borderColumn).filter((c): c is number => c !== undefined);
		const realColumns = withRealMeasure.map(borderColumn).filter((c): c is number => c !== undefined);

		// The naive measure's own border columns are NOT all equal (the exact geometry bug) --
		// while the real-measure render is internally consistent.
		expect(new Set(naiveColumns).size).toBeGreaterThan(1);
		expect(new Set(realColumns).size).toBe(1);
	});
});
