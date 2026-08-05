import { renderToTerminal } from "@danypops/pi-tui-harness";

interface CoverageGap {
	colStart: number;
	colEnd: number;
}

/**
 * Ghostty/Hashimoto-style golden assertion (see @danypops/pi-tui-harness's own
 * renderToTerminal/expectSnapshot doc comments): feeds real rendered lines through
 * a real VT parser (@xterm/headless, the same engine VS Code's terminal uses) and
 * asserts every cell across every row, up to `width`, carries an explicit
 * (non-default) background color -- the same full-width paint guarantee pi-tui's
 * own Box.applyBg gives every native tool result. A gap here is not a guess about
 * "looks transparent" -- it's the real terminal's own cell state reporting no
 * background was ever painted there.
 *
 * On failure, throws with a visual diff: a `.`/`X` map of covered vs. gap columns
 * per offending row, the row's own plain text for context, and the exact column
 * ranges left unpainted.
 */
export async function assertFullBackgroundCoverage(lines: readonly string[], width: number): Promise<void> {
	if (lines.length === 0) return;
	const terminal = await renderToTerminal(lines, { cols: width, rows: lines.length });
	try {
		const gapsByRow = new Map<number, CoverageGap[]>();
		for (let row = 0; row < lines.length; row++) {
			let gapStart: number | undefined;
			for (let col = 0; col < width; col++) {
				const cell = terminal.cellAt(row, col);
				const isGap = !cell || cell.isBgDefault;
				if (isGap && gapStart === undefined) gapStart = col;
				if (!isGap && gapStart !== undefined) {
					pushGap(gapsByRow, row, { colStart: gapStart, colEnd: col - 1 });
					gapStart = undefined;
				}
			}
			if (gapStart !== undefined) pushGap(gapsByRow, row, { colStart: gapStart, colEnd: width - 1 });
		}
		if (gapsByRow.size === 0) return;

		const plain = terminal.plainLines();
		const diff: string[] = [
			`Background coverage gap: ${gapsByRow.size} of ${lines.length} row(s) have an unpainted region (width=${width}).`,
			"",
		];
		for (const [row, gaps] of gapsByRow) {
			const marker = Array.from({ length: width }, (_, col) => (gaps.some((g) => col >= g.colStart && col <= g.colEnd) ? "X" : ".")).join(
				"",
			);
			diff.push(`row ${row}:`);
			diff.push(`  text: ${JSON.stringify(plain[row] ?? "")}`);
			diff.push(`  gap:  ${marker}`);
			for (const gap of gaps) diff.push(`    cols ${gap.colStart}-${gap.colEnd} (${gap.colEnd - gap.colStart + 1} cell(s) unpainted)`);
		}
		throw new Error(diff.join("\n"));
	} finally {
		terminal.dispose();
	}
}

function pushGap(gapsByRow: Map<number, CoverageGap[]>, row: number, gap: CoverageGap): void {
	const existing = gapsByRow.get(row);
	if (existing) existing.push(gap);
	else gapsByRow.set(row, [gap]);
}
