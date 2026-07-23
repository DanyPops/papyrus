import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import { pickDiscussionOptions } from "../extension/src/discussion-picker.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function singleSelectContext(pick: string | undefined) {
	const calls: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		ui: {
			select: async (title: string, options: string[]) => { calls.push({ title, options }); return pick; },
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, calls };
}

function multiSelectContext(inputs: string[]) {
	const renders: string[][] = [];
	const ctx = {
		ui: {
			async custom(factory: any) {
				let done: unknown;
				const component = await factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					theme,
					{},
					(value: unknown) => { done = value; },
				);
				for (const input of inputs) {
					renders.push(component.render(80));
					component.handleInput(input);
				}
				return done;
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, renders };
}

describe("pickDiscussionOptions", () => {
	it("single mode delegates directly to ctx.ui.select and wraps the pick in an array", async () => {
		const { ctx, calls } = singleSelectContext("B");
		const result = await pickDiscussionOptions(ctx, "single", ["A", "B"]);
		expect(result).toEqual(["B"]);
		expect(calls).toEqual([{ title: "Pick one:", options: ["A", "B"] }]);
	});

	it("single mode returns undefined when the user cancels the native select", async () => {
		const { ctx } = singleSelectContext(undefined);
		expect(await pickDiscussionOptions(ctx, "single", ["A", "B"])).toBeUndefined();
	});

	it("multi mode toggles with space and confirms with enter, returning every checked option in offered order", async () => {
		// down, space (check B), down, space (check C), enter
		const { ctx } = multiSelectContext(["\x1b[B", " ", "\x1b[B", " ", "\r"]);
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B", "C"]);
		expect(result).toEqual(["B", "C"]);
	});

	it("multi mode refuses to confirm an empty selection", async () => {
		// enter with nothing checked, then check A, then enter
		const { ctx, renders } = multiSelectContext(["\r", " ", "\r"]);
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B"]);
		expect(result).toEqual(["A"]);
		expect(renders[0]!.join("\n")).toContain("0 selected");
	});

	it("multi mode cancels on escape", async () => {
		const { ctx } = multiSelectContext(["\x1b"]);
		expect(await pickDiscussionOptions(ctx, "multi", ["A", "B"])).toBeUndefined();
	});
});
