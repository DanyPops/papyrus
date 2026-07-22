import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ContextBreakdown, ContextSegment } from "./context-budget.ts";

const VISIBLE_ROWS = 24;

const SEGMENT_COLORS: Record<ContextSegment["key"], ThemeColor> = {
	rules: "accent",
	tasks: "success",
	skills: "mdLink",
	basePrompt: "warning",
	messageHistory: "syntaxFunction",
	other: "muted",
};

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
			text: `${segment.label} — ${segment.estimatedTokens} tok (${percentOf(segment.estimatedTokens, denominator)})`,
		});
		for (const item of items) {
			rows.push({ key: segment.key, isHeader: false, text: `  ${item.estimatedTokens.toString().padStart(6)} tok  ${item.label}` });
		}
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
		lines.push(renderContextBar(theme, this.breakdown.segments, contentWidth));
		if (this.breakdown.overshootTokens > 0) {
			lines.push(truncateToWidth(theme.fg("warning", `Estimates exceed real total by ~${this.breakdown.overshootTokens} tok — sizes below are approximate, not exact`), contentWidth, ""));
		}
		lines.push("");

		this.visibleWindow().forEach(({ row, index }) => {
			const gutter = theme.fg(SEGMENT_COLORS[row.key], "▌");
			const text = row.isHeader ? theme.bold(row.text) : row.text;
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
 * Renders the context window as one proportional stacked bar, one colored run of block
 * characters per segment, matching each row's own gutter color above/below it. A zero-token
 * breakdown (nothing observed yet) renders an empty dim track rather than a divide-by-zero.
 * Zero-token segments contribute no cells and are effectively invisible in the bar, matching
 * their exclusion from the row list below it.
 */
export function renderContextBar(theme: Theme, segments: ReadonlyArray<ContextSegment>, width: number): string {
	const total = segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
	if (total <= 0 || width <= 0) return theme.fg("dim", "░".repeat(Math.max(0, width)));
	const nonZero = segments.filter((segment) => segment.estimatedTokens > 0);
	let used = 0;
	let output = "";
	nonZero.forEach((segment, index) => {
		const isLast = index === nonZero.length - 1;
		const cells = isLast ? width - used : Math.round((segment.estimatedTokens / total) * width);
		used += cells;
		if (cells > 0) output += theme.fg(SEGMENT_COLORS[segment.key], "█".repeat(cells));
	});
	return output;
}

/** Non-interactive fallback (print mode, RPC, etc.): the same unified row list, as plain text lines. */
function fallbackReport(breakdown: ContextBreakdown): string {
	const totalLine = breakdown.totalTokens !== null
		? `Real usage: ${breakdown.totalTokens} tokens${breakdown.effectiveBudget !== null ? ` / ${breakdown.effectiveBudget} usable budget (${percentOf(breakdown.totalTokens, breakdown.effectiveBudget)})` : ""}`
		: "Real usage: not yet reported";
	const overshootLine = breakdown.overshootTokens > 0 ? [`Estimates exceed real total by ~${breakdown.overshootTokens} tok -- sizes below are approximate, not exact`] : [];
	const rows = buildContextRows(breakdown);
	const rowLines = rows.length > 0 ? rows.map((row) => row.text) : ["(nothing observed yet)"];
	return [totalLine, ...overshootLine, "", ...rowLines].join("\n");
}

export async function showContextView(ctx: ExtensionCommandContext, breakdown: ContextBreakdown): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(fallbackReport(breakdown), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ContextViewport(tui, theme, breakdown, done));
}
