import { describe, expect, it } from "bun:test";
import { TASK_STATUS_PRESENTATION, taskTreeConnector } from "../extension/src/task-presentation.ts";

describe("task lifecycle presentation", () => {
	it("maps every lifecycle to the requested semantic color", () => {
		expect(Object.fromEntries(Object.entries(TASK_STATUS_PRESENTATION).map(([status, value]) => [status, value.color]))).toEqual({
			todo: "muted",
			"in-progress": "warning",
			review: "mdLink",
			rejected: "accent",
			done: "success",
			canceled: "error",
		});
		expect(TASK_STATUS_PRESENTATION.todo.label).toBe("To-Do");
	});

	it("uses box-drawing connectors and reserves the right triangle for focus", () => {
		expect(taskTreeConnector({ depth: 0, hasChildren: true, hasLaterSibling: false })).toBe("▾");
		expect(taskTreeConnector({ depth: 1, hasChildren: false, hasLaterSibling: true })).toBe("├─");
		expect(taskTreeConnector({ depth: 2, hasChildren: false, hasLaterSibling: false })).toBe("│ └─");
		expect(Object.values(TASK_STATUS_PRESENTATION).some(({ glyph }) => glyph === "▶")).toBe(false);
	});
});
