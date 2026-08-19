/**
 * A real Theme emitting real ANSI SGR escapes -- required whenever a test measures physical/
 * visible line width or column alignment, since a bracket-marker fake theme is not equivalent to
 * a real Theme for that purpose (a real ANSI escape's own byte length is invisible on screen; a
 * fake marker's own bracket text is not).
 */
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

const REAL_FG_COLORS: Record<ThemeColor, string> = {
	accent: "#ee0000",
	border: "#4d4d4d",
	borderAccent: "#ee0000",
	borderMuted: "#383838",
	success: "#6c9b4b",
	error: "#bd6e51",
	warning: "#dca614",
	muted: "#8f8f8f",
	dim: "#757575",
	text: "#e0e0e0",
	thinkingText: "#8f8f8f",
	userMessageText: "#e0e0e0",
	customMessageText: "#e0e0e0",
	customMessageLabel: "#876fd4",
	toolTitle: "#d39292",
	toolOutput: "#e0e0e0",
	mdHeading: "#e0e0e0",
	mdLink: "#0066cc",
	mdLinkUrl: "#0066cc",
	mdCode: "#e0e0e0",
	mdCodeBlock: "#e0e0e0",
	mdCodeBlockBorder: "#383838",
	mdQuote: "#8f8f8f",
	mdQuoteBorder: "#383838",
	mdHr: "#383838",
	mdListBullet: "#e0e0e0",
	toolDiffAdded: "#6c9b4b",
	toolDiffRemoved: "#bd6e51",
	toolDiffContext: "#8f8f8f",
	syntaxComment: "#8f8f8f",
	syntaxKeyword: "#876fd4",
	syntaxFunction: "#63bdbd",
	syntaxVariable: "#e0e0e0",
	syntaxString: "#6c9b4b",
	syntaxNumber: "#dca614",
	syntaxType: "#63bdbd",
	syntaxOperator: "#e0e0e0",
	syntaxPunctuation: "#e0e0e0",
	thinkingOff: "#8f8f8f",
	thinkingMinimal: "#8f8f8f",
	thinkingLow: "#8f8f8f",
	thinkingMedium: "#8f8f8f",
	thinkingHigh: "#8f8f8f",
	thinkingXhigh: "#8f8f8f",
	thinkingMax: "#8f8f8f",
	bashMode: "#e0e0e0",
};

const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

initTheme();

export const realTheme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
