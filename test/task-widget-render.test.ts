import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTaskWidgetLines } from "../extension/src/index.ts";
import type { TaskWidgetProjection } from "../extension/src/task-widget.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

const projection: TaskWidgetProjection = {
	rows: [{
		task: {
			id: "defect", kind: "task", title: "Fix graph crash", status: "in-progress", subtype: "", body: "", labels: [], extra: {},
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		},
		depth: 0,
		hasOpenChildren: false,
		active: true,
	}],
	openTotal: 49,
	total: 110,
	scopeLabel: "papyrus · Release epic",
};

describe("task widget rendering", () => {
	it("renders actionable rows without redundant active or global-open aggregates", () => {
		for (const width of [40, 80, 120]) {
			const lines = renderTaskWidgetLines(theme, projection, width);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("Tasks · papyrus · Release epic");
			expect(lines[1]).toContain("▶ · ● Fix graph crash");
			expect(lines.join("\n")).not.toContain("49 open");
			expect(lines.join("\n")).not.toContain("▶ active");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("renders paused focus without the active continuation triangle", () => {
		const paused = { ...projection, rows: [{ ...projection.rows[0]!, focusStatus: "paused" as const }] };
		expect(renderTaskWidgetLines(theme, paused, 80)[1]).toContain("Ⅱ · ● Fix graph crash");
	});

	it("renders nothing when no actionable work remains", () => {
		expect(renderTaskWidgetLines(theme, { ...projection, rows: [], openTotal: 0 }, 80)).toEqual([]);
	});
});
