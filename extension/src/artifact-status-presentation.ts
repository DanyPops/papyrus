import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * Shared {label, glyph, color} shape, mirroring task-presentation.ts's TASK_STATUS_PRESENTATION
 * for every other artifact kind's status. Centralizing this closes a real gap: every artifact
 * browser (Rules, Docs, Notes, Skills) previously rendered status as a bare glyph with no color at
 * all, which is exactly why "hard to understand which rules are active" was a real complaint --
 * an active rule's "●" and a deprecated rule's "○" differ only by one filled-vs-hollow pixel shape,
 * easy to miss at a glance across a scrolling list.
 */
export interface StatusPresentation {
	label: string;
	glyph: string;
	color: ThemeColor;
}

export const RULE_STATUS_PRESENTATION: Record<string, StatusPresentation> = {
	active: { label: "active", glyph: "●", color: "success" },
	deprecated: { label: "deprecated", glyph: "○", color: "muted" },
};

export const DOC_STATUS_PRESENTATION: Record<string, StatusPresentation> = {
	draft: { label: "draft", glyph: "○", color: "muted" },
	active: { label: "active", glyph: "●", color: "success" },
	archived: { label: "archived", glyph: "■", color: "dim" },
};

export const NOTE_STATUS_PRESENTATION: Record<string, StatusPresentation> = {
	draft: { label: "draft", glyph: "○", color: "muted" },
	active: { label: "active", glyph: "●", color: "success" },
	archived: { label: "archived", glyph: "■", color: "dim" },
};

export const SKILL_STATUS_PRESENTATION: Record<string, StatusPresentation> = {
	active: { label: "active", glyph: "●", color: "success" },
	deprecated: { label: "deprecated", glyph: "○", color: "muted" },
};

/**
 * Keyed by extra.discussion.state, not the shared Doc status column -- a settled Discussion's
 * doc.status becomes "archived", but a deferred one stays "active" at the doc level (see
 * domain/discussion.ts's header comment). Reusing DOC_STATUS_PRESENTATION here would render
 * "deferred" and "active" Discussions with the identical glyph, silently losing the one piece
 * of state this feature exists to distinguish.
 */
export const DISCUSSION_STATE_PRESENTATION: Record<string, StatusPresentation> = {
	active: { label: "active", glyph: "●", color: "accent" },
	deferred: { label: "deferred", glyph: "⏸", color: "warning" },
	settled: { label: "settled", glyph: "✓", color: "success" },
};

/** Rule severity gets its own color independent of status -- block is the loudest, info the quietest. */
export const RULE_SEVERITY_PRESENTATION: Record<string, ThemeColor> = {
	block: "error",
	warn: "warning",
	info: "accent",
};

export function severityColor(severity: string): ThemeColor {
	return RULE_SEVERITY_PRESENTATION[severity.toLowerCase()] ?? "muted";
}

/** Plain glyph lookup, for callers that build uncolored text first and colorize it later (e.g. task-graph's colorizeTaskGraphLine pattern). */
export function glyphOf(presentation: Record<string, StatusPresentation>, status: string): string {
	return presentation[status]?.glyph ?? "?";
}
