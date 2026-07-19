import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TaskStatus } from "../../src/task-service.ts";

export interface TaskStatusPresentation {
	label: string;
	glyph: string;
	color: ThemeColor;
}

export const TASK_STATUS_PRESENTATION: Record<TaskStatus, TaskStatusPresentation> = {
	todo: { label: "To-Do", glyph: "○", color: "muted" },
	"in-progress": { label: "in-progress", glyph: "●", color: "warning" },
	review: { label: "review", glyph: "◆", color: "mdLink" },
	rejected: { label: "rejected", glyph: "▲", color: "accent" },
	done: { label: "done", glyph: "■", color: "success" },
	canceled: { label: "canceled", glyph: "×", color: "error" },
};

export function taskTreeConnector(options: {
	depth: number;
	hasChildren: boolean;
	hasLaterSibling: boolean;
}): string {
	if (options.depth === 0) return options.hasChildren ? "▾" : "·";
	return `${"│ ".repeat(Math.max(0, options.depth - 1))}${options.hasLaterSibling ? "├─" : "└─"}`;
}
