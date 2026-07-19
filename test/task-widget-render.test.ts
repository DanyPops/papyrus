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
};

describe("task widget rendering", () => {
	it("renders actionable rows without redundant active or global-open aggregates", () => {
		for (const width of [40, 80, 120]) {
			const lines = renderTaskWidgetLines(theme, projection, width);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("▶ · ● Fix graph crash");
			expect(lines[0]).not.toContain("49 open");
			expect(lines[0]).not.toContain("▶ active");
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
		}
	});

	it("renders nothing when no actionable work remains", () => {
		expect(renderTaskWidgetLines(theme, { ...projection, rows: [], openTotal: 0 }, 80)).toEqual([]);
	});
});
