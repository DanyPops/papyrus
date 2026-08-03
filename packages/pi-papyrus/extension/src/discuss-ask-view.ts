/**
 * Discuss's live:true prompt orchestration: searchable single-select, checkbox multi-select,
 * freeform replies, and optional comments docked in Pi's input editor. Multi-select state and
 * viewport behavior come from Vehicle's Pi binding of Malevich; this module owns only
 * Discussion-specific modes and response mapping.
 *
 * The single-select/editor flow is adapted from pi-ask-user (MIT, Copyright (c) 2026 Enzo
 * Lucchesi; full notice in THIRD_PARTY_LICENSES.md).
 */
import {
	createMultiSelectList,
	type MultiSelectListItem,
	type MultiSelectList as SharedMultiSelectList,
} from "@danypops/vehicle-client-pi/multi-select-list";
import type { AgentToolUpdateCallback, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	decodeKittyPrintable,
	Editor,
	type EditorComponent,
	type EditorTheme,
	fuzzyFilter,
	Key,
	type Keybinding,
	type KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AskOption, renderSingleSelectRows } from "./discuss-ask-layout.ts";

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

export interface AskQuestionParams {
	question: string;
	context?: string;
	/** Plain orientation line ("which discussion is this"), shown dim above the question -- not a
	 * labeled section like context. Typically the Discussion's own title. */
	subtitle?: string;
	options?: AskOption[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	allowComment?: boolean;
	timeout?: number;
	/**
	 * Streamed once before blocking on the human, matching pi-ask-user's own original code (the
	 * prior art this view is adapted from) -- gives the tool call's progress UI something to show
	 * during a wait that legitimately runs far longer than a typical tool call (real human response
	 * time, not milliseconds).
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

type AskResponse = { kind: "selection"; selections: string[]; comment?: string } | { kind: "freeform"; text: string };

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
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
	return normalizedComment
		? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
		: { kind: "selection", selections: normalizedSelections };
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
	return input
		.split(",")
		.map((selection) => selection.trim())
		.filter(Boolean);
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
	constructor(
		private color: (s: string) => string,
		private title?: string,
		private titleColor?: (s: string) => string,
	) {}
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

type ResolvedShortcut =
	| { disabled: false; spec: string; matches: (data: string) => boolean }
	| { disabled: true; spec: null; matches: (data: string) => false };

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

// Docked in the input area: growing past this ceiling pushes the conversation transcript above
// it out of view, so the scroll keys below do real work on a long question instead of the picker
// consuming the terminal outright.
const ASK_MAX_HEIGHT_RATIO = 0.5;
const ASK_MIN_RENDER_LINES = 8;
const SPLIT_PANE_MIN_WIDTH = 84;
const SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type a custom answer...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";

const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");
const PROMPT_SCROLL_PAGE_UP_KEY = Key.pageUp;
const PROMPT_SCROLL_PAGE_DOWN_KEY = Key.pageDown;
const PROMPT_SCROLL_HOME_KEY = Key.home;
const PROMPT_SCROLL_END_KEY = Key.end;
const PROMPT_SCROLL_HALF_PAGE_UP_KEY = Key.ctrl("u");
const PROMPT_SCROLL_HALF_PAGE_DOWN_KEY = Key.ctrl("d");

function getAskMaxRenderLinesForRows(rows: number): number {
	const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	const availableRows = Math.max(1, normalizedRows - 2);
	const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_MAX_HEIGHT_RATIO));
	const minimumRows = Math.min(ASK_MIN_RENDER_LINES, availableRows);
	return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab")) || matchesKey(data, VIM_SELECT_UP_KEY);
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab) || matchesKey(data, VIM_SELECT_DOWN_KEY);
}

type DiscussionMultiSelectChoice =
	| { readonly kind: "option"; readonly option: AskOption }
	| { readonly kind: "comment" }
	| { readonly kind: "freeform" };

class DiscussionMultiSelectList implements Component {
	private readonly list: SharedMultiSelectList<DiscussionMultiSelectChoice>;
	private readonly commentIndex: number | undefined;
	private commentEnabled = false;

	public onCancel?: () => void;
	public onSubmit?: (result: string[]) => void;
	public onEnterFreeform?: () => void;

	constructor(
		options: AskOption[],
		allowFreeform: boolean,
		allowComment: boolean,
		theme: Theme,
		keybindings: KeybindingsManager,
		private readonly commentToggle: ResolvedShortcut,
	) {
		const items: Array<MultiSelectListItem<DiscussionMultiSelectChoice>> = options.map((option, index) => ({
			value: { kind: "option", option },
			label: option.title,
			...(option.description ? { description: option.description } : {}),
			...(index < 9 ? { shortcut: String(index + 1) } : {}),
			numberLabel: String(index + 1),
		}));
		if (allowComment) {
			this.commentIndex = items.length;
			items.push({
				value: { kind: "comment" },
				label: COMMENT_TOGGLE_LABEL,
				includeInSelection: false,
				confirmAction: "toggle",
				numberLabel: false,
			});
		}
		if (allowFreeform) {
			items.push({
				value: { kind: "freeform" },
				label: "Type something.",
				description: "Enter a custom response",
				toggleable: false,
				confirmAction: "activate",
				numberLabel: false,
			});
		}
		this.list = createMultiSelectList<DiscussionMultiSelectChoice>({
			items,
			theme,
			keybindings,
			onCancel: () => this.onCancel?.(),
			onToggle: (item: MultiSelectListItem<DiscussionMultiSelectChoice>, checked: boolean) => {
				if (item.value.kind === "comment") this.commentEnabled = checked;
			},
			onActivate: (item: MultiSelectListItem<DiscussionMultiSelectChoice>) => {
				if (item.value.kind === "freeform") this.onEnterFreeform?.();
			},
			onSubmit: (choices: DiscussionMultiSelectChoice[]) => {
				const titles = choices
					.filter((choice): choice is Extract<DiscussionMultiSelectChoice, { kind: "option" }> => choice.kind === "option")
					.map((choice) => choice.option.title);
				if (titles.length > 0) this.onSubmit?.(titles);
				else this.onCancel?.();
			},
		});
	}

	public isCommentEnabled(): boolean {
		return this.commentEnabled;
	}

	setMaxVisibleRows(rows: number): void {
		this.list.setMaxVisibleRows(rows);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (this.commentIndex !== undefined && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
			this.list.setChecked(this.commentIndex, !this.commentEnabled);
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return this.list.render(width);
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

	public isCommentEnabled(): boolean {
		return this.commentEnabled;
	}
	setMaxVisibleRows(rows: number): void {
		const next = Math.max(1, Math.floor(rows));
		if (next !== this.maxVisibleRows) {
			this.maxVisibleRows = next;
			this.invalidate();
		}
	}
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getFilteredOptions(): AskOption[] {
		return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
	}
	private getItemCount(filteredOptions: AskOption[]): number {
		return filteredOptions.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
	}
	private isCommentToggleRow(index: number, filteredOptions: AskOption[]): boolean {
		return this.allowComment && index === filteredOptions.length;
	}
	private isFreeformRow(index: number, filteredOptions: AskOption[]): boolean {
		return this.allowFreeform && index === filteredOptions.length + (this.allowComment ? 1 : 0);
	}

	private toggleComment(): void {
		if (!this.allowComment) return;
		this.commentEnabled = !this.commentEnabled;
		this.invalidate();
	}
	private setSearchQuery(query: string): void {
		this.searchQuery = query;
		this.selectedIndex = 0;
		this.invalidate();
	}
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
		if (this.searchQuery && filteredOptions.length === 0)
			lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
		if (count === 0) {
			if (!this.searchQuery) lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
			return lines.slice(0, this.maxVisibleRows);
		}
		const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
		const optionRows = renderSingleSelectRows({
			options: filteredOptions,
			selectedIndex: this.selectedIndex,
			width,
			allowFreeform: this.allowFreeform,
			allowComment: this.allowComment,
			commentEnabled: this.commentEnabled,
			maxRows,
			hideDescriptions,
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
		if (this.searchQuery && matchesKey(data, Key.escape)) {
			this.setSearchQuery("");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
			this.toggleComment();
			return;
		}

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);

		if (matchesSelectUp(data, this.keybindings) && count > 0) {
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}
		if (matchesSelectDown(data, this.keybindings) && count > 0) {
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch && filteredOptions.length > 0) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < filteredOptions.length) {
				this.selectedIndex = idx;
				this.invalidate();
				return;
			}
		}

		if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
			this.toggleComment();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
			if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
				this.toggleComment();
				return;
			}
			if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
				this.onEnterFreeform?.();
				return;
			}
			const result = filteredOptions[this.selectedIndex]?.title;
			if (result) this.onSubmit?.(result);
			else this.onCancel?.();
			return;
		}

		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
			this.popSearchCharacter();
			return;
		}

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
			lines = Array.from(
				{ length: rowCount },
				(_, index) =>
					`${truncateToWidth(listLines[index] ?? "", splitPane.left, "", true)}${separator}${truncateToWidth(previewLines[index] ?? "", splitPane.right, "")}`,
			);
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

interface ResolvedAskShortcuts {
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
	private multiSelectList?: DiscussionMultiSelectList;
	private editor?: Editor;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor && (this.mode === "freeform" || this.mode === "comment")) (this.editor as any).focused = value;
	}

	constructor(
		private question: string,
		private context: string | undefined,
		private subtitle: string | undefined,
		private options: AskOption[],
		private allowMultiple: boolean,
		private allowFreeform: boolean,
		private allowComment: boolean,
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private shortcuts: ResolvedAskShortcuts,
		private onDone: (result: AskResponse | null) => void,
	) {
		super();
		this.addChild(
			new BoxBorderTop(
				(s) => theme.fg("accent", s),
				"discuss",
				(s) => theme.fg("dim", theme.bold(s)),
			),
		);
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
		// A freeform-only ask (no options at all) has no select list to show -- start directly in
		// the freeform editor instead of a select mode that would have nothing to render.
		if (this.options.length === 0) this.showFreeformMode();
		else this.showSelectMode();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateStaticText();
		this.updateHelpText();
	}

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
		return this.renderBudgetedLayout(width, innerWidth);
	}

	private getAskMaxRenderLines(): number {
		const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
		return getAskMaxRenderLinesForRows(rows);
	}

	private renderBudgetedLayout(width: number, innerWidth: number): string[] {
		const maxLines = this.getAskMaxRenderLines();
		if (maxLines <= 1) return [this.renderTopBorder(width)];
		if (maxLines === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];

		const bodyCapacity = Math.max(0, maxLines - 2);
		const promptLines = this.buildPromptLines(innerWidth);
		const helpFullLines = this.helpText.render(innerWidth);
		const helpBudget = this.getHelpBudget(bodyCapacity, helpFullLines.length);
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
			if (promptBudget > 0 && modeBudget > 0) {
				separatorRows = 1;
				promptBudget = Math.max(0, promptBudget - separatorRows);
			}
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
		return [
			...this.titleText.render(width),
			...this.questionText.render(width),
			...(this.contextComponent ? ["", ...this.contextComponent.render(width)] : []),
		];
	}

	private getHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
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
			if (this.allowMultiple) this.ensureMultiSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
			else this.ensureSingleSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
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
		// Only meaningful when reached by escaping OUT of a real select list -- see showFreeformMode's
		// identical guard.
		if (this.options.length === 0) return [];
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
		const markedContentLines = this.applyPromptOverflowMarkers(
			visibleContentLines,
			width,
			start > 0,
			start + contentBudget < contentLines.length,
		);
		return [topBorder, ...markedContentLines, bottomBorder];
	}

	private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
		const viewportRows = Math.max(0, Math.floor(budget));
		this.promptViewportRows = viewportRows;
		if (viewportRows <= 0 || promptLines.length === 0) {
			this.promptMaxScrollOffset = 0;
			this.promptScrollOffset = 0;
			return [];
		}
		this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
		this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScrollOffset));
		const visibleLines = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + viewportRows);
		return this.applyPromptOverflowMarkers(
			visibleLines,
			width,
			this.promptScrollOffset > 0,
			this.promptScrollOffset + viewportRows < promptLines.length,
		);
	}

	private applyPromptOverflowMarkers(lines: string[], width: number, hasHiddenAbove: boolean, hasHiddenBelow: boolean): string[] {
		if (lines.length === 0) return lines;
		const marked = [...lines];
		if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) {
			marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↕", width);
			return marked;
		}
		if (hasHiddenAbove) marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↑", width);
		if (hasHiddenBelow) {
			const lastIndex = marked.length - 1;
			marked[lastIndex] = this.addPromptOverflowMarker(marked[lastIndex] ?? "", "↓", width);
		}
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
		return (
			new BoxBorderTop(
				(s) => this.theme.fg("accent", s),
				"discuss",
				(s) => this.theme.fg("dim", this.theme.bold(s)),
			).render(width)[0] ?? ""
		);
	}

	private renderBottomBorder(width: number): string {
		return new BoxBorderBottom((s) => this.theme.fg("accent", s)).render(width)[0] ?? "";
	}

	private frameBodyLines(bodyLines: string[], width: number, innerWidth: number): string[] {
		const borderColor = (s: string) => this.theme.fg("accent", s);
		return [
			this.renderTopBorder(width),
			...bodyLines.map(
				(line) => `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`,
			),
			this.renderBottomBorder(width),
		];
	}

	private updateStaticText(): void {
		const theme = this.theme;
		// Reuses the same slot for two different purposes: a plain "which discussion is this" subtitle
		// normally, or "Optional comment" while in comment mode. A generic "Question" header above the
		// real question text added nothing beyond what the question itself already says, and read
		// confusingly like the question text WAS the header.
		this.titleText.setText(
			this.mode === "comment" ? theme.fg("accent", theme.bold("Optional comment")) : this.subtitle ? theme.fg("dim", this.subtitle) : "",
		);
		this.questionText.setText(theme.fg("text", theme.bold(this.question)));
		if (this.contextComponent && this.context) {
			if (this.contextComponent instanceof Markdown) (this.contextComponent as Markdown).setText(`**Context:**\n${this.context}`);
			else (this.contextComponent as Text).setText(`${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`);
		}
	}

	private updateHelpText(): void {
		const theme = this.theme;
		const promptScrollHint = literalHint(theme, "PgUp/PgDn", "prompt");
		const commentHint =
			this.allowComment && !this.shortcuts.commentToggle.disabled
				? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context")
				: null;

		if (this.mode === "freeform" || this.mode === "comment") {
			const alternateCancelKeys = this.keybindings.getKeys("tui.select.cancel").filter((key) => key !== "escape" && key !== "esc");
			const canGoBack = this.options.length > 0;
			const hints = [
				keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : "submit"),
				keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
				literalHint(theme, "esc", canGoBack ? "back" : "cancel"),
				canGoBack && alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
			return;
		}

		if (this.allowMultiple) {
			const hints = [
				literalHint(theme, "↑↓", "navigate"),
				literalHint(theme, "space", "toggle"),
				commentHint,
				promptScrollHint,
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
				keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		} else {
			const alternateCancelKeys = this.keybindings.getKeys("tui.select.cancel").filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				literalHint(theme, "type", "filter"),
				commentHint,
				promptScrollHint,
				keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
				literalHint(theme, "↑↓", "navigate"),
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
				literalHint(theme, "esc", "clear/cancel"),
				alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		}
	}

	private ensureSingleSelectList(): WrappedSingleSelectList {
		if (this.singleSelectList) return this.singleSelectList;
		const list = new WrappedSingleSelectList(
			this.options,
			this.allowFreeform,
			this.allowComment,
			this.theme,
			this.keybindings,
			this.shortcuts.commentToggle,
		);
		list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
		list.onCancel = () => this.onDone(null);
		list.onEnterFreeform = () => this.showFreeformMode();
		this.singleSelectList = list;
		return list;
	}

	private ensureMultiSelectList(): DiscussionMultiSelectList {
		if (this.multiSelectList) return this.multiSelectList;
		const list = new DiscussionMultiSelectList(
			this.options,
			this.allowFreeform,
			this.allowComment,
			this.theme,
			this.keybindings,
			this.shortcuts.commentToggle,
		);
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
		if (this.allowComment && wantsComment) {
			this.pendingSelections = selections;
			this.commentDraft = "";
			this.showCommentMode();
			return;
		}
		this.onDone(createSelectionResponse(selections));
	}

	private handleEditorSubmit(text: string): void {
		if (this.mode === "freeform") {
			this.onDone(createFreeformResponse(text));
			return;
		}
		if (this.mode === "comment") {
			this.commentDraft = text;
			this.onDone(createSelectionResponse(this.pendingSelections, text));
		}
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
		// Only meaningful when reached by escaping OUT of a real select list ("instead of these
		// options, here's a custom one") -- with no options at all there's nothing to contrast
		// against, so the label is pure noise.
		if (this.options.length > 0) {
			this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom answer")), 1, 0));
			this.modeContainer.addChild(new Spacer(1));
		}
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
		if (this.promptMaxScrollOffset <= 0) return false;
		const clamped = Math.max(0, Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset));
		const changed = clamped !== this.promptScrollOffset;
		this.promptScrollOffset = clamped;
		return changed;
	}

	private handlePromptScrollInput(data: string): boolean {
		if (this.promptMaxScrollOffset <= 0) return false;
		if (this.mode !== "select") return false;
		const pageRows = Math.max(1, this.promptViewportRows - 1);
		const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
		if (matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY)) {
			this.setPromptScrollOffset(this.promptScrollOffset - pageRows);
			return true;
		}
		if (matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY)) {
			this.setPromptScrollOffset(this.promptScrollOffset + pageRows);
			return true;
		}
		if (matchesKey(data, PROMPT_SCROLL_HOME_KEY)) {
			this.setPromptScrollOffset(0);
			return true;
		}
		if (matchesKey(data, PROMPT_SCROLL_END_KEY)) {
			this.setPromptScrollOffset(this.promptMaxScrollOffset);
			return true;
		}
		if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_UP_KEY)) {
			this.setPromptScrollOffset(this.promptScrollOffset - halfPageRows);
			return true;
		}
		if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY)) {
			this.setPromptScrollOffset(this.promptScrollOffset + halfPageRows);
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		if (this.handlePromptScrollInput(data)) {
			this.tui.requestRender();
			return;
		}
		if (this.mode === "freeform" || this.mode === "comment") {
			// A freeform-only ask has no select mode to go back to -- escape cancels outright.
			if (matchesKey(data, Key.escape)) {
				if (this.options.length > 0) this.showSelectMode();
				else this.onDone(null);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.onDone(null);
				return;
			}
			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.allowMultiple) {
			this.ensureMultiSelectList().handleInput?.(data);
			this.tui.requestRender();
			return;
		}
		this.ensureSingleSelectList().handleInput?.(data);
		this.tui.requestRender();
	}
}

/** Plain dialog fallback (select/input) for a UI mode without setEditorComponent support. */
async function askViaDialogs(
	ui: ExtensionContext["ui"],
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

	if (options.length === 0) {
		const answer = (await ui.input(prompt, "Type your answer...", dialogOpts)) as string | undefined;
		return isCancelledInput(answer) ? null : createFreeformResponse(answer);
	}

	if (allowMultiple) {
		const rawSelections = (await ui.input(
			`${prompt}\n\nOptions (select one or more):\n${formatOptionsForMessage(options)}`,
			"Type your selection(s)...",
			dialogOpts,
		)) as string | undefined;
		if (isCancelledInput(rawSelections)) return null;
		const selections = parseDialogSelections(rawSelections);
		if (selections.length === 0) return null;
		if (!allowComment) return createSelectionResponse(selections);
		const comment = (await ui.input(buildCommentPrompt(prompt, selections), "Optional comment (press Enter to skip)...", dialogOpts)) as
			| string
			| undefined;
		return createSelectionResponse(selections, comment);
	}

	const selectOptions = options.map((o) => o.title);
	if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);
	const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as string | undefined;
	if (isCancelledInput(selected)) return null;

	if (selected === FREEFORM_SENTINEL) {
		const answer = (await ui.input(prompt, "Type your answer...", dialogOpts)) as string | undefined;
		return isCancelledInput(answer) ? null : createFreeformResponse(answer);
	}

	if (!allowComment) return createSelectionResponse([selected]);
	const comment = (await ui.input(buildCommentPrompt(prompt, [selected]), "Optional comment (press Enter to skip)...", dialogOpts)) as
		| string
		| undefined;
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
 * this call is already resolving, independently of it. driveActiveTasks checks isLiveAskPending()
 * and skips queuing while true.
 */
let livePendingCount = 0;

export function isLiveAskPending(): boolean {
	return livePendingCount > 0;
}

const DISCUSS_TYPING_COURTESY_DEFAULT_POLL_MS = 100;
const DISCUSS_TYPING_COURTESY_DEFAULT_INITIAL_QUIET_MS = 1_500;
const DISCUSS_TYPING_COURTESY_DEFAULT_QUIET_FLOOR_MS = 300;
const DISCUSS_TYPING_COURTESY_DEFAULT_DECAY_HORIZON_MS = 10_000;

let typingCourtesyPollMs = DISCUSS_TYPING_COURTESY_DEFAULT_POLL_MS;
let typingCourtesyInitialQuietMs = DISCUSS_TYPING_COURTESY_DEFAULT_INITIAL_QUIET_MS;
let typingCourtesyQuietFloorMs = DISCUSS_TYPING_COURTESY_DEFAULT_QUIET_FLOOR_MS;
let typingCourtesyDecayHorizonMs = DISCUSS_TYPING_COURTESY_DEFAULT_DECAY_HORIZON_MS;

/** Test-only: the real decay curve runs over seconds, too slow to exercise at its real scale in a unit test. */
export function setTypingCourtesyTimingForTests(overrides?: {
	pollMs?: number;
	initialQuietMs?: number;
	floorMs?: number;
	decayHorizonMs?: number;
}): void {
	typingCourtesyPollMs = overrides?.pollMs ?? DISCUSS_TYPING_COURTESY_DEFAULT_POLL_MS;
	typingCourtesyInitialQuietMs = overrides?.initialQuietMs ?? DISCUSS_TYPING_COURTESY_DEFAULT_INITIAL_QUIET_MS;
	typingCourtesyQuietFloorMs = overrides?.floorMs ?? DISCUSS_TYPING_COURTESY_DEFAULT_QUIET_FLOOR_MS;
	typingCourtesyDecayHorizonMs = overrides?.decayHorizonMs ?? DISCUSS_TYPING_COURTESY_DEFAULT_DECAY_HORIZON_MS;
}

function isTypingCourtesyEnabled(): boolean {
	return parseBooleanPreference(process.env.PAPYRUS_DISCUSS_TYPING_COURTESY) ?? true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Required quiet gap (no keystroke) before a live ask may open, as a function of how long we've
 * already been waiting. Starts wide (a natural inter-word pause shouldn't count as "done typing")
 * and decays toward a floor -- someone typing continuously gets pickier treatment over time
 * rather than never being asked. No outer cap: someone typing with sub-floor gaps forever waits
 * forever, same as the picker itself already waits indefinitely for a real human answer once open.
 */
function requiredQuietMsAt(elapsedMs: number): number {
	const t = Math.min(1, Math.max(0, elapsedMs / typingCourtesyDecayHorizonMs));
	return typingCourtesyInitialQuietMs - t * (typingCourtesyInitialQuietMs - typingCourtesyQuietFloorMs);
}

/**
 * Ambient, session-lifetime keystroke clock -- deliberately NOT scoped per-ask. A per-ask listener
 * would only see keystrokes from the moment the tool call happens to start, missing typing already
 * in progress when it began (the exact case this feature exists to protect). Attached once per
 * distinct ui instance (reference equality; a session's real ui object is stable for its lifetime)
 * and left attached -- there is no unregister, matching onTerminalInput's own listener-return-value
 * contract elsewhere in this file.
 */
let lastKeystrokeAt = 0;
let trackedUi: ExtensionContext["ui"] | undefined;

export function ensureTypingCourtesyTracking(ui: ExtensionContext["ui"]): void {
	if (typeof ui.onTerminalInput !== "function" || trackedUi === ui) return;
	trackedUi = ui;
	ui.onTerminalInput(() => {
		lastKeystrokeAt = Date.now();
		return undefined;
	});
}

/** Test-only: clears the ambient keystroke clock so one test's simulated typing can't bleed into another's. */
export function resetTypingCourtesyTrackingForTests(): void {
	lastKeystrokeAt = 0;
	trackedUi = undefined;
}

/**
 * Whether there is real, recent typing activity to wait out right now -- a plain synchronous read
 * of the ambient keystroke clock so the common case (nobody typing) never forces the caller
 * through an extra microtask. Deliberately not folded into waitForTypingCourtesy itself: an
 * unconditional `await` there -- even one that resolves immediately -- still yields once, which is
 * enough to let a signal aborted synchronously right after invoking askQuestion race past the
 * abort listener registered deeper in askQuestionBlocking and get missed entirely.
 */
export function isRecentlyTyping(): boolean {
	return lastKeystrokeAt > 0 && Date.now() - lastKeystrokeAt < typingCourtesyInitialQuietMs;
}

/**
 * Waits out real keystroke activity (not editor text content -- that can't distinguish "actively
 * typing" from "a stale draft sitting there", and misses a mid-thought erase-and-resume) before
 * popping the live ask over it. Only call when isRecentlyTyping() is already true.
 */
export async function waitForTypingCourtesy(params: Pick<AskQuestionParams, "onUpdate" | "signal">): Promise<void> {
	const startedAt = Date.now();
	let announced = false;
	while (lastKeystrokeAt > 0 && !params.signal?.aborted) {
		const elapsed = Date.now() - startedAt;
		if (Date.now() - lastKeystrokeAt >= requiredQuietMsAt(elapsed)) return;
		if (!announced) {
			announced = true;
			params.onUpdate?.({ content: [{ type: "text", text: "Waiting for you to finish typing before asking..." }], details: undefined });
		}
		await sleep(typingCourtesyPollMs, params.signal);
	}
}

/**
 * Discuss's live:true synchronous ask -- interactive AskComponent when a real TUI is available,
 * dialog fallback (ctx.ui.select/input) in RPC/headless mode, no-op undefined without any
 * interactive UI at all. Never fabricates an answer: cancel, timeout, and non-interactive
 * contexts all resolve to undefined.
 */
export async function askQuestion(ctx: ExtensionContext, params: AskQuestionParams): Promise<AskAnswer | undefined> {
	if (!ctx.hasUI || !ctx.ui) return undefined;
	return askQuestionUnguarded(ctx, params);
}

async function askQuestionUnguarded(ctx: ExtensionContext, params: AskQuestionParams): Promise<AskAnswer | undefined> {
	const options = params.options ?? [];
	const allowMultiple = params.allowMultiple ?? false;
	const allowFreeform = params.allowFreeform ?? true;
	const allowComment = params.allowComment ?? parseBooleanPreference(process.env.PAPYRUS_DISCUSS_ALLOW_COMMENT) ?? false;
	const normalizedContext = params.context?.trim() || undefined;

	if (isTypingCourtesyEnabled()) ensureTypingCourtesyTracking(ctx.ui);
	livePendingCount += 1;
	try {
		// Only actually awaits (yielding a microtask) when there's real typing activity to wait out --
		// see isRecentlyTyping's own comment for why the common case must stay synchronous.
		if (isTypingCourtesyEnabled() && isRecentlyTyping()) await waitForTypingCourtesy(params);
		params.onUpdate?.({ content: [{ type: "text", text: "Waiting for human input..." }], details: undefined });
		return await askQuestionBlocking(ctx, params, options, allowMultiple, allowFreeform, allowComment, normalizedContext);
	} finally {
		livePendingCount -= 1;
	}
}

/**
 * Hosts an AskComponent in place of the real input editor (ctx.ui.setEditorComponent), the same
 * mechanism Pi's own slash-command menu ecosystem uses. getText() always returns the human's
 * real in-progress draft, captured once before swapping in -- setEditorComponent's own swap
 * logic reads getText() off the OUTGOING editor to carry a draft forward when restoring the
 * previous one afterward; if this returned anything else, restoring would silently overwrite a
 * real draft with an empty string. Implements EditorComponent directly rather than extending
 * CustomEditor: CustomEditor's
 * duck-typed actionHandlers Map would otherwise get every app-level action (model switching,
 * clear, suspend) copied onto it by Pi's own editor-swap code, none of which this host uses or
 * forwards -- avoiding the inheritance sidesteps that dead weight entirely.
 */
class DiscussEditorHost implements EditorComponent {
	constructor(
		private readonly ask: AskComponent,
		private readonly preservedText: string,
	) {}
	getText(): string {
		return this.preservedText;
	}
	setText(_text: string): void {}
	render(width: number): string[] {
		return this.ask.render(width);
	}
	handleInput(data: string): void {
		this.ask.handleInput(data);
	}
	invalidate(): void {
		this.ask.invalidate();
	}
}

async function askViaEditorSwap(
	ctx: ExtensionContext,
	params: AskQuestionParams,
	options: AskOption[],
	allowMultiple: boolean,
	allowFreeform: boolean,
	allowComment: boolean,
	normalizedContext: string | undefined,
	shortcuts: ResolvedAskShortcuts,
): Promise<AskResponse | null> {
	const previousFactory = ctx.ui.getEditorComponent();
	const preservedText = ctx.ui.getEditorText();
	// setEditorComponent's factory only receives an EditorTheme (borderColor + selectList) --
	// nowhere near AskComponent's actual dependency on the full Theme surface (.fg(), .bold(),
	// etc). ctx.ui.theme is the real, rich Theme; captured here rather than from the factory.
	const theme = ctx.ui.theme;
	return new Promise<AskResponse | null>((resolve) => {
		let settled = false;
		const finish = (result: AskResponse | null) => {
			if (settled) return;
			settled = true;
			ctx.ui.setEditorComponent(previousFactory);
			resolve(result);
		};
		if (params.signal) params.signal.addEventListener("abort", () => finish(null), { once: true });
		if (params.timeout && params.timeout > 0) setTimeout(() => finish(null), params.timeout);
		ctx.ui.setEditorComponent((tui: TUI, _editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
			const ask = new AskComponent(
				params.question,
				normalizedContext,
				params.subtitle,
				options,
				allowMultiple,
				allowFreeform,
				allowComment,
				tui,
				theme,
				keybindings,
				shortcuts,
				finish,
			);
			return new DiscussEditorHost(ask, preservedText);
		});
	});
}

async function askQuestionBlocking(
	ctx: ExtensionContext,
	params: AskQuestionParams,
	options: AskOption[],
	allowMultiple: boolean,
	allowFreeform: boolean,
	allowComment: boolean,
	normalizedContext: string | undefined,
): Promise<AskAnswer | undefined> {
	const shortcuts: ResolvedAskShortcuts = {
		commentToggle: resolveShortcut(undefined, process.env.PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY, DEFAULT_COMMENT_TOGGLE_KEY),
	};

	// Falls to the plain dialog fallback if setEditorComponent isn't available in this UI mode.
	if (
		typeof ctx.ui.setEditorComponent === "function" &&
		typeof ctx.ui.getEditorComponent === "function" &&
		typeof ctx.ui.getEditorText === "function"
	) {
		const response = await askViaEditorSwap(ctx, params, options, allowMultiple, allowFreeform, allowComment, normalizedContext, shortcuts);
		return response ? toAskAnswer(response) : undefined;
	}
	const response = await askViaDialogs(
		ctx.ui,
		params.question,
		normalizedContext,
		options,
		allowMultiple,
		allowFreeform,
		allowComment,
		params.timeout,
	);
	return response ? toAskAnswer(response) : undefined;
}
