import { expandHint } from "@danypops/vehicle-client-pi/expand-hint";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildDetailLines, type DetailField, type DetailSection, type DetailViewTheme, type TextMeasure } from "malevich-tui-components";
import type { ArtifactToolDetails } from "./render-model.ts";

/**
 * Real ANSI-aware measurement/wrapping -- without this, buildDetailLines falls back to
 * Malevich's own asciiTextMeasure, which is documented as having "no ANSI-code awareness"
 * and is only meant for short, unstyled labels. A themed multi-paragraph body (this file's
 * own Body: section) styles the whole text once before wrapping; the ASCII fallback then
 * slices that already-colored string by raw character index, so only the first and last
 * resulting physical lines keep the color escape -- every line in between renders in the
 * terminal's default color. wrapTextWithAnsi re-injects the active codes on every wrapped
 * line instead.
 */
export const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Shared by every buildDetailLines caller in this extension (ArtifactCard, and
 * tools/vehicle-artifact-renderers.ts's discuss/tasks.complete renderers) -- one Theme -> DetailViewTheme
 * mapping instead of the same four-field object literal re-typed at each call site. */
export function detailViewTheme(theme: Theme): DetailViewTheme {
	return {
		field: (s) => theme.fg("text", s),
		heading: (s) => theme.fg("toolTitle", theme.bold(s)),
		byline: (s) => theme.fg("muted", s),
		body: (s) => theme.fg("text", s),
		line: (s) => theme.fg("warning", s),
	};
}

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

	/** Every field as a labeled `Label: value` line (buildDetailLines), matching the same
	 * convention pi-tickets' issue-detail-view.ts already uses -- not bare stacked values. */
	private fields(): DetailField[] {
		const artifact = this.details.artifact;
		const status = this.theme.fg(statusColor(artifact.status), `${statusGlyph(artifact.status)} ${artifact.status}`);
		return [
			{ label: "Title", value: artifact.title },
			{ label: "Alias", value: artifact.alias ?? artifact.id },
			{ label: "Kind", value: `${kindGlyph(artifact.kind)} ${artifact.kind}` },
			{ label: "Status", value: status },
			...(this.expanded ? [{ label: "ID", value: artifact.id }] : []),
			...(this.expanded && artifact.subtype ? [{ label: "Subtype", value: artifact.subtype }] : []),
			...(this.expanded && artifact.labels.length > 0 ? [{ label: "Labels", value: artifact.labels.join(", ") }] : []),
		];
	}

	private sections(): DetailSection[] {
		if (!this.expanded) return [];
		const sections: DetailSection[] = [];
		const artifact = this.details.artifact;
		if (artifact.body) sections.push({ heading: "Body:", body: artifact.body });
		if (this.details.completeness.truncated) {
			sections.push({ lines: [`[truncated ${this.details.completeness.omitted} characters]`] });
		}
		return sections;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;

		const theme = this.theme;
		const lines = buildDetailLines(safeWidth, {
			fields: this.fields(),
			sections: this.sections(),
			alignFields: true,
			theme: detailViewTheme(theme),
			measure,
		});

		if (this.details.focus) {
			lines.push(truncateToWidth(focusLine(this.details.focus, theme), safeWidth));
		}
		if (!this.expanded && (this.details.artifact.body || this.details.artifact.labels.length > 0)) {
			lines.push(truncateToWidth(theme.fg("dim", expandHint()), safeWidth));
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
