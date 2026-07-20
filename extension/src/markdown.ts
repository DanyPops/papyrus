import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

export type ActiveTheme = () => Theme;
export type ActiveMarkdownTheme = () => Pick<MarkdownTheme, "highlightCode">;

function activePiMarkdownTheme(): Pick<MarkdownTheme, "highlightCode"> {
	try {
		return getMarkdownTheme();
	} catch {
		return {};
	}
}

export function createPapyrusMarkdownTheme(
	activeTheme: ActiveTheme,
	activeMarkdownTheme: ActiveMarkdownTheme = activePiMarkdownTheme,
): MarkdownTheme {
	return {
		heading: (text) => activeTheme().fg("mdHeading", text),
		link: (text) => activeTheme().fg("mdLink", text),
		linkUrl: (text) => activeTheme().fg("mdLinkUrl", text),
		code: (text) => activeTheme().fg("mdCode", text),
		codeBlock: (text) => activeTheme().fg("mdCodeBlock", text),
		codeBlockBorder: (text) => activeTheme().fg("mdCodeBlockBorder", text),
		quote: (text) => activeTheme().fg("mdQuote", text),
		quoteBorder: (text) => activeTheme().fg("mdQuoteBorder", text),
		hr: (text) => activeTheme().fg("mdHr", text),
		listBullet: (text) => activeTheme().fg("mdListBullet", text),
		bold: (text) => activeTheme().bold(text),
		italic: (text) => activeTheme().italic(text),
		strikethrough: (text) => activeTheme().strikethrough(text),
		underline: (text) => activeTheme().underline(text),
		highlightCode: (code, language) => {
			try {
				const highlighted = activeMarkdownTheme().highlightCode?.(code, language);
				if (highlighted) return highlighted;
			} catch {
				// The host theme may be unavailable in isolated rendering tests.
			}
			return code.split("\n").map((line) => activeTheme().fg("mdCodeBlock", line));
		},
	};
}

export function renderMarkdownBody(
	body: string,
	width: number,
	activeTheme: ActiveTheme,
	activeMarkdownTheme: ActiveMarkdownTheme = activePiMarkdownTheme,
): string[] {
	const markdown = new Markdown(
		body || "(no body)",
		0,
		0,
		createPapyrusMarkdownTheme(activeTheme, activeMarkdownTheme),
		{ color: (text) => activeTheme().fg("text", text) },
	);
	return markdown.render(Math.max(1, width));
}
