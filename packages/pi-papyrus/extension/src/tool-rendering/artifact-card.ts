import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ArtifactToolDetails } from "./render-model.ts";

const KIND_GLYPHS: Readonly<Record<string, string>> = {
	task: "◇",
	doc: "▤",
	rule: "◆",
	skill: "✦",
};

const STATUS_GLYPHS: Readonly<Record<string, string>> = {
	done: "✓",
	active: "●",
	"in-progress": "●",
	review: "◐",
	rejected: "✗",
	canceled: "×",
	todo: "○",
	draft: "○",
	archived: "·",
	deprecated: "·",
	// Task Execution's own state vocabulary (projectTaskExecution) --
	// distinct from an artifact's own lifecycle status above (a task's
	// literal `status` field is always todo/in-progress/review/rejected/
	// done/canceled; ready/blocked/invalid only ever appear as the derived
	// execution `state` a plan computes for a still-todo task).
	ready: "▶",
	blocked: "◼",
	invalid: "!",
};

type SemanticColor = "success" | "error" | "warning" | "accent" | "muted";

export function statusColor(status: string): SemanticColor {
	if (status === "done" || status === "active" || status === "ready") return "success";
	if (status === "rejected" || status === "canceled" || status === "invalid") return "error";
	if (status === "review") return "warning";
	if (status === "in-progress") return "accent";
	return "muted";
}

function focusLine(focus: ArtifactToolDetails["focus"], theme: Theme): string {
	if (!focus) return "";
	// Focus's own active/paused dimension is separate from the artifact's
	// lifecycle status shown in the header above -- never merge the two.
	if (focus.status === "paused") {
		const reason = focus.pauseReason ? ` — ${focus.pauseReason}` : "";
		return theme.fg("warning", `‖ focus paused${reason}`);
	}
	return theme.fg("accent", `▶ focus ${focus.status}`);
}

export function kindGlyph(kind: string): string {
	return KIND_GLYPHS[kind] ?? "•";
}

export function statusGlyph(status: string): string {
	return STATUS_GLYPHS[status] ?? "•";
}

export function countSummary(returned: number, total: number): string {
	return returned === total ? String(total) : `${returned} of ${total}`;
}

export function emptyState(noun: string): string {
	return `No ${noun}.`;
}

export function expandHint(): string {
	return "expand for details";
}

/** Reusable width-safe artifact card for native tool result rows. */
export class ArtifactCard implements Component {
	private details: ArtifactToolDetails;
	private theme: Theme;
	private expanded: boolean;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(details: ArtifactToolDetails, theme: Theme, expanded: boolean) {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
	}

	update(details: ArtifactToolDetails, theme: Theme, expanded: boolean): void {
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;

		const artifact = this.details.artifact;
		const status = `${statusGlyph(artifact.status)} ${artifact.status}`;
		const header = [
			this.theme.fg("toolTitle", this.theme.bold(`${kindGlyph(artifact.kind)} ${artifact.kind.toUpperCase()}`)),
			...(this.expanded ? [this.theme.fg("accent", artifact.id)] : []),
			this.theme.fg(statusColor(artifact.status), status),
		].join("  ");
		const lines = [truncateToWidth(header, safeWidth)];
		lines.push(truncateToWidth(this.theme.fg("text", artifact.title), safeWidth));

		if (this.details.focus) {
			lines.push(truncateToWidth(focusLine(this.details.focus, this.theme), safeWidth));
		}

		if (this.expanded) {
			const metadata = [artifact.subtype, ...artifact.labels].filter(Boolean).join(" · ");
			if (metadata) lines.push(truncateToWidth(this.theme.fg("muted", metadata), safeWidth));
			if (artifact.body) lines.push(...wrapTextWithAnsi(artifact.body, safeWidth));
			if (this.details.completeness.truncated) {
				lines.push(truncateToWidth(this.theme.fg("warning", `[truncated ${this.details.completeness.omitted} characters]`), safeWidth));
			}
		} else if (artifact.body || artifact.labels.length > 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", expandHint()), safeWidth));
		}

		this.cachedWidth = safeWidth;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
