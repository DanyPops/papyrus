import type { WidgetSection } from "malevich-tui-components";

/**
 * Notes has no body rows of its own -- the open count lives on the section's own label. undefined
 * (hide the section entirely) at 0, matching TaskOverlay's own "nothing open" hiding rule.
 * Deliberately one uniform label string, not an embedded differently-colored count: the caller's
 * own section `style` wraps this whole branch line, and nesting a second color inside it here
 * would risk incorrect ANSI reset composition -- every other section label in this widget group
 * stays one tone for the same reason.
 */
export function buildNoteWidgetSection(openCount: number): WidgetSection | undefined {
	if (openCount === 0) return undefined;
	return { label: `Notes ${openCount}`, render: () => [] };
}
