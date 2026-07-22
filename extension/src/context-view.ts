import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ContextBreakdown, ContextSegment, ContextSegmentItem } from "./context-budget.ts";
import { formatContextBudgetReport, type ContextBudget } from "./context-budget.ts";

const DRILLDOWN_VISIBLE_ROWS = 15;

const SEGMENT_COLORS: Record<ContextSegment["key"], ThemeColor> = {
	rules: "accent",
	tasks: "success",
	skills: "mdLink",
	basePrompt: "warning",
	messageHistory: "syntaxFunction",
	other: "muted",
};

function formatTokenCount(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function percentOf(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

/**
 * Renders the context window as one proportional stacked bar, one colored run of block
 * characters per segment, matching each row's own swatch color below it. A zero-token
 * breakdown (nothing observed yet) renders an empty dim track rather than a divide-by-zero.
 */
export function renderContextBar(theme: Theme, segments: ReadonlyArray<ContextSegment>, width: number): string {
	const total = segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
	if (total <= 0 || width <= 0) return theme.fg("dim", "░".repeat(Math.max(0, width)));
	let used = 0;
	let output = "";
	segments.forEach((segment, index) => {
		const isLast = index === segments.length - 1;
		const cells = isLast ? width - used : Math.round((segment.estimatedTokens / total) * width);
		used += cells;
		if (cells > 0) output += theme.fg(SEGMENT_COLORS[segment.key], "█".repeat(cells));
	});
	return output;
}

class ContextViewport {
	private selectedIndex = 0;
	private drillDown: ContextSegment | null = null;
	private drillIndex = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly breakdown: ContextBreakdown,
		private readonly close: () => void,
	) {}

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
			lines.push(theme.fg("dim", "No real usage reported yet — segment sizes below are Papyrus's own estimates only"));
		}
		lines.push(renderContextBar(theme, this.breakdown.segments, contentWidth));
		lines.push("");

		if (this.drillDown) {
			lines.push(...this.renderDrillDown(contentWidth));
		} else {
			lines.push(...this.renderSegments(contentWidth));
		}
		lines.push(border);
		return lines;
	}

	private renderSegments(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const denominator = this.breakdown.totalTokens ?? this.breakdown.segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
		this.breakdown.segments.forEach((segment, index) => {
			const selected = index === this.selectedIndex;
			const cursor = selected ? theme.fg("accent", "❯") : " ";
			const swatch = theme.fg(SEGMENT_COLORS[segment.key], "██");
			const title = selected ? theme.bold(segment.label) : segment.label;
			const percent = percentOf(segment.estimatedTokens, denominator);
			const drillHint = segment.items && segment.items.length > 0 ? theme.fg("dim", ` (${segment.items.length} items — enter to expand)`) : "";
			lines.push(truncateToWidth(`${cursor} ${swatch} ${segment.estimatedTokens.toString().padStart(6)} tok  ${percent.padStart(5)}  ${title}${drillHint}`, width, ""));
		});
		lines.push("");
		lines.push(theme.fg("dim", "↑↓ select · enter expand · esc close"));
		return lines;
	}

	private renderDrillDown(width: number): string[] {
		const theme = this.theme;
		const segment = this.drillDown!;
		const items: ContextSegmentItem[] = segment.items ?? [];
		const lines: string[] = [truncateToWidth(theme.fg("muted", `${segment.label} — largest first`), width, "")];
		if (items.length === 0) {
			lines.push(theme.fg("dim", "  (nothing to break down further)"));
		} else {
			const start = Math.max(0, Math.min(this.drillIndex - Math.floor(DRILLDOWN_VISIBLE_ROWS / 2), items.length - DRILLDOWN_VISIBLE_ROWS));
			const end = Math.min(start + DRILLDOWN_VISIBLE_ROWS, items.length);
			for (let index = start; index < end; index++) {
				const item = items[index]!;
				const selected = index === this.drillIndex;
				const cursor = selected ? theme.fg("accent", "❯") : " ";
				const title = selected ? theme.bold(item.label) : item.label;
				lines.push(truncateToWidth(`${cursor} ${item.estimatedTokens.toString().padStart(6)} tok  ${title}`, width, ""));
			}
			lines.push(theme.fg("muted", `  ${this.drillIndex + 1}/${items.length}`));
		}
		lines.push("");
		lines.push(theme.fg("dim", "↑↓ scroll · esc back"));
		return lines;
	}

	handleInput(data: string): void {
		if (this.drillDown) {
			const items = this.drillDown.items ?? [];
			if (matchesKey(data, "escape")) this.drillDown = null;
			else if (matchesKey(data, "up")) this.drillIndex = Math.max(0, this.drillIndex - 1);
			else if (matchesKey(data, "down")) this.drillIndex = Math.min(Math.max(0, items.length - 1), this.drillIndex + 1);
			else return;
		} else {
			if (matchesKey(data, "escape")) { this.close(); return; }
			if (matchesKey(data, "up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			else if (matchesKey(data, "down")) this.selectedIndex = Math.min(this.breakdown.segments.length - 1, this.selectedIndex + 1);
			else if (matchesKey(data, "enter")) {
				const segment = this.breakdown.segments[this.selectedIndex];
				if (segment?.items && segment.items.length > 0) {
					this.drillDown = segment;
					this.drillIndex = 0;
				}
			} else return;
		}
		this.tui.requestRender();
	}
}

/** Non-interactive fallback (print mode, RPC, etc.): every segment listed plainly, plus the existing per-rule/per-skill breakdown for the two segments that support drill-down. */
function fallbackReport(breakdown: ContextBreakdown, ruleBudget: ContextBudget["rules"]): string {
	const totalLine = breakdown.totalTokens !== null
		? `Real usage: ${breakdown.totalTokens} tokens${breakdown.effectiveBudget !== null ? ` / ${breakdown.effectiveBudget} usable budget (${percentOf(breakdown.totalTokens, breakdown.effectiveBudget)})` : ""}`
		: "Real usage: not yet reported";
	const denominator = breakdown.totalTokens ?? breakdown.segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
	const segmentLines = breakdown.segments.map((segment) => `  ${segment.estimatedTokens.toString().padStart(7)} tok  ${percentOf(segment.estimatedTokens, denominator).padStart(5)}  ${segment.label}`);
	const skillsSegment = breakdown.segments.find((segment) => segment.key === "skills");
	return [
		totalLine,
		"",
		"Segments:",
		...segmentLines,
		"",
		formatContextBudgetReport({ rules: ruleBudget, skills: { entries: [], totalCharacters: 0, totalEstimatedTokens: skillsSegment?.estimatedTokens ?? 0, scannedDirectories: [] }, totalEstimatedTokens: ruleBudget.totalEstimatedTokens }),
	].join("\n");
}

export async function showContextView(ctx: ExtensionCommandContext, breakdown: ContextBreakdown, ruleBudget: ContextBudget["rules"]): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(fallbackReport(breakdown, ruleBudget), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ContextViewport(tui, theme, breakdown, done));
}
