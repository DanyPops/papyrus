import { PAPYRUS_VEHICLE_NAME } from "@danypops/papyrus";
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Hidden at 0, matching TaskOverlay's own "nothing open" hiding rule. */
export function renderNoteWidgetLines(theme: Theme, openCount: number, width: number): string[] {
	if (openCount === 0) return [];
	const header = theme.fg("muted", vehicleWidgetTitle(PAPYRUS_VEHICLE_NAME, "Notes"));
	return [truncateToWidth(`${header} ${theme.fg("accent", String(openCount))}`, width, "…")];
}
