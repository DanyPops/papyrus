import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * A real ANSI-emitting theme, matching production Theme.fg/bg exactly (narrow
 * resets only -- \x1b[39m for fg, \x1b[49m for bg -- never a full \x1b[0m).
 * A bracket-tag fixture (e.g. "[accent]text[/accent]") can never exercise
 * whether wrapping correctly preserves ANSI state across lines -- only a real
 * escape code can expose that class of bug.
 */
export function realAnsiTheme(): Theme {
	return {
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		fg: (_color: string, text: string) => `\x1b[38;2;200;200;200m${text}\x1b[39m`,
	} as Theme;
}
