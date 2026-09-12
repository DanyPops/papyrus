import { TOOL_COLLAPSED_ROW_LIMIT } from "@danypops/papyrus";
import { expandHint } from "@danypops/vehicle-client-pi/expand-hint";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createSemanticTextDetails, type SemanticTextToolDetails } from "./render-model/semantic-text.ts";

const MAX_EXPANDED_TEXT_ROWS = 200;

/** Renders diagnostic text with host-owned styles and bounded collapsed or expanded rows. */
export class SemanticTextCard implements Component {
	private readonly details: SemanticTextToolDetails;

	constructor(
		details: SemanticTextToolDetails,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {
		const normalized = createSemanticTextDetails(details.operation, details.text);
		this.details = { ...normalized, completeness: details.completeness.truncated ? details.completeness : normalized.completeness };
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const lines = new Text(this.details.text, 0, 0).render(width);
		const limit = this.expanded ? MAX_EXPANDED_TEXT_ROWS : TOOL_COLLAPSED_ROW_LIMIT;
		const visible = lines.slice(0, limit).map((line) => truncateToWidth(this.theme.fg("toolOutput", line), width));
		const omitted = lines.length - visible.length;
		if (omitted > 0) {
			const hint = this.expanded ? `${omitted} more lines omitted · display limit` : `${omitted} more lines · ${expandHint()}`;
			visible.push(truncateToWidth(this.theme.fg("dim", hint), width));
		} else if (this.details.completeness.truncated) {
			visible.push(truncateToWidth(this.theme.fg("dim", "Output truncated"), width));
		}
		return visible;
	}

	invalidate(): void {}
}
