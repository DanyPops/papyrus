import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Hidden at 0, matching TaskOverlay's own "nothing open" hiding rule. */
export function renderNoteWidgetLines(theme: Theme, openCount: number, width: number): string[] {
	if (openCount === 0) return [];
	return [truncateToWidth(`${theme.fg("muted", "Notes")} ${theme.fg("accent", String(openCount))}`, width, "…")];
}
