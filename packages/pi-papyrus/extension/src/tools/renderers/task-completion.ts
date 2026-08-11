import type { Artifact } from "@danypops/papyrus";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection, statelessComponent } from "malevich-tui-components";
import { detailViewTheme, measure, statusColor, statusGlyph } from "../../tool-rendering/artifact-card.ts";
import { isArtifact, type RenderableDiscussionParent } from "./shared.ts";

/** tasks.complete's own TaskCompletion shape -- a completed (or rejected) task plus its own
 * gate/checklist proof run and any dependents still left blocked. Detected the same
 * name-independent, shape-based way as the others in this directory. */
export interface TaskGateResultOutput {
	gate: unknown;
	passed: boolean;
	output: string;
}

export interface TaskChecklistReviewOutput {
	item: string;
	accepted: boolean;
	reason?: string;
}

export interface TaskBlockageOutput {
	artifact: Artifact;
	dependencyIds: string[];
}

export interface TaskCompletionOutput {
	artifact: Artifact;
	gates: TaskGateResultOutput[];
	checklist: TaskChecklistReviewOutput[];
	completed: boolean;
	focused: Artifact | null;
	blocked: TaskBlockageOutput[];
}

/** What renderTaskCompletion actually reads -- satisfied by both the raw duck-typed TaskCompletionOutput and the leaner projected TaskCompletionToolDetails. */
export interface RenderableTaskCompletion {
	artifact: RenderableDiscussionParent;
	gates: readonly { passed: boolean; output: string }[];
	checklist: readonly TaskChecklistReviewOutput[];
	completed: boolean;
	focused?: RenderableDiscussionParent | null;
	blocked: readonly { artifact: RenderableDiscussionParent; dependencyIds: readonly string[] }[];
}

export function isTaskCompletion(value: unknown): value is TaskCompletionOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		isArtifact(row.artifact) &&
		Array.isArray(row.gates) &&
		Array.isArray(row.checklist) &&
		typeof row.completed === "boolean" &&
		(row.focused === null || isArtifact(row.focused)) &&
		Array.isArray(row.blocked)
	);
}

export function renderTaskCompletion(result: RenderableTaskCompletion, theme: Theme, expanded: boolean): Component {
	const task = result.artifact;
	return statelessComponent((width) => {
		const safeWidth = Math.max(1, width);
		const fields: DetailField[] = [
			{ label: "Title", value: task.title },
			{ label: "Status", value: theme.fg(statusColor(task.status), `${statusGlyph(task.status)} ${task.status}`) },
		];
		const sections: DetailSection[] = [];
		if (result.gates.length > 0) {
			sections.push({
				heading: "Gates:",
				lines: result.gates.map((gate) => theme.fg(gate.passed ? "success" : "error", `${gate.passed ? "✓" : "✗"} ${gate.output}`)),
			});
		}
		if (result.checklist.length > 0) {
			sections.push({
				heading: "Checklist:",
				lines: result.checklist.map((entry) =>
					theme.fg(
						entry.accepted ? "success" : "error",
						`${entry.accepted ? "✓" : "✗"} ${entry.item}${entry.reason ? ` — ${entry.reason}` : ""}`,
					),
				),
			});
		}
		if (result.blocked.length > 0) {
			sections.push({
				heading: "Still blocked:",
				lines: result.blocked.map((entry) => theme.fg("warning", `◼ ${entry.artifact.title}`)),
			});
		}
		const lines = buildDetailLines(safeWidth, { fields, sections, alignFields: true, theme: detailViewTheme(theme), measure });
		if (result.focused && expanded) {
			lines.push(truncateToWidth(theme.fg("accent", `▶ focus ${result.focused.title}`), safeWidth));
		}
		return lines;
	});
}
