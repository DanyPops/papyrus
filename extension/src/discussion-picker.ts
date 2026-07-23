/**
 * discussion-picker.ts — the structured-choice picker for /discuss's "Reply" action.
 *
 * "single" mode (mutually exclusive) needs nothing bespoke: the Pi extension UI already
 * provides exactly that (ctx.ui.select). "multi" (allow several) has no native equivalent
 * anywhere in @earendil-works/pi-coding-agent or pi-tui (checked both) -- so this is a small,
 * genuinely domain-specific checkbox-list component, not a generic library replacement.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DiscussionOptionsMode } from "../../src/domain/discussion.ts";

/** Toggle with space, confirm with enter (refuses an empty confirm -- at least one pick is required), cancel with escape. */
async function pickMultiple(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
		const checked = new Set<number>();
		let selectedIndex = 0;
		return {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [
					theme.bold(title),
					theme.fg("muted", "space toggle \u00b7 enter confirm \u00b7 esc cancel"),
					"",
				];
				options.forEach((option, index) => {
					const cursor = index === selectedIndex ? theme.fg("accent", "\u276f") : " ";
					const box = checked.has(index) ? theme.fg("success", "[x]") : "[ ]";
					const label = index === selectedIndex ? theme.bold(option) : option;
					lines.push(truncateToWidth(`${cursor} ${box} ${label}`, width, ""));
				});
				lines.push("");
				lines.push(theme.fg("dim", `${checked.size} selected`));
				return lines;
			},
			handleInput(data: string) {
				if (matchesKey(data, "up")) selectedIndex = (selectedIndex - 1 + options.length) % options.length;
				else if (matchesKey(data, "down")) selectedIndex = (selectedIndex + 1) % options.length;
				else if (data === " ") { if (checked.has(selectedIndex)) checked.delete(selectedIndex); else checked.add(selectedIndex); }
				else if (matchesKey(data, "enter")) {
					if (checked.size === 0) return; // refuse an empty confirm -- selecting nothing isn't a valid answer
					done([...checked].sort((a, b) => a - b).map((index) => options[index]!));
					return;
				} else if (matchesKey(data, "escape")) { done(undefined); return; }
				else return;
				tui.requestRender();
			},
		};
	});
}

/** Picks one (single) or several (multi) of the given options, or undefined if the user cancels. */
export async function pickDiscussionOptions(ctx: ExtensionCommandContext, mode: DiscussionOptionsMode, options: string[]): Promise<string[] | undefined> {
	if (mode === "single") {
		const pick = await ctx.ui.select("Pick one:", options);
		return pick ? [pick] : undefined;
	}
	return pickMultiple(ctx, "Pick one or more:", options);
}
