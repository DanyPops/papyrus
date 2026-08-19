import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { buildTaskWidgetSection, renderTaskSectionBodyLines, taskSectionLabel } from "../extension/src/index.ts";
import type { TaskWidgetProjection } from "../extension/src/task/task-widget.ts";

function rotation(totalRows: number): AutoRotatingWindow {
	return new AutoRotatingWindow({ totalRows, pageSize: 3, intervalMs: 6000 });
}

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

const projection: TaskWidgetProjection = {
	rows: [
		{
			task: {
				id: "defect",
				alias: "defect",
				kind: "task",
				title: "Fix graph crash",
				status: "in-progress",
				subtype: "",
				body: "",
				labels: [],
				extra: {},
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			},
			depth: 0,
			hasOpenChildren: false,
			active: true,
			parentCount: 1,
		},
	],
	openTotal: 49,
	total: 110,
	scopeLabel: "papyrus · Release epic",
};

describe("task widget rendering", () => {
	it("labels the section without a redundant 'Papyrus ·' prefix -- PapyrusWidgetGroup's own owner header covers that now", () => {
		expect(taskSectionLabel(projection)).toBe("Tasks · papyrus · Release epic");
		expect(taskSectionLabel({ ...projection, scopeLabel: "" })).toBe("Tasks");
	});

	it("renders actionable rows without redundant active or global-open aggregates, and no header line of its own", () => {
		for (const width of [40, 80, 120]) {
			const lines = renderTaskSectionBodyLines(theme, projection, width);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("▶ · ● Fix graph crash");
			expect(lines.join("\n")).not.toContain("49 open");
			expect(lines.join("\n")).not.toContain("▶ active");
			expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("renders paused focus without the active continuation triangle", () => {
		const paused = { ...projection, rows: [{ ...projection.rows[0]!, focusStatus: "paused" as const }] };
		expect(renderTaskSectionBodyLines(theme, paused, 80)[0]).toContain("Ⅱ · ● Fix graph crash");
	});

	it("flags a task with more than one parent, since containment is a DAG and this bounded widget can only show one position", () => {
		const singleParent = renderTaskSectionBodyLines(theme, projection, 80)[0]!;
		expect(singleParent).not.toContain("⥂"); // the normal, single-parent case carries no marker

		const multiParent = { ...projection, rows: [{ ...projection.rows[0]!, parentCount: 3 }] };
		const line = renderTaskSectionBodyLines(theme, multiParent, 80)[0]!;
		expect(line).toContain("⥂3"); // flags it also lives under 2 other parents not shown here
	});
});

describe("buildTaskWidgetSection", () => {
	it("returns undefined (hide the section entirely) when no actionable work remains", () => {
		expect(buildTaskWidgetSection(theme, { ...projection, rows: [], openTotal: 0 }, rotation(0))).toBeUndefined();
	});

	it("returns a real section, labeled and bodied, when there is open work", () => {
		const section = buildTaskWidgetSection(theme, projection, rotation(projection.rows.length));
		expect(section?.label).toBe("Tasks · papyrus · Release epic");
		expect(section?.render(80)).toEqual(renderTaskSectionBodyLines(theme, projection, 80));
	});
});
