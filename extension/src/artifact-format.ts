import {
	DEFAULT_METADATA_DEPTH,
	DEFAULT_METADATA_ITEMS,
	MAX_METADATA_DEPTH,
	MAX_METADATA_ITEMS,
} from "../../src/constants.ts";

const STATUS_GLYPHS: Record<string, string> = {
	pending: "○",
	active: "●",
	done: "■",
	failed: "▲",
};

export interface MetadataFormatOptions {
	maxDepth?: number;
	maxItems?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	return JSON.stringify(value);
}

/** Render arbitrary nested artifact metadata into bounded, human-readable lines. */
export function formatMetadata(value: unknown, options: MetadataFormatOptions = {}): string[] {
	const maxDepth = Math.min(MAX_METADATA_DEPTH, Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_METADATA_DEPTH)));
	const maxItems = Math.min(MAX_METADATA_ITEMS, Math.max(1, Math.floor(options.maxItems ?? DEFAULT_METADATA_ITEMS)));
	let renderedItems = 0;

	function render(current: unknown, indent: number, depth: number): string[] {
		const pad = "  ".repeat(indent);
		if (renderedItems >= maxItems) return [`${pad}…`];
		if ((Array.isArray(current) || isRecord(current)) && depth >= maxDepth) return [`${pad}…`];

		if (Array.isArray(current)) {
			const lines: string[] = [];
			for (const item of current) {
				if (renderedItems >= maxItems) { lines.push(`${pad}…`); break; }
				renderedItems++;
				if (isRecord(item) && typeof item["title"] === "string") {
					const status = typeof item["status"] === "string" ? item["status"] : "";
					const glyph = STATUS_GLYPHS[status];
					lines.push(`${pad}- ${glyph ? `${glyph} ` : ""}${item["title"]}`);
					const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "title" && key !== "status"));
					if (Object.keys(rest).length > 0) lines.push(...render(rest, indent + 1, depth + 1));
				} else if (Array.isArray(item) || isRecord(item)) {
					lines.push(`${pad}-`);
					lines.push(...render(item, indent + 1, depth + 1));
				} else {
					lines.push(`${pad}- ${scalar(item)}`);
				}
			}
			return lines;
		}

		if (isRecord(current)) {
			const lines: string[] = [];
			for (const [key, item] of Object.entries(current)) {
				if (renderedItems >= maxItems) { lines.push(`${pad}…`); break; }
				renderedItems++;
				if (Array.isArray(item) || isRecord(item)) {
					lines.push(`${pad}${key}:`);
					lines.push(...render(item, indent + 1, depth + 1));
				} else {
					lines.push(`${pad}${key}: ${scalar(item)}`);
				}
			}
			return lines;
		}

		return [`${pad}${scalar(current)}`];
	}

	return render(value, 0, 0);
}
