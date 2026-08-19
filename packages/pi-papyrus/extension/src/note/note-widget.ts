import type { AutoRotatingWindow, WidgetSection } from "malevich-tui-components";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface NoteWidgetRow {
	id: string;
	title: string;
}

/** "Notes <total>" (the TRUE open count, even when fewer titles are actually kept/paged through),
 * plus a "page/total ⟳" suffix once genuinely paging -- never shown when everything already fits
 * on one page. */
function noteSectionLabel(totalOpenCount: number, rotation: AutoRotatingWindow): string {
	const base = `Notes ${totalOpenCount}`;
	return rotation.isPaging ? `${base} · ${rotation.pageIndex + 1}/${rotation.pageCount} ⟳` : base;
}

export function renderNoteSectionBodyLines(notes: readonly NoteWidgetRow[], width: number, rotation: AutoRotatingWindow): string[] {
	const { start, end } = rotation.currentPageBounds();
	return notes.slice(start, end).map((note) => truncateToWidth(`· ${note.title}`, width, "…"));
}

/**
 * `undefined` (hide the section entirely) once totalOpenCount is 0. `rotation`'s own row count is
 * kept in sync with `notes.length` here, so a caller only ever needs to pass its own current data.
 */
export function buildNoteWidgetSection(
	notes: readonly NoteWidgetRow[],
	totalOpenCount: number,
	rotation: AutoRotatingWindow,
): WidgetSection | undefined {
	if (totalOpenCount === 0) return undefined;
	rotation.setTotalRows(notes.length);
	return { label: noteSectionLabel(totalOpenCount, rotation), render: (width) => renderNoteSectionBodyLines(notes, width, rotation) };
}
