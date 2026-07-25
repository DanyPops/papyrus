/**
 * discussion-picker.ts — the structured-choice picker for /discuss's "Reply" action and the
 * discuss tool's own live:true synchronous ask.
 *
 * "single" mode (mutually exclusive) needs nothing bespoke for the pick list itself: the Pi
 * extension UI already provides exactly that (ctx.ui.select). "multi" (allow several) has no
 * native equivalent anywhere in @earendil-works/pi-coding-agent or pi-tui (checked both) -- so
 * that one is a small, genuinely domain-specific checkbox-list component, not a generic library
 * replacement. Both modes get a numbered quick-select (press the row's digit instead of
 * scrolling with arrows) and an appended "type your own answer" row, itself numbered the same
 * way -- a genuinely open question is exactly as valid an answer as any of the posed options.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { DISCUSSION_PICKER_IDLE_TIMEOUT_MS, DISCUSSION_PICKER_TICK_MS } from "../../src/constants.ts";
import type { DiscussionOptionsMode } from "../../src/domain/discussion.ts";

const FREEFORM_LABEL = "Something else (type your own answer)";

export type DiscussionPickResult = { kind: "selected"; selected: string[] } | { kind: "freeform"; text: string };

/** digit "1".."9" -> index 0-8, "0" -> index 9 (DISCUSSION_OPTIONS_MAX_COUNT is 10) -- standard terminal-menu numbering, not 0-indexed. */
function digitToIndex(data: string, rowCount: number): number | undefined {
	if (data === "0") return rowCount >= 10 ? 9 : undefined;
	if (data.length === 1 && data >= "1" && data <= "9") {
		const index = Number(data) - 1;
		return index < rowCount ? index : undefined;
	}
	return undefined;
}

function rowNumberLabel(index: number): string {
	if (index < 9) return `${index + 1}`;
	if (index === 9) return "0";
	return " "; // beyond the 1-9,0 quick-select range (should not happen given DISCUSSION_OPTIONS_MAX_COUNT=10, but never crash rendering)
}

async function promptFreeformAnswer(ctx: ExtensionContext): Promise<DiscussionPickResult | undefined> {
	const text = await ctx.ui.input("Your answer:", "");
	return text ? { kind: "freeform", text } : undefined;
}

/**
 * Toggle with space or a row's number, confirm with enter (refuses an empty confirm -- at least
 * one pick is required), cancel with escape. Picking the freeform row exits the checkbox flow
 * entirely rather than adding it to the selection.
 *
 * Idle countdown: auto-cancels after DISCUSSION_PICKER_IDLE_TIMEOUT_MS of no input at all --
 * the first keystroke of any kind stops it permanently (not a pause; it never resumes for this
 * picker instance), since a countdown ticking while someone is actively engaging is pressure,
 * not a nudge. The same tick also drives a slow, deliberately noticeable blink on the cursor
 * row -- checked rows stay steadily highlighted, everything else stays dimmed, so the eye reads
 * "what's chosen" at a glance independent of where the cursor happens to be.
 */
async function pickMultiple(ctx: ExtensionContext, title: string, options: string[], allowFreeform: boolean, idleTimeoutMs: number, tickMs: number): Promise<DiscussionPickResult | undefined> {
	return ctx.ui.custom<DiscussionPickResult | undefined>((tui, theme, _keybindings, done) => {
		const rows = allowFreeform ? [...options, FREEFORM_LABEL] : options;
		const freeformIndex = allowFreeform ? rows.length - 1 : -1;
		const checked = new Set<number>();
		let selectedIndex = 0;
		let hasInteracted = false;
		let remainingMs = idleTimeoutMs;
		let blinkOn = true;
		const tick = setInterval(() => {
			blinkOn = !blinkOn;
			if (!hasInteracted) {
				remainingMs -= tickMs;
				if (remainingMs <= 0) { finish(undefined); return; }
			}
			tui.requestRender();
		}, tickMs);
		const finish = (value: DiscussionPickResult | undefined) => { clearInterval(tick); done(value); };
		const chooseFreeform = () => { promptFreeformAnswer(ctx).then(finish); };
		const toggle = (index: number) => {
			if (index === freeformIndex) { chooseFreeform(); return; }
			if (checked.has(index)) checked.delete(index); else checked.add(index);
			tui.requestRender();
		};
		return {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [
					theme.bold(title),
					theme.fg("muted", "number/space toggle \u00b7 enter confirm \u00b7 esc cancel"),
					"",
				];
				rows.forEach((option, index) => {
					const isCursor = index === selectedIndex;
					const isChecked = checked.has(index);
					const cursorGlyph = isCursor && blinkOn ? theme.fg("accent", "\u276f") : " ";
					const box = index === freeformIndex ? "  " : isChecked ? theme.fg("success", "[x]") : "[ ]";
					let label = option;
					if (isChecked) label = theme.bold(theme.fg("success", label));
					else if (isCursor) label = theme.bold(theme.fg("accent", label));
					else label = theme.fg("dim", label);
					lines.push(truncateToWidth(`${cursorGlyph} ${rowNumberLabel(index)}. ${box} ${label}`, width, ""));
				});
				lines.push("");
				lines.push(theme.fg("dim", `${checked.size} selected`));
				if (!hasInteracted) lines.push(theme.fg("dim", `auto-cancels in ${Math.max(0, Math.ceil(remainingMs / 1000))}s (press any key to stop)`));
				return lines;
			},
			handleInput(data: string) {
				hasInteracted = true;
				const digit = digitToIndex(data, rows.length);
				if (digit !== undefined) { selectedIndex = digit; toggle(digit); return; }
				if (matchesKey(data, "up")) selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
				else if (matchesKey(data, "down")) selectedIndex = (selectedIndex + 1) % rows.length;
				else if (data === " ") { toggle(selectedIndex); return; }
				else if (matchesKey(data, "enter")) {
					if (selectedIndex === freeformIndex && checked.size === 0) { chooseFreeform(); return; }
					if (checked.size === 0) return; // refuse an empty confirm -- selecting nothing isn't a valid answer
					finish({ kind: "selected", selected: [...checked].sort((a, b) => a - b).map((index) => rows[index]!) });
					return;
				} else if (matchesKey(data, "escape")) { finish(undefined); return; }
				else return;
				tui.requestRender();
			},
		};
	});
}

/**
 * Picks one (single) or several (multi) of the given options, or a freeform typed answer
 * instead, or undefined if the user cancels. Takes the base ExtensionContext (just .ui) rather
 * than the wider ExtensionCommandContext, since a tool's execute() only ever receives the
 * former -- the discuss tool's own live mode reuses this same picker, not just the /discuss
 * TUI panel. Single mode's numbered quick-select is not guaranteed: it delegates to Pi's own
 * native ctx.ui.select, which this package does not control the key handling of.
 */
export async function pickDiscussionOptions(
	ctx: ExtensionContext,
	mode: DiscussionOptionsMode,
	options: string[],
	allowFreeform = true,
	/** Test seam: real timers, not faked global time -- pass tiny values to exercise the idle-cancel/blink logic quickly and deterministically. */
	idleTimeoutMs = DISCUSSION_PICKER_IDLE_TIMEOUT_MS,
	tickMs = DISCUSSION_PICKER_TICK_MS,
): Promise<DiscussionPickResult | undefined> {
	if (mode === "single") {
		const rows = allowFreeform ? [...options, FREEFORM_LABEL] : options;
		const pick = await ctx.ui.select("Pick one:", rows);
		if (!pick) return undefined;
		if (allowFreeform && pick === FREEFORM_LABEL) return promptFreeformAnswer(ctx);
		return { kind: "selected", selected: [pick] };
	}
	return pickMultiple(ctx, "Pick one or more:", options, allowFreeform, idleTimeoutMs, tickMs);
}
