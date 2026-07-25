/**
 * discuss-ask-view.ts — Discuss's own live:true synchronous ask UI: searchable single-select
 * with a split-pane description preview, a checkbox multi-select, an integrated freeform
 * editor, an optional post-selection comment, overlay/inline display modes, toggle shortcuts,
 * and an auto-dismiss timeout. Owned end-to-end by Papyrus/Discuss -- no runtime dependency on
 * or delegation to another package's registered tool.
 *
 * Substantially adapted from pi-ask-user's index.ts (MIT, Copyright (c) 2026 Enzo Lucchesi --
 * full notice in THIRD_PARTY_LICENSES.md), with the standalone-tool plumbing (schema, tool
 * registration, its own event emission, malformed-options recovery for other tools' schemas)
 * removed since Discuss already owns its schema, persistence, and rendering.
 */
import type { AgentToolUpdateCallback, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	CURSOR_MARKER,
	decodeKittyPrintable,
	Editor,
	type EditorTheme,
	fuzzyFilter,
	Key,
	type Keybinding,
	type KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderSingleSelectRows, type AskOption } from "./discuss-ask-layout.ts";
import { callService } from "./service-client.ts";

/** Temporary RCA instrumentation for the live-observed duplicate-picker defect. Fire-and-forget: never lets a logging failure affect the actual ask. Remove once root-caused. */
const DIAG_SOURCE = "papyrus-discuss-ask-diag";
let diagSequence = 0;
function diag(message: string, fields?: Record<string, unknown>): void {
	void callService("logs.append", {
		source_id: DIAG_SOURCE,
		source_label: "Discuss live-ask RCA",
		level: "info",
		message,
		operation_id: `diag-${Date.now()}-${++diagSequence}`,
		...(fields ? { fields } : {}),
	}).catch((error) => {
		void callService("logs.append", {
			source_id: DIAG_SOURCE, source_label: "Discuss live-ask RCA", level: "error",
			message: `diag() itself failed: ${error instanceof Error ? error.message : String(error)}`,
			operation_id: `diag-error-${Date.now()}-${++diagSequence}`,
		}).catch(() => {});
	});
}

/** See pi-ask-user's identical safeMarkdownTheme() comment: a broken theme Proxy throws only on
 * property access, not construction, so a bare try/catch around getMarkdownTheme() alone would
 * still crash mid-render. Probing bold("") forces the throw eagerly, so callers can fall back
 * to plain Text rendering instead. */
function safeMarkdownTheme(): MarkdownTheme | undefined {
	try {
		const md = getMarkdownTheme();
		if (!md) return undefined;
		md.bold("");
		return md;
	} catch {
		return undefined;
	}
}

export type AskDisplayMode = "overlay" | "inline";

export interface AskQuestionParams {
	question: string;
	context?: string;
	options?: AskOption[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	allowComment?: boolean;
	displayMode?: AskDisplayMode;
	timeout?: number;
	/**
	 * Joins a second concurrent call for the same key to the first's in-flight promise instead of
	 * opening a second picker. Pass a stable id (the target Discussion's id) whenever the caller
	 * cannot otherwise guarantee only one live ask is ever issued for that same question.
	 */
	key?: string;
	/**
	 * Streamed once before blocking on the human. A live ask can legitimately sit pending far
	 * longer than a typical tool call (real human response time, not milliseconds) -- without any
	 * progress signal, a tool call sitting silent that long looks indistinguishable from a dead
	 * one to anything upstream watching for stalled calls. pi-ask-user's own original code (the
	 * prior art this view is adapted from) sent exactly this same heartbeat before presenting its
	 * UI; dropping it during the port was the regression that let two independent executions of
	 * the same live ask run concurrently, each opening its own picker for the same question.
	 */
	onUpdate?: AgentToolUpdateCallback;
	/**
	 * The tool call's OWN abort signal (execute()'s 3rd parameter) -- fires only if this specific
	 * tool call is genuinely interrupted (e.g. the human pressed Ctrl+C on the whole agent
	 * operation). Deliberately NOT `ExtensionContext.signal`: that one tracks "is the agent
	 * currently streaming a model response" and settles/aborts within a second or two of the
	 * assistant's tool_call message finishing generation -- which is normal, unrelated bookkeeping
	 * that happens long before a human actually answers a slow interactive prompt. A live-observed
	 * bug (the picker silently self-cancelling ~7-10s after opening, well before the human
	 * finished deciding, with their real answer then arriving disconnected as a stray follow-up)
	 * traced back to listening on the wrong signal here.
	 */
	signal?: AbortSignal;
}

export interface AskAnswer {
	content: string;
	selected?: string[];
}

type AskResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string };

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.trim().toLowerCase()) {
		case "1": case "true": case "yes": case "on": return true;
		case "0": case "false": case "no": case "off": return false;
		default: return undefined;
	}
}

function createFreeformResponse(text: string | null | undefined): AskResponse | null {
	const trimmed = text?.trim();
	return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[], comment?: string | null): AskResponse | null {
	const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
	if (normalizedSelections.length === 0) return null;
	const normalizedComment = normalizeOptionalComment(comment);
	return normalizedComment ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment } : { kind: "selection", selections: normalizedSelections };
}

function toAskAnswer(response: AskResponse): AskAnswer {
	if (response.kind === "freeform") return { content: response.text };
	const content = response.comment ? `${response.selections.join(", ")} — ${response.comment}` : response.selections.join(", ");
	return { content, selected: response.selections };
}

function formatOptionsForMessage(options: AskOption[]): string {
	return options.map((option, index) => `${index + 1}. ${option.title}${option.description ? ` — ${option.description}` : ""}`).join("\n");
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
	const label = selections.length === 1 ? "Selected option" : "Selected options";
	return `${prompt}\n\n${label}:\n${selections.map((selection) => `- ${selection}`).join("\n")}`;
}

function parseDialogSelections(input: string): string[] {
	return input.split(",").map((selection) => selection.trim()).filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

function createSelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function createEditorTheme(theme: Theme): EditorTheme {
	return { borderColor: (s: string) => theme.fg("accent", s), selectList: createSelectListTheme(theme) };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
	constructor(private color: (s: string) => string, private title?: string, private titleColor?: (s: string) => string) {}
	invalidate(): void {}
	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		if (!this.title || inner < this.title.length + 4) return [this.color(`╭${"─".repeat(inner)}╮`)];
		const label = ` ${this.title} `;
		const remaining = inner - 1 - label.length;
		const titleStyle = this.titleColor ?? this.color;
		return [this.color("╭─") + titleStyle(label) + this.color(`${"─".repeat(Math.max(0, remaining))}╮`)];
	}
}

class BoxBorderBottom implements Component {
	constructor(private color: (s: string) => string) {}
	invalidate(): void {}
	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		return [this.color(`╰${"─".repeat(inner)}╯`)];
	}
}

function formatKeyList(keys: string[]): string {
	return keys.join("/");
}

function keybindingHint(theme: Theme, keybindings: KeybindingsManager, keybinding: Keybinding, description: string): string {
	return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
	return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut = { disabled: false; spec: string; matches: (data: string) => boolean } | { disabled: true; spec: null; matches: (data: string) => false };

const DISABLED_SHORTCUT: ResolvedShortcut = { disabled: true, spec: null, matches: (() => false) as (data: string) => false };
const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const trimmed = value.trim().toLowerCase();
	return SHORTCUT_DISABLE_VALUES.has(trimmed) ? null : trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
	if (!spec) return false;
	if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
	return { disabled: false, spec, matches: (data: string) => matchesKey(data, spec as any) };
}

function resolveShortcut(paramValue: string | null | undefined, envValue: string | undefined, defaultSpec: string): ResolvedShortcut {
	for (const raw of [paramValue, envValue, defaultSpec]) {
		const normalized = normalizeShortcutSpec(raw);
		if (normalized === undefined) continue;
		if (normalized === null) return DISABLED_SHORTCUT;
		if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
	}
	return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

const OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const OVERLAY_MIN_RENDER_LINES = 8;
const OVERLAY_WIDTH = "92%";
const OVERLAY_MIN_WIDTH = 40;
const SPLIT_PANE_MIN_WIDTH = 84;
const SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type a custom answer...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";

const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");
const PROMPT_SCROLL_PAGE_UP_KEY = Key.pageUp;
const PROMPT_SCROLL_PAGE_DOWN_KEY = Key.pageDown;
const PROMPT_SCROLL_HOME_KEY = Key.home;
const PROMPT_SCROLL_END_KEY = Key.end;
const PROMPT_SCROLL_HALF_PAGE_UP_KEY = Key.ctrl("u");
const PROMPT_SCROLL_HALF_PAGE_DOWN_KEY = Key.ctrl("d");

function getOverlayMaxRenderLinesForRows(rows: number): number {
	const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	const availableRows = Math.max(1, normalizedRows - 2);
	const ratioRows = Math.max(1, Math.floor(normalizedRows * OVERLAY_MAX_HEIGHT_RATIO));
	const minimumRows = Math.min(OVERLAY_MIN_RENDER_LINES, availableRows);
	return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab")) || matchesKey(data, VIM_SELECT_UP_KEY);
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab) || matchesKey(data, VIM_SELECT_DOWN_KEY);
}

function buildCustomUIOptions(displayMode: AskDisplayMode, onHandle?: (handle: OverlayHandle) => void): { overlay?: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void } | undefined {
	if (displayMode === "inline") return undefined;
	return {
		overlay: true,
		overlayOptions: { anchor: "center" as const, width: OVERLAY_WIDTH, minWidth: OVERLAY_MIN_WIDTH, maxHeight: "85%", margin: 1 },
		...(onHandle ? { onHandle } : {}),
	};
}

class MultiSelectList implements Component {
	private selectedIndex = 0;
	private checked = new Set<number>();
	private commentEnabled = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string[]) => void;
	public onEnterFreeform?: () => void;

	constructor(
		private options: AskOption[],
		private allowFreeform: boolean,
		private allowComment: boolean,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private commentToggle: ResolvedShortcut,
	) {}

	public isCommentEnabled(): boolean { return this.commentEnabled; }
	invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }

	private getItemCount(): number { return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0); }
	private getCommentToggleIndex(): number | null { return this.allowComment ? this.options.length : null; }
	private getFreeformIndex(): number { return this.options.length + (this.allowComment ? 1 : 0); }
	private isCommentToggleRow(index: number): boolean { const i = this.getCommentToggleIndex(); return i !== null && index === i; }
	private isFreeformRow(index: number): boolean { return this.allowFreeform && index === this.getFreeformIndex(); }

	private toggle(index: number): void {
		if (index < 0 || index >= this.options.length) return;
		if (this.checked.has(index)) this.checked.delete(index); else this.checked.add(index);
	}

	private toggleComment(): void {
		if (!this.allowComment) return;
		this.commentEnabled = !this.commentEnabled;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) { this.onCancel?.(); return; }
		const count = this.getItemCount();
		if (count === 0) { this.onCancel?.(); return; }
		if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) { this.toggleComment(); return; }

		if (matchesSelectUp(data, this.keybindings)) { this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1; this.invalidate(); return; }
		if (matchesSelectDown(data, this.keybindings)) { this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1; this.invalidate(); return; }

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < this.options.length) { this.toggle(idx); this.selectedIndex = Math.min(idx, count - 1); this.invalidate(); }
			return;
		}

		if (matchesKey(data, Key.space)) {
			if (this.isCommentToggleRow(this.selectedIndex)) { this.toggleComment(); return; }
			if (this.isFreeformRow(this.selectedIndex)) { this.onEnterFreeform?.(); return; }
			this.toggle(this.selectedIndex);
			this.invalidate();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.isCommentToggleRow(this.selectedIndex)) { this.toggleComment(); return; }
			if (this.isFreeformRow(this.selectedIndex)) { this.onEnterFreeform?.(); return; }
			const selectedTitles = [...this.checked].sort((a, b) => a - b).map((i) => this.options[i]?.title).filter((t): t is string => !!t);
			const fallback = this.options[this.selectedIndex]?.title;
			const result = selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];
			if (result.length > 0) this.onSubmit?.(result); else this.onCancel?.();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const count = this.getItemCount();
		const maxVisible = Math.min(count, 10);
		if (count === 0) { this.cachedLines = [theme.fg("warning", "No options")]; this.cachedWidth = width; return this.cachedLines; }

		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, count);
		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→") : " ";

			if (this.isCommentToggleRow(i)) {
				const checkbox = this.commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
				const label = isSelected ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL)) : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
				lines.push(truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""));
				continue;
			}
			if (this.isFreeformRow(i)) {
				const label = theme.fg("text", theme.bold("Type something."));
				const desc = theme.fg("muted", "Enter a custom response");
				lines.push(truncateToWidth(`${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`, width, ""));
				continue;
			}
			const option = this.options[i];
			if (!option) continue;
			const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
			const num = theme.fg("dim", `${i + 1}.`);
			const title = isSelected ? theme.fg("accent", theme.bold(option.title)) : theme.fg("text", theme.bold(option.title));
			lines.push(truncateToWidth(`${prefix} ${num} ${checkbox} ${title}`, width, ""));
			if (option.description) {
				const indent = "      ";
				for (const w of wrapTextWithAnsi(option.description, Math.max(10, width - indent.length))) lines.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
			}
		}

		if (startIndex > 0 || endIndex < count) lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

class WrappedSingleSelectList implements Component {
	private selectedIndex = 0;
	private searchQuery = "";
	private commentEnabled = false;
	private maxVisibleRows = 12;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;
	public onEnterFreeform?: () => void;

	constructor(
		private options: AskOption[],
		private allowFreeform: boolean,
		private allowComment: boolean,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private commentToggle: ResolvedShortcut,
	) {}

	public isCommentEnabled(): boolean { return this.commentEnabled; }
	setMaxVisibleRows(rows: number): void {
		const next = Math.max(1, Math.floor(rows));
		if (next !== this.maxVisibleRows) { this.maxVisibleRows = next; this.invalidate(); }
	}
	invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }

	private getFilteredOptions(): AskOption[] {
		return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
	}
	private getItemCount(filteredOptions: AskOption[]): number { return filteredOptions.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0); }
	private isCommentToggleRow(index: number, filteredOptions: AskOption[]): boolean { return this.allowComment && index === filteredOptions.length; }
	private isFreeformRow(index: number, filteredOptions: AskOption[]): boolean { return this.allowFreeform && index === filteredOptions.length + (this.allowComment ? 1 : 0); }

	private toggleComment(): void {
		if (!this.allowComment) return;
		this.commentEnabled = !this.commentEnabled;
		this.invalidate();
	}
	private setSearchQuery(query: string): void { this.searchQuery = query; this.selectedIndex = 0; this.invalidate(); }
	private popSearchCharacter(): void {
		if (!this.searchQuery) return;
		const characters = [...this.searchQuery];
		characters.pop();
		this.setSearchQuery(characters.join(""));
	}

	private getPrintableInput(data: string): string | null {
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) return kittyPrintable;
		const characters = [...data];
		if (characters.length !== 1) return null;
		const [character] = characters;
		if (!character) return null;
		const code = character.charCodeAt(0);
		if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return null;
		return character;
	}

	private styleListLine(line: string, width: number, isSelected: boolean): string {
		const trimmed = line.trim();
		if (trimmed.startsWith("(")) return truncateToWidth(this.theme.fg("dim", line), width, "");
		if (isSelected) return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
		if (line.startsWith("      ")) return truncateToWidth(this.theme.fg("muted", line), width, "");
		if (line.startsWith("→")) return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
		return truncateToWidth(this.theme.fg("text", line), width, "");
	}

	private getSplitPaneWidths(width: number): { left: number; right: number } | null {
		if (width < SPLIT_PANE_MIN_WIDTH) return null;
		const availableWidth = width - SPLIT_PANE_SEPARATOR.length;
		if (availableWidth < SPLIT_PANE_LEFT_MIN_WIDTH + SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
		const preferredLeftWidth = Math.floor(availableWidth * 0.42);
		const left = Math.max(SPLIT_PANE_LEFT_MIN_WIDTH, Math.min(preferredLeftWidth, availableWidth - SPLIT_PANE_RIGHT_MIN_WIDTH));
		const right = availableWidth - left;
		return right < SPLIT_PANE_RIGHT_MIN_WIDTH ? null : { left, right };
	}

	private buildListLines(width: number, filteredOptions: AskOption[], hideDescriptions = false): string[] {
		const lines: string[] = [];
		const count = this.getItemCount(filteredOptions);
		const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
		lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));
		if (this.searchQuery && filteredOptions.length === 0) lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
		if (count === 0) {
			if (!this.searchQuery) lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
			return lines.slice(0, this.maxVisibleRows);
		}
		const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
		const optionRows = renderSingleSelectRows({
			options: filteredOptions, selectedIndex: this.selectedIndex, width, allowFreeform: this.allowFreeform,
			allowComment: this.allowComment, commentEnabled: this.commentEnabled, maxRows, hideDescriptions,
		});
		lines.push(...optionRows.map((row) => this.styleListLine(row.line, width, row.selected)));
		return lines.slice(0, this.maxVisibleRows);
	}

	private buildPreviewLines(width: number, filteredOptions: AskOption[], maxLines: number): string[] {
		if (maxLines <= 0) return [];
		const mdTheme = safeMarkdownTheme();
		let md = "";
		if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
			md += "## Additional context\n\n";
			md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
			md += "Turn this on when the selected option needs extra explanation before it submits.\n";
		} else if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
			md += "## Custom answer\n\nOpen the editor to write **any** answer.\n\n*Use this when none of the listed options fit.*\n";
			if (this.searchQuery) md += `\n> Current filter: \`${this.searchQuery}\`\n`;
		} else {
			const selected = filteredOptions[this.selectedIndex];
			if (!selected) {
				md += "*No option selected*\n";
			} else {
				md += `## ${selected.title}\n\n`;
				md += selected.description?.trim() ? `${selected.description}\n` : "*No additional details provided for this option.*\n";
				md += "\n---\n\nPress `Enter` to select this option.\n";
				if (this.searchQuery) md += `\n> Filter: \`${this.searchQuery}\`\n`;
			}
		}

		let lines: string[];
		if (mdTheme) {
			lines = new Markdown(md.trim(), 0, 0, mdTheme).render(width);
		} else {
			lines = wrapTextWithAnsi(md.trim(), Math.max(10, width)).map((line) => truncateToWidth(line, width, ""));
		}
		while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
		if (lines.length <= maxLines) return lines;
		if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];
		const visibleLines = lines.slice(0, maxLines - 1);
		visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
		return visibleLines;
	}

	handleInput(data: string): void {
		if (this.searchQuery && matchesKey(data, Key.escape)) { this.setSearchQuery(""); return; }
		if (this.keybindings.matches(data, "tui.select.cancel")) { this.onCancel?.(); return; }
		if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) { this.toggleComment(); return; }

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);

		if (matchesSelectUp(data, this.keybindings) && count > 0) { this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1; this.invalidate(); return; }
		if (matchesSelectDown(data, this.keybindings) && count > 0) { this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1; this.invalidate(); return; }

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch && filteredOptions.length > 0) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < filteredOptions.length) { this.selectedIndex = idx; this.invalidate(); return; }
		}

		if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex, filteredOptions)) { this.toggleComment(); return; }

		if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
			if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) { this.toggleComment(); return; }
			if (this.isFreeformRow(this.selectedIndex, filteredOptions)) { this.onEnterFreeform?.(); return; }
			const result = filteredOptions[this.selectedIndex]?.title;
			if (result) this.onSubmit?.(result); else this.onCancel?.();
			return;
		}

		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) { this.popSearchCharacter(); return; }

		const printableInput = this.getPrintableInput(data);
		if (printableInput) this.setSearchQuery(this.searchQuery + printableInput);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);
		this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

		const splitPane = this.getSplitPaneWidths(width);
		let lines: string[];
		if (!splitPane) {
			lines = this.buildListLines(width, filteredOptions);
		} else {
			const listLines = this.buildListLines(splitPane.left, filteredOptions, true);
			const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
			const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
			const separator = this.theme.fg("dim", SPLIT_PANE_SEPARATOR);
			lines = Array.from({ length: rowCount }, (_, index) => `${truncateToWidth(listLines[index] ?? "", splitPane.left, "", true)}${separator}${truncateToWidth(previewLines[index] ?? "", splitPane.right, "")}`);
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

interface ResolvedAskShortcuts {
	overlayToggle: ResolvedShortcut;
	commentToggle: ResolvedShortcut;
}

/** Root Container: swaps between select (single/multi) and an Editor (freeform/comment). */
class AskComponent extends Container {
	private mode: AskMode = "select";
	private pendingSelections: string[] = [];
	private freeformDraft = "";
	private commentDraft = "";
	private promptScrollOffset = 0;
	private promptMaxScrollOffset = 0;
	private promptViewportRows = 0;

	private titleText: Text;
	private questionText: Text;
	private contextComponent?: Component;
	private modeContainer: Container;
	private helpText: Text;

	private singleSelectList?: WrappedSingleSelectList;
	private multiSelectList?: MultiSelectList;
	private editor?: Editor;

	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor && (this.mode === "freeform" || this.mode === "comment")) (this.editor as any).focused = value;
	}

	constructor(
		private question: string,
		private context: string | undefined,
		private options: AskOption[],
		private allowMultiple: boolean,
		private allowFreeform: boolean,
		private allowComment: boolean,
		private displayMode: AskDisplayMode,
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private shortcuts: ResolvedAskShortcuts,
		private onDone: (result: AskResponse | null) => void,
	) {
		super();
		this.addChild(new BoxBorderTop((s) => theme.fg("accent", s), "discuss", (s) => theme.fg("dim", theme.bold(s))));
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.questionText = new Text("", 1, 0);
		this.addChild(this.questionText);

		if (this.context) {
			this.addChild(new Spacer(1));
			const mdTheme = safeMarkdownTheme();
			this.contextComponent = mdTheme ? new Markdown("", 1, 0, mdTheme) : new Text("", 1, 0);
			this.addChild(this.contextComponent);
		}

		this.addChild(new Spacer(1));
		this.modeContainer = new Container();
		this.addChild(this.modeContainer);
		this.addChild(new Spacer(1));
		this.helpText = new Text("", 1, 0);
		this.addChild(this.helpText);
		this.addChild(new Spacer(1));
		this.addChild(new BoxBorderBottom((s) => theme.fg("accent", s)));

		this.updateStaticText();
		this.showSelectMode();
	}

	override invalidate(): void { super.invalidate(); this.updateStaticText(); this.updateHelpText(); }

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
		if (this.displayMode === "overlay") return this.renderOverlayLayout(width, innerWidth);
		if (this.mode === "select" && !this.allowMultiple) this.ensureSingleSelectList().setMaxVisibleRows(12);
		return this.frameRawLines(super.render(innerWidth), width, innerWidth);
	}

	private getOverlayMaxRenderLines(): number {
		const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
		return getOverlayMaxRenderLinesForRows(rows);
	}

	private renderOverlayLayout(width: number, innerWidth: number): string[] {
		const maxLines = this.getOverlayMaxRenderLines();
		if (maxLines <= 1) return [this.renderTopBorder(width)];
		if (maxLines === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];

		const bodyCapacity = Math.max(0, maxLines - 2);
		const promptLines = this.buildPromptLines(innerWidth);
		const helpFullLines = this.helpText.render(innerWidth);
		const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpFullLines.length);
		const contentRows = Math.max(0, bodyCapacity - helpBudget);

		let promptBudget = 0;
		let modeBudget = 0;
		let separatorRows = 0;

		if (this.mode === "select") {
			separatorRows = contentRows >= 4 ? 1 : 0;
			const promptAndModeRows = Math.max(0, contentRows - separatorRows);
			promptBudget = promptAndModeRows;
			if (promptAndModeRows > 0) {
				const promptMinRows = promptLines.length > 0 ? 1 : 0;
				const maximumModeRows = Math.max(0, promptAndModeRows - promptMinRows);
				const modeMinRows = Math.min(this.getMinimumModeRows(), maximumModeRows);
				modeBudget = Math.min(this.getPreferredModeRows(), maximumModeRows);
				modeBudget = Math.max(modeMinRows, modeBudget);
				promptBudget = promptAndModeRows - modeBudget;
				const usefulPromptRows = Math.min(promptLines.length, promptAndModeRows >= modeMinRows + 2 ? 2 : promptMinRows);
				if (promptBudget < usefulPromptRows && modeBudget > modeMinRows) {
					const shiftedRows = Math.min(usefulPromptRows - promptBudget, modeBudget - modeMinRows);
					modeBudget -= shiftedRows;
					promptBudget += shiftedRows;
				}
			}
		} else {
			modeBudget = Math.min(this.getPreferredModeRows(), contentRows);
			modeBudget = Math.max(Math.min(this.getMinimumModeRows(), contentRows), modeBudget);
			promptBudget = Math.max(0, contentRows - modeBudget);
			if (promptBudget > 0 && modeBudget > 0) { separatorRows = 1; promptBudget = Math.max(0, promptBudget - separatorRows); }
		}

		const modeLines = this.renderModeLines(innerWidth, modeBudget);
		if (modeLines.length < modeBudget) promptBudget += modeBudget - modeLines.length;

		const promptPaneLines = this.renderPromptPane(promptLines, promptBudget, innerWidth);
		const helpLines = this.limitLines(helpFullLines, helpBudget, innerWidth, false);
		const bodyLines = [
			...promptPaneLines,
			...(separatorRows > 0 && promptPaneLines.length > 0 && modeLines.length > 0 ? [""] : []),
			...modeLines,
			...helpLines,
		];
		return this.frameBodyLines(bodyLines.slice(0, bodyCapacity), width, innerWidth);
	}

	private buildPromptLines(width: number): string[] {
		return [...this.titleText.render(width), ...this.questionText.render(width), ...(this.contextComponent ? ["", ...this.contextComponent.render(width)] : [])];
	}

	private getOverlayHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
		if (renderedHelpRows <= 0 || bodyCapacity <= 0) return 0;
		return bodyCapacity >= 12 ? Math.min(2, renderedHelpRows) : 1;
	}

	private getMinimumModeRows(): number {
		if (this.mode === "freeform") return 5;
		if (this.mode === "comment") return 6;
		return this.allowMultiple ? 3 : 4;
	}

	private getPreferredModeRows(): number {
		if (this.mode === "freeform") return 10;
		if (this.mode === "comment") return 11;
		return 8;
	}

	private renderModeLines(width: number, budget: number): string[] {
		const safeBudget = Math.max(0, Math.floor(budget));
		if (safeBudget <= 0) return [];
		if (this.mode === "select") {
			if (!this.allowMultiple) this.ensureSingleSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
			return this.limitLines(this.modeContainer.render(width), safeBudget, width, true);
		}
		return this.renderEditorModeLines(width, safeBudget);
	}

	private renderEditorModeLines(width: number, budget: number): string[] {
		const headerLines = this.buildEditorModeHeaderLines(width);
		const minimumEditorRows = Math.min(3, budget);
		const headerBudget = Math.max(0, budget - minimumEditorRows);
		const visibleHeaderLines = this.limitLines(headerLines, headerBudget, width, true);
		const editorBudget = Math.max(0, budget - visibleHeaderLines.length);
		return [...visibleHeaderLines, ...this.limitEditorLines(this.ensureEditor().render(width), editorBudget, width)];
	}

	private buildEditorModeHeaderLines(width: number): string[] {
		if (this.mode === "comment") {
			const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
			return [
				...new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0).render(width),
				...new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0).render(width),
				"",
			];
		}
		return [...new Text(this.theme.fg("accent", this.theme.bold("Custom answer")), 1, 0).render(width), ""];
	}

	private limitEditorLines(lines: string[], budget: number, width: number): string[] {
		const safeBudget = Math.max(0, Math.floor(budget));
		if (safeBudget <= 0) return [];
		if (lines.length <= safeBudget) return lines.map((line) => truncateToWidth(line, width, "", true));
		if (safeBudget === 1) return [this.theme.fg("dim", "…")];

		const topBorder = truncateToWidth(lines[0] ?? "", width, "", true);
		const bottomBorder = truncateToWidth(lines[lines.length - 1] ?? "", width, "", true);
		if (safeBudget === 2) return [topBorder, bottomBorder];

		const contentLines = lines.slice(1, -1);
		const contentBudget = safeBudget - 2;
		const cursorLineIndex = contentLines.findIndex((line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"));
		const maxStart = Math.max(0, contentLines.length - contentBudget);
		const start = cursorLineIndex >= 0 ? Math.max(0, Math.min(cursorLineIndex - contentBudget + 1, maxStart)) : maxStart;
		const visibleContentLines = contentLines.slice(start, start + contentBudget);
		const markedContentLines = this.applyPromptOverflowMarkers(visibleContentLines, width, start > 0, start + contentBudget < contentLines.length);
		return [topBorder, ...markedContentLines, bottomBorder];
	}

	private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
		const viewportRows = Math.max(0, Math.floor(budget));
		this.promptViewportRows = viewportRows;
		if (viewportRows <= 0 || promptLines.length === 0) { this.promptMaxScrollOffset = 0; this.promptScrollOffset = 0; return []; }
		this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
		this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScrollOffset));
		const visibleLines = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + viewportRows);
		return this.applyPromptOverflowMarkers(visibleLines, width, this.promptScrollOffset > 0, this.promptScrollOffset + viewportRows < promptLines.length);
	}

	private applyPromptOverflowMarkers(lines: string[], width: number, hasHiddenAbove: boolean, hasHiddenBelow: boolean): string[] {
		if (lines.length === 0) return lines;
		const marked = [...lines];
		if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) { marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↕", width); return marked; }
		if (hasHiddenAbove) marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↑", width);
		if (hasHiddenBelow) { const lastIndex = marked.length - 1; marked[lastIndex] = this.addPromptOverflowMarker(marked[lastIndex] ?? "", "↓", width); }
		return marked;
	}

	private addPromptOverflowMarker(line: string, marker: string, width: number): string {
		return truncateToWidth(`${this.theme.fg("dim", marker)} ${line}`, width, "", true);
	}

	private limitLines(lines: string[], budget: number, width: number, showOverflowMarker: boolean): string[] {
		const safeBudget = Math.max(0, Math.floor(budget));
		if (safeBudget <= 0) return [];
		if (lines.length <= safeBudget) return lines.map((line) => truncateToWidth(line, width, "", true));
		if (!showOverflowMarker) return lines.slice(0, safeBudget).map((line) => truncateToWidth(line, width, "", true));
		if (safeBudget === 1) return [this.theme.fg("dim", "…")];
		return [...lines.slice(0, safeBudget - 1).map((line) => truncateToWidth(line, width, "", true)), this.theme.fg("dim", "…")];
	}

	private renderTopBorder(width: number): string {
		return new BoxBorderTop((s) => this.theme.fg("accent", s), "discuss", (s) => this.theme.fg("dim", this.theme.bold(s))).render(width)[0] ?? "";
	}

	private renderBottomBorder(width: number): string {
		return new BoxBorderBottom((s) => this.theme.fg("accent", s)).render(width)[0] ?? "";
	}

	private frameBodyLines(bodyLines: string[], width: number, innerWidth: number): string[] {
		const borderColor = (s: string) => this.theme.fg("accent", s);
		return [
			this.renderTopBorder(width),
			...bodyLines.map((line) => `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`),
			this.renderBottomBorder(width),
		];
	}

	private frameRawLines(rawLines: string[], width: number, innerWidth: number): string[] {
		const borderColor = (s: string) => this.theme.fg("accent", s);
		return rawLines.map((line, index) => {
			if (index === 0) return this.renderTopBorder(width);
			if (index === rawLines.length - 1) return this.renderBottomBorder(width);
			return `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`;
		});
	}

	private updateStaticText(): void {
		const theme = this.theme;
		this.titleText.setText(theme.fg("accent", theme.bold(this.mode === "comment" ? "Optional comment" : "Question")));
		this.questionText.setText(theme.fg("text", theme.bold(this.question)));
		if (this.contextComponent && this.context) {
			if (this.contextComponent instanceof Markdown) (this.contextComponent as Markdown).setText(`**Context:**\n${this.context}`);
			else (this.contextComponent as Text).setText(`${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`);
		}
	}

	private updateHelpText(): void {
		const theme = this.theme;
		const overlayHint = this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide") : null;
		const promptScrollHint = this.displayMode === "overlay" ? literalHint(theme, "PgUp/PgDn", "prompt") : null;
		const commentHint = this.allowComment && !this.shortcuts.commentToggle.disabled ? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context") : null;

		if (this.mode === "freeform" || this.mode === "comment") {
			const alternateCancelKeys = this.keybindings.getKeys("tui.select.cancel").filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : "submit"),
				keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
				literalHint(theme, "esc", "back"),
				overlayHint,
				alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
			].filter((hint): hint is string => !!hint).join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
			return;
		}

		if (this.allowMultiple) {
			const hints = [
				literalHint(theme, "↑↓", "navigate"), literalHint(theme, "space", "toggle"), commentHint, promptScrollHint, overlayHint,
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
				keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
			].filter((hint): hint is string => !!hint).join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		} else {
			const alternateCancelKeys = this.keybindings.getKeys("tui.select.cancel").filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				literalHint(theme, "type", "filter"), commentHint, promptScrollHint,
				keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
				literalHint(theme, "↑↓", "navigate"), overlayHint,
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
				literalHint(theme, "esc", "clear/cancel"),
				alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
			].filter((hint): hint is string => !!hint).join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		}
	}

	private ensureSingleSelectList(): WrappedSingleSelectList {
		if (this.singleSelectList) return this.singleSelectList;
		const list = new WrappedSingleSelectList(this.options, this.allowFreeform, this.allowComment, this.theme, this.keybindings, this.shortcuts.commentToggle);
		list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
		list.onCancel = () => { diag("single-select onCancel fired (tui.select.cancel keybinding matched)"); this.onDone(null); };
		list.onEnterFreeform = () => this.showFreeformMode();
		this.singleSelectList = list;
		return list;
	}

	private ensureMultiSelectList(): MultiSelectList {
		if (this.multiSelectList) return this.multiSelectList;
		const list = new MultiSelectList(this.options, this.allowFreeform, this.allowComment, this.theme, this.keybindings, this.shortcuts.commentToggle);
		list.onCancel = () => this.onDone(null);
		list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled());
		list.onEnterFreeform = () => this.showFreeformMode();
		this.multiSelectList = list;
		return list;
	}

	private ensureEditor(): Editor {
		if (this.editor) return this.editor;
		const editor = new Editor(this.tui, createEditorTheme(this.theme));
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => this.handleEditorSubmit(text);
		this.editor = editor;
		return editor;
	}

	private saveEditorDraft(): void {
		if (!this.editor) return;
		const getText = (this.editor as any).getText;
		if (typeof getText !== "function") return;
		const currentText = String(getText.call(this.editor) ?? "");
		if (this.mode === "freeform") this.freeformDraft = currentText;
		else if (this.mode === "comment") this.commentDraft = currentText;
	}

	private setEditorText(text: string): void {
		const editor = this.ensureEditor();
		const setText = (editor as any).setText;
		if (typeof setText === "function") setText.call(editor, text);
	}

	private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
		if (this.allowComment && wantsComment) { this.pendingSelections = selections; this.commentDraft = ""; this.showCommentMode(); return; }
		this.onDone(createSelectionResponse(selections));
	}

	private handleEditorSubmit(text: string): void {
		if (this.mode === "freeform") { this.onDone(createFreeformResponse(text)); return; }
		if (this.mode === "comment") { this.commentDraft = text; this.onDone(createSelectionResponse(this.pendingSelections, text)); }
	}

	private showSelectMode(): void {
		if (this.mode === "freeform" || this.mode === "comment") this.saveEditorDraft();
		this.mode = "select";
		this.pendingSelections = [];
		this.modeContainer.clear();
		this.modeContainer.addChild(this.allowMultiple ? this.ensureMultiSelectList() : this.ensureSingleSelectList());
		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	private showFreeformMode(): void {
		if (this.mode === "comment") this.saveEditorDraft();
		this.mode = "freeform";
		this.modeContainer.clear();
		const editor = this.ensureEditor();
		this.setEditorText(this.freeformDraft);
		(editor as any).focused = this._focused;
		this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom answer")), 1, 0));
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);
		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	private showCommentMode(): void {
		if (this.mode === "freeform") this.saveEditorDraft();
		this.mode = "comment";
		this.modeContainer.clear();
		const editor = this.ensureEditor();
		this.setEditorText(this.commentDraft);
		(editor as any).focused = this._focused;
		const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
		this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
		this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);
		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	private setPromptScrollOffset(nextOffset: number): boolean {
		if (this.displayMode !== "overlay" || this.promptMaxScrollOffset <= 0) return false;
		const clamped = Math.max(0, Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset));
		const changed = clamped !== this.promptScrollOffset;
		this.promptScrollOffset = clamped;
		return changed;
	}

	private handlePromptScrollInput(data: string): boolean {
		if (this.displayMode !== "overlay" || this.promptMaxScrollOffset <= 0) return false;
		if (this.mode !== "select") return false;
		const pageRows = Math.max(1, this.promptViewportRows - 1);
		const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
		if (matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY)) { this.setPromptScrollOffset(this.promptScrollOffset - pageRows); return true; }
		if (matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY)) { this.setPromptScrollOffset(this.promptScrollOffset + pageRows); return true; }
		if (matchesKey(data, PROMPT_SCROLL_HOME_KEY)) { this.setPromptScrollOffset(0); return true; }
		if (matchesKey(data, PROMPT_SCROLL_END_KEY)) { this.setPromptScrollOffset(this.promptMaxScrollOffset); return true; }
		if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_UP_KEY)) { this.setPromptScrollOffset(this.promptScrollOffset - halfPageRows); return true; }
		if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY)) { this.setPromptScrollOffset(this.promptScrollOffset + halfPageRows); return true; }
		return false;
	}

	handleInput(data: string): void {
		if (this.handlePromptScrollInput(data)) { this.tui.requestRender(); return; }
		if (this.mode === "freeform" || this.mode === "comment") {
			if (matchesKey(data, Key.escape)) { this.showSelectMode(); return; }
			if (this.keybindings.matches(data, "tui.select.cancel")) { this.onDone(null); return; }
			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.allowMultiple) { this.ensureMultiSelectList().handleInput?.(data); this.tui.requestRender(); return; }
		this.ensureSingleSelectList().handleInput?.(data);
		this.tui.requestRender();
	}
}

/** RPC/headless fallback: ctx.ui.custom() returns undefined outside a real TUI, so degrade to dialog methods (select/input). */
async function askViaDialogs(
	ui: { select: Function; input: Function },
	question: string,
	context: string | undefined,
	options: AskOption[],
	allowMultiple: boolean,
	allowFreeform: boolean,
	allowComment: boolean,
	timeout?: number,
): Promise<AskResponse | null> {
	const dialogOpts = timeout ? { timeout } : undefined;
	const prompt = context ? `${question}\n\nContext:\n${context}` : question;

	if (allowMultiple) {
		const rawSelections = (await ui.input(`${prompt}\n\nOptions (select one or more):\n${formatOptionsForMessage(options)}`, "Type your selection(s)...", dialogOpts)) as string | undefined;
		if (isCancelledInput(rawSelections)) return null;
		const selections = parseDialogSelections(rawSelections);
		if (selections.length === 0) return null;
		if (!allowComment) return createSelectionResponse(selections);
		const comment = (await ui.input(buildCommentPrompt(prompt, selections), "Optional comment (press Enter to skip)...", dialogOpts)) as string | undefined;
		return createSelectionResponse(selections, comment);
	}

	const selectOptions = options.map((o) => o.title);
	if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);
	diag("askViaDialogs: calling ui.select", { dialogOpts: dialogOpts === undefined ? null : JSON.stringify(dialogOpts), promptPreview: prompt.slice(0, 80) });
	const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as string | undefined;
	diag("askViaDialogs: ui.select resolved", { selected: selected ?? null });
	if (isCancelledInput(selected)) return null;

	if (selected === FREEFORM_SENTINEL) {
		const answer = (await ui.input(prompt, "Type your answer...", dialogOpts)) as string | undefined;
		return isCancelledInput(answer) ? null : createFreeformResponse(answer);
	}

	if (!allowComment) return createSelectionResponse([selected]);
	const comment = (await ui.input(buildCommentPrompt(prompt, [selected]), "Optional comment (press Enter to skip)...", dialogOpts)) as string | undefined;
	return createSelectionResponse([selected], comment);
}

/**
 * Tracks whether a live ask is genuinely mid-flight, blocked on the human. `ExtensionContext.isIdle()`
 * means "not streaming a model response" -- it reads true while a slow, human-blocking tool call
 * like this one is still pending, since the model already finished emitting the tool_call and
 * is not itself generating anything. Left unguarded, that lets the active-task continuation
 * driver (extension/src/index.ts's driveActiveTasks, on agent_settled) queue a "continue the
 * active task" nudge as a `deliverAs: "nextTurn"` message while this exact live ask is still
 * awaiting an answer -- starting a second, concurrent turn that reasons about the very Discussion
 * this call is already resolving, independently of it. A live-observed bug (two pickers for the
 * same question, one orphaned and later auto-resolving with fabricated "defer" text) traced back
 * to exactly this race. driveActiveTasks checks isLiveAskPending() and skips queuing while true.
 */
let livePendingCount = 0;

export function isLiveAskPending(): boolean {
	return livePendingCount > 0;
}

/**
 * Keyed reentrancy join: whatever the exact external cause (an upstream retry, a duplicate turn,
 * anything outside code this package controls -- verified Pi's own ctx.ui.custom() is a clean,
 * single-shot, well-guarded call with no retry/timeout logic of its own), a second concurrent
 * askQuestion() call for the SAME key must never open a second picker for the same question. It
 * joins the already-in-flight promise instead. Keyed by the target Discussion's id (stable across
 * a genuine duplicate call, unlike a fresh toolCallId each retry might mint).
 */
const pendingByKey = new Map<string, Promise<AskAnswer | undefined>>();

/**
 * Discuss's live:true synchronous ask -- interactive AskComponent when a real TUI is available,
 * dialog fallback (ctx.ui.select/input) in RPC/headless mode, no-op undefined without any
 * interactive UI at all. Never fabricates an answer: cancel, timeout, and non-interactive
 * contexts all resolve to undefined.
 */
export async function askQuestion(ctx: ExtensionContext, params: AskQuestionParams): Promise<AskAnswer | undefined> {
	diag("askQuestion() called", { question: params.question, key: params.key, hasUI: ctx.hasUI, mode: ctx.mode, optionCount: params.options?.length ?? 0, alreadyPendingForKey: params.key !== undefined && pendingByKey.has(params.key) });
	if (!ctx.hasUI || !ctx.ui) return undefined;
	if (params.key !== undefined) {
		const existing = pendingByKey.get(params.key);
		if (existing) { diag("joining an already in-flight ask for this key", { key: params.key }); return existing; }
	}
	const promise = askQuestionUnguarded(ctx, params);
	if (params.key !== undefined) {
		const key = params.key;
		pendingByKey.set(key, promise);
		void promise.finally(() => {
			if (pendingByKey.get(key) === promise) pendingByKey.delete(key);
		});
	}
	return promise;
}

async function askQuestionUnguarded(ctx: ExtensionContext, params: AskQuestionParams): Promise<AskAnswer | undefined> {
	const options = params.options ?? [];
	const allowMultiple = params.allowMultiple ?? false;
	const allowFreeform = params.allowFreeform ?? true;
	const allowComment = params.allowComment ?? parseBooleanPreference(process.env["PAPYRUS_DISCUSS_ALLOW_COMMENT"]) ?? false;
	const envMode = process.env["PAPYRUS_DISCUSS_DISPLAY_MODE"]?.trim().toLowerCase();
	const envDisplayMode: AskDisplayMode | undefined = envMode === "overlay" || envMode === "inline" ? envMode : undefined;
	const displayMode: AskDisplayMode = params.displayMode ?? envDisplayMode ?? "overlay";
	const normalizedContext = params.context?.trim() || undefined;

	params.onUpdate?.({ content: [{ type: "text", text: "Waiting for human input..." }], details: undefined });
	livePendingCount += 1;
	try {
		return await askQuestionBlocking(ctx, params, options, allowMultiple, allowFreeform, allowComment, displayMode, normalizedContext);
	} finally {
		livePendingCount -= 1;
	}
}

async function askQuestionBlocking(
	ctx: ExtensionContext,
	params: AskQuestionParams,
	options: AskOption[],
	allowMultiple: boolean,
	allowFreeform: boolean,
	allowComment: boolean,
	displayMode: AskDisplayMode,
	normalizedContext: string | undefined,
): Promise<AskAnswer | undefined> {
	if (options.length === 0) {
		const prompt = normalizedContext ? `${params.question}\n\nContext:\n${normalizedContext}` : params.question;
		const answer = await ctx.ui.input(prompt, "Type your answer...", params.timeout ? { timeout: params.timeout } : undefined);
		const response = createFreeformResponse(answer);
		return response ? toAskAnswer(response) : undefined;
	}

	const shortcuts: ResolvedAskShortcuts = {
		overlayToggle: resolveShortcut(undefined, process.env["PAPYRUS_DISCUSS_OVERLAY_TOGGLE_KEY"], DEFAULT_OVERLAY_TOGGLE_KEY),
		commentToggle: resolveShortcut(undefined, process.env["PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY"], DEFAULT_COMMENT_TOGGLE_KEY),
	};

	let overlayHandle: OverlayHandle | undefined;
	let removeOverlayInputListener: (() => void) | undefined;
	let hasAnnouncedHide = false;
	let response: AskResponse | null;
	try {
		diag("factory about to construct AskComponent", { hasSignal: params.signal !== undefined, signalAlreadyAborted: params.signal?.aborted ?? null, hasExplicitTimeout: params.timeout !== undefined });
		const factory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AskResponse | null) => void) => {
			if (params.signal) params.signal.addEventListener("abort", () => { diag("tool call signal fired abort -- resolving null"); done(null); }, { once: true });
			if (params.timeout && params.timeout > 0) setTimeout(() => { diag("explicit params.timeout expired -- resolving null", { timeout: params.timeout }); done(null); }, params.timeout);
			return new AskComponent(params.question, normalizedContext, options, allowMultiple, allowFreeform, allowComment, displayMode, tui, theme, keybindings, shortcuts, done);
		};

		const overlayToggle = shortcuts.overlayToggle;
		if (displayMode === "overlay" && !overlayToggle.disabled && typeof ctx.ui.onTerminalInput === "function") {
			removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
				if (!overlayToggle.matches(data) || !overlayHandle) return undefined;
				const nextHidden = !overlayHandle.isHidden();
				overlayHandle.setHidden(nextHidden);
				if (nextHidden && !hasAnnouncedHide) { hasAnnouncedHide = true; ctx.ui.notify?.(`Question hidden — press ${overlayToggle.spec} to reopen`, "info"); }
				return { consume: true };
			});
		}

		diag("calling ctx.ui.custom()", { displayMode });
		const customResult = await ctx.ui.custom<AskResponse | null>(factory, buildCustomUIOptions(displayMode, (handle) => { overlayHandle = handle; }));
		diag("ctx.ui.custom() resolved", { wasUndefined: customResult === undefined, result: customResult === undefined ? undefined : JSON.stringify(customResult) });
		if (customResult === undefined) diag("falling back to askViaDialogs -- about to call ctx.ui.select with dialogOpts", { explicitTimeout: params.timeout ?? null });
		response = customResult !== undefined ? customResult : await askViaDialogs(ctx.ui, params.question, normalizedContext, options, allowMultiple, allowFreeform, allowComment, params.timeout);
		diag("askQuestionBlocking resolved", { response: response === null ? null : JSON.stringify(response) });
	} finally {
		removeOverlayInputListener?.();
	}

	return response ? toAskAnswer(response) : undefined;
}
