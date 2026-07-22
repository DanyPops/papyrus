import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ContextBreakdown, ContextSegment, ContextSegmentItem } from "./context-budget.ts";

const VISIBLE_ROWS = 24;

const SEGMENT_COLORS: Record<ContextSegment["key"], ThemeColor> = {
	rules: "accent",
	tasks: "success",
	skills: "mdLink",
	basePrompt: "warning",
	messageHistory: "syntaxFunction",
	other: "muted",
};

/** Short, fixed-width column labels for the vertical deep-dive graph -- must match VERTICAL_BAR_WIDTH exactly so each label sits centered under its own bar. */
const SEGMENT_SHORT_LABELS: Record<ContextSegment["key"], string> = {
	rules: "Rul",
	tasks: "Tsk",
	skills: "Skl",
	basePrompt: "Bse",
	messageHistory: "Msg",
	other: "Oth",
};

const VERTICAL_BAR_HEIGHT = 6;
const VERTICAL_BAR_WIDTH = 3;

/**
 * One row in the unified scrollable view. Every segment that has any real (nonzero) content
 * is fully expanded inline -- there is no separate "select a segment, then drill in" step.
 * `key` drives this row's color; `isHeader` distinguishes a segment's own summary line from
 * its item rows underneath it.
 */
export interface ContextRow {
	key: ContextSegment["key"];
	isHeader: boolean;
	text: string;
	/** Nesting depth for indentation -- 0 for a segment header or a top-level item, deeper for real tree children (message history branches, Task containment). */
	depth: number;
}

function formatTokenCount(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function percentOf(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

/**
 * Flattens every segment with real content into one linear row list, filtering out anything
 * that is genuinely zero rather than displaying a misleading "0 tok  0.0%" row -- a segment or
 * item with literally nothing in it carries no information and is pure noise in a scrollable
 * view meant to show where tokens actually go. A segment whose OWN total is zero but whose
 * items are also all zero is dropped entirely; a segment with a nonzero total is always kept
 * even if all its items individually round to zero (the total itself is real signal).
 */
/** Recursively flattens one item and its real tree children (message history branches, Task containment) into indented rows, sorted biggest-first at each level -- a parent always immediately precedes its own children, never scrambled by a global sort. */
function flattenItem(item: ContextSegmentItem, key: ContextSegment["key"], depth: number, rows: ContextRow[]): void {
	rows.push({ key, isHeader: false, depth, text: `${item.estimatedTokens.toString().padStart(6)} tok  ${item.label}` });
	const children = (item.children ?? []).filter((child) => child.estimatedTokens > 0).sort((a, b) => b.estimatedTokens - a.estimatedTokens);
	for (const child of children) flattenItem(child, key, depth + 1, rows);
}

export function buildContextRows(breakdown: ContextBreakdown): ContextRow[] {
	const rows: ContextRow[] = [];
	const denominator = breakdown.totalTokens ?? breakdown.segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
	for (const segment of breakdown.segments) {
		const items = (segment.items ?? []).filter((item) => item.estimatedTokens > 0).sort((a, b) => b.estimatedTokens - a.estimatedTokens);
		// A genuinely-unknown segment (basePrompt before the first observed turn) must stay
		// visible even when its placeholder value is zero -- hiding it would misrepresent
		// "not measured yet" as "measured and empty", the same honesty problem overshootTokens
		// exists to prevent for the unaccounted bucket.
		if (segment.estimatedTokens <= 0 && items.length === 0 && !segment.unknown) continue;
		rows.push({
			key: segment.key,
			isHeader: true,
			depth: 0,
			text: `${segment.label} — ${segment.estimatedTokens} tok (${percentOf(segment.estimatedTokens, denominator)})`,
		});
		for (const item of items) flattenItem(item, segment.key, 1, rows);
	}
	return rows;
}

class ContextViewport {
	private offsetY = 0;
	private readonly rows: ContextRow[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly breakdown: ContextBreakdown,
		private readonly close: () => void,
	) {
		this.rows = buildContextRows(breakdown);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const contentWidth = Math.max(1, width);
		const border = theme.fg("borderMuted", "─".repeat(contentWidth));
		const lines: string[] = [border, truncateToWidth(theme.fg("accent", theme.bold("Context")), contentWidth, "")];

		if (this.breakdown.totalTokens !== null && this.breakdown.effectiveBudget !== null) {
			const percent = percentOf(this.breakdown.totalTokens, this.breakdown.effectiveBudget);
			lines.push(truncateToWidth(
				`${formatTokenCount(this.breakdown.totalTokens)} / ${formatTokenCount(this.breakdown.effectiveBudget)} tokens (${percent} of usable budget)`,
				contentWidth,
				"",
			));
		} else if (this.breakdown.totalTokens !== null) {
			lines.push(truncateToWidth(`${formatTokenCount(this.breakdown.totalTokens)} tokens (model context window unknown)`, contentWidth, ""));
		} else {
			lines.push(theme.fg("dim", "No real usage reported yet — sizes below are Papyrus's own estimates only"));
		}
		lines.push(renderContextBar(theme, this.breakdown.segments, contentWidth, this.breakdown.effectiveBudget ?? undefined));
		if (this.breakdown.overshootTokens > 0) {
			lines.push(truncateToWidth(theme.fg("warning", `Estimates exceed real total by ~${this.breakdown.overshootTokens} tok — sizes below are approximate, not exact`), contentWidth, ""));
		}
		const verticalBars = renderContextVerticalBars(theme, this.breakdown.segments);
		if (verticalBars.length > 0) {
			lines.push("");
			lines.push(theme.fg("dim", "Composition of used tokens:"));
			for (const barLine of verticalBars) lines.push(truncateToWidth(barLine, contentWidth, ""));
		}
		lines.push("");

		this.visibleWindow().forEach(({ row, index }) => {
			const gutter = theme.fg(SEGMENT_COLORS[row.key], "▌");
			const indent = "  ".repeat(row.depth);
			const text = row.isHeader ? theme.bold(row.text) : `${indent}${row.text}`;
			lines.push(truncateToWidth(`${gutter} ${text}`, contentWidth, ""));
			void index;
		});
		if (this.rows.length === 0) lines.push(theme.fg("dim", "  (nothing observed yet)"));
		else lines.push(theme.fg("muted", `  ${Math.min(this.offsetY + VISIBLE_ROWS, this.rows.length)}/${this.rows.length}`));

		lines.push("");
		lines.push(theme.fg("dim", "↑↓ scroll · esc close"));
		lines.push(border);
		return lines;
	}

	private visibleWindow(): Array<{ row: ContextRow; index: number }> {
		const end = Math.min(this.offsetY + VISIBLE_ROWS, this.rows.length);
		const result: Array<{ row: ContextRow; index: number }> = [];
		for (let index = this.offsetY; index < end; index++) result.push({ row: this.rows[index]!, index });
		return result;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (matchesKey(data, "up")) this.offsetY = Math.max(0, this.offsetY - 1);
		else if (matchesKey(data, "down")) this.offsetY = Math.min(Math.max(0, this.rows.length - VISIBLE_ROWS), this.offsetY + 1);
		else return;
		this.tui.requestRender();
	}
}

/**
 * Renders the context window as one horizontal stacked bar: one colored run of block
 * characters per USED segment, followed by a gray/dim run of "░" cells for the remaining,
 * genuinely EMPTY context window -- this is the "total used vs. unused" graph. A zero-token
 * breakdown (nothing observed yet) renders an entirely gray/dim track rather than a
 * divide-by-zero, since 0 used really does mean the whole window is empty right now.
 *
 * `capacity` is the real denominator (Papyrus's own effectiveBudget, matching the percentage
 * already shown in the text line above this bar) that used-vs-unused is measured against. When
 * omitted, or when usage has already exceeded it (overshoot / near-compaction), the bar falls
 * back to filling 100% of its width proportionally among segments -- there is no "unused" left
 * to show gray for once real usage has met or passed the real budget.
 */
export function renderContextBar(theme: Theme, segments: ReadonlyArray<ContextSegment>, width: number, capacity?: number): string {
	const total = segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
	if (total <= 0 || width <= 0) return theme.fg("dim", "░".repeat(Math.max(0, width)));
	const nonZero = segments.filter((segment) => segment.estimatedTokens > 0);
	const usedWidth = capacity !== undefined && capacity > total ? Math.min(width, Math.round((total / capacity) * width)) : width;

	let used = 0;
	let output = "";
	nonZero.forEach((segment, index) => {
		const isLast = index === nonZero.length - 1;
		const cells = isLast ? usedWidth - used : Math.round((segment.estimatedTokens / total) * usedWidth);
		used += cells;
		if (cells > 0) output += theme.fg(SEGMENT_COLORS[segment.key], "█".repeat(cells));
	});
	const emptyWidth = width - usedWidth;
	if (emptyWidth > 0) output += theme.fg("dim", "░".repeat(emptyWidth));
	return output;
}

/**
 * Renders the "used" portion's own composition as a small vertical bar chart, one column per
 * segment with real content, scaled so the largest segment fills the full height -- the
 * "deep dive" graph, complementing the horizontal used-vs-unused bar above it. Any segment
 * with real (nonzero) tokens gets at least one filled row so it stays visible even next to a
 * much larger segment. Returns an empty array (nothing to render) when no segment has any
 * tokens yet, matching the same zero-noise principle as the row list below it.
 */
export function renderContextVerticalBars(theme: Theme, segments: ReadonlyArray<ContextSegment>): string[] {
	const visible = segments.filter((segment) => segment.estimatedTokens > 0);
	if (visible.length === 0) return [];
	const max = Math.max(...visible.map((segment) => segment.estimatedTokens));
	const filledRows = new Map(visible.map((segment) => [segment.key, Math.max(1, Math.round((segment.estimatedTokens / max) * VERTICAL_BAR_HEIGHT))]));

	const lines: string[] = [];
	for (let row = 0; row < VERTICAL_BAR_HEIGHT; row++) {
		const rowsFromBottom = VERTICAL_BAR_HEIGHT - row;
		let line = "";
		for (const segment of visible) {
			const filled = (filledRows.get(segment.key) ?? 0) >= rowsFromBottom;
			line += `${filled ? theme.fg(SEGMENT_COLORS[segment.key], "█".repeat(VERTICAL_BAR_WIDTH)) : " ".repeat(VERTICAL_BAR_WIDTH)} `;
		}
		lines.push(line);
	}
	let legend = "";
	for (const segment of visible) legend += `${theme.fg(SEGMENT_COLORS[segment.key], SEGMENT_SHORT_LABELS[segment.key])} `;
	lines.push(legend);
	return lines;
}

/** Non-interactive fallback (print mode, RPC, etc.): the same unified row list, as plain text lines. */
function fallbackReport(breakdown: ContextBreakdown): string {
	const totalLine = breakdown.totalTokens !== null
		? `Real usage: ${breakdown.totalTokens} tokens${breakdown.effectiveBudget !== null ? ` / ${breakdown.effectiveBudget} usable budget (${percentOf(breakdown.totalTokens, breakdown.effectiveBudget)})` : ""}`
		: "Real usage: not yet reported";
	const overshootLine = breakdown.overshootTokens > 0 ? [`Estimates exceed real total by ~${breakdown.overshootTokens} tok -- sizes below are approximate, not exact`] : [];
	const rows = buildContextRows(breakdown);
	const rowLines = rows.length > 0 ? rows.map((row) => (row.isHeader ? row.text : `${"  ".repeat(row.depth)}${row.text}`)) : ["(nothing observed yet)"];
	return [totalLine, ...overshootLine, "", ...rowLines].join("\n");
}

export async function showContextView(ctx: ExtensionCommandContext, breakdown: ContextBreakdown): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(fallbackReport(breakdown), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ContextViewport(tui, theme, breakdown, done));
}
