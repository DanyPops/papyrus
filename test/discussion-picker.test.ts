import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import { pickDiscussionOptions } from "../extension/src/discussion-picker.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function singleSelectContext(pick: string | undefined, freeformAnswer?: string) {
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const inputCalls: string[] = [];
	const ctx = {
		ui: {
			select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return pick; },
			input: async (title: string) => { inputCalls.push(title); return freeformAnswer; },
		},
	} as unknown as ExtensionContext;
	return { ctx, selectCalls, inputCalls };
}

function multiSelectContext(inputs: string[], freeformAnswer?: string) {
	const renders: string[][] = [];
	const inputCalls: string[] = [];
	const ctx = {
		ui: {
			async custom(factory: any) {
				let done: unknown;
				let settled = false;
				const component = await factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					theme,
					{},
					(value: unknown) => { done = value; settled = true; },
				);
				for (const input of inputs) {
					if (settled) break;
					renders.push(component.render(80));
					component.handleInput(input);
				}
				// A freeform pick resolves `done` asynchronously (it awaits ctx.ui.input internally) --
				// give that microtask a turn before reading the result.
				await Promise.resolve();
				await Promise.resolve();
				return done;
			},
			input: async (title: string) => { inputCalls.push(title); return freeformAnswer; },
		},
	} as unknown as ExtensionContext;
	return { ctx, renders, inputCalls };
}

function rawMultiSelectComponent(): { ctx: ExtensionContext; getDone: () => { settled: boolean; value: unknown }; renderCount: () => number } {
	let settled = false;
	let value: unknown;
	let renders = 0;
	let componentRef: any;
	const ctx = {
		ui: {
			async custom(factory: any) {
				componentRef = await factory(
					{ terminal: { rows: 24 }, requestRender() { renders++; } },
					theme,
					{},
					(v: unknown) => { settled = true; value = v; },
				);
				while (!settled) await new Promise((resolve) => setTimeout(resolve, 5));
				return value;
			},
		},
	} as unknown as ExtensionContext;
	void componentRef;
	return { ctx, getDone: () => ({ settled, value }), renderCount: () => renders };
}

describe("pickDiscussionOptions: idle countdown and blink (real tiny timers, not faked global time)", () => {
	it("auto-cancels after the idle timeout with zero interaction", async () => {
		const { ctx } = rawMultiSelectComponent();
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B"], true, 20, 5);
		expect(result).toBeUndefined();
	});

	it("a keystroke stops the countdown permanently -- outliving the original timeout no longer auto-cancels", async () => {
		let settled = false;
		let value: unknown;
		let handleInput: ((data: string) => void) | undefined;
		const ctx = {
			ui: {
				async custom(factory: any) {
					const component = await factory(
						{ terminal: { rows: 24 }, requestRender() {} },
						theme,
						{},
						(v: unknown) => { settled = true; value = v; },
					);
					handleInput = component.handleInput.bind(component);
					// One keystroke well before the idle timeout would fire, then wait past where it would have.
					await new Promise((resolve) => setTimeout(resolve, 5));
					handleInput!("\x1b[B"); // down arrow -- any key, not a confirming one
					await new Promise((resolve) => setTimeout(resolve, 40));
					return settled ? value : "still-open";
				},
			},
		} as unknown as ExtensionContext;
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B"], true, 20, 5) as unknown as string;
		expect(result).toBe("still-open"); // never auto-canceled once a key was pressed
		expect(settled).toBe(false);
	});

	it("renders a countdown line only before any interaction, and stops rendering it after a keystroke", async () => {
		const renderSnapshots: string[] = [];
		const ctx = {
			ui: {
				async custom(factory: any) {
					const component: { render: (width: number) => string[]; handleInput: (data: string) => void } = await factory(
						{ terminal: { rows: 24 }, requestRender() {} },
						theme,
						{},
						() => {},
					);
					renderSnapshots.push(component.render(80).join("\n"));
					await new Promise((resolve) => setTimeout(resolve, 12)); // let a couple of ticks fire
					component.handleInput("\x1b[B");
					renderSnapshots.push(component.render(80).join("\n"));
					return undefined;
				},
			},
		} as unknown as ExtensionContext;
		await pickDiscussionOptions(ctx, "multi", ["A", "B"], true, 1000, 5);
		expect(renderSnapshots[0]).toContain("auto-cancels in");
		expect(renderSnapshots.at(-1)).not.toContain("auto-cancels in");
	});

	it("blinks the cursor glyph on the currently-focused row over successive ticks, without disturbing a checked row's steady highlight", async () => {
		const { ctx, getDone } = rawMultiSelectComponent();
		// This test only needs render() output across ticks -- reuse rawMultiSelectComponent's ctx
		// but observe via its own factory hook instead of waiting for settlement.
		let render: ((width: number) => string[]) | undefined;
		const customCtx = {
			ui: {
				async custom(factory: any) {
					const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, () => {});
					render = component.render.bind(component);
					component.handleInput(" "); // check row A (also stops the countdown, irrelevant here)
					const frames: string[] = [];
					for (let i = 0; i < 4; i++) { frames.push(render!(80).join("\n")); await new Promise((resolve) => setTimeout(resolve, 6)); }
					return frames;
				},
			},
		} as unknown as ExtensionContext;
		const frames = await pickDiscussionOptions(customCtx, "multi", ["A", "B"], false, 1000, 5) as unknown as string[];
		// The cursor glyph (❯) toggles on/off across ticks -- not every frame identical.
		const distinctFrames = new Set(frames);
		expect(distinctFrames.size).toBeGreaterThan(1);
		// Every frame keeps row A (checked) rendered, regardless of blink phase -- the highlight is steady.
		for (const frame of frames) expect(frame).toContain("[x]");
		void ctx;
		void getDone;
	});
});

describe("pickDiscussionOptions", () => {
	it("single mode delegates to ctx.ui.select (with the freeform row appended) and wraps the pick as selected", async () => {
		const { ctx, selectCalls } = singleSelectContext("B");
		const result = await pickDiscussionOptions(ctx, "single", ["A", "B"]);
		expect(result).toEqual({ kind: "selected", selected: ["B"] });
		expect(selectCalls).toEqual([{ title: "Pick one:", options: ["A", "B", "Something else (type your own answer)"] }]);
	});

	it("single mode returns undefined when the user cancels the native select", async () => {
		const { ctx } = singleSelectContext(undefined);
		expect(await pickDiscussionOptions(ctx, "single", ["A", "B"])).toBeUndefined();
	});

	it("single mode: picking the freeform row prompts for text and returns it as freeform, not a selected option", async () => {
		const { ctx, inputCalls } = singleSelectContext("Something else (type your own answer)", "my own answer");
		const result = await pickDiscussionOptions(ctx, "single", ["A", "B"]);
		expect(result).toEqual({ kind: "freeform", text: "my own answer" });
		expect(inputCalls).toEqual(["Your answer:"]);
	});

	it("single mode: does not append a freeform row when allowFreeform is false", async () => {
		const { ctx, selectCalls } = singleSelectContext("B");
		await pickDiscussionOptions(ctx, "single", ["A", "B"], false);
		expect(selectCalls[0]!.options).toEqual(["A", "B"]);
	});

	it("multi mode toggles with space and confirms with enter, returning every checked option in offered order", async () => {
		// down, space (check B), down, space (check C), enter
		const { ctx } = multiSelectContext(["\x1b[B", " ", "\x1b[B", " ", "\r"]);
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B", "C"]);
		expect(result).toEqual({ kind: "selected", selected: ["B", "C"] });
	});

	it("multi mode: a digit key jumps straight to and toggles that numbered row, instead of scrolling", async () => {
		// "3" toggles the 3rd row (C) directly, then enter
		const { ctx } = multiSelectContext(["3", "\r"]);
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B", "C"]);
		expect(result).toEqual({ kind: "selected", selected: ["C"] });
	});

	it("multi mode: row numbers are rendered so the digit-to-row mapping is visible, not just functional", async () => {
		const { ctx, renders } = multiSelectContext(["\r", "1", "\r"]);
		await pickDiscussionOptions(ctx, "multi", ["A", "B"]);
		const firstRender = renders[0]!.join("\n");
		expect(firstRender).toContain("1. [ ] A");
		expect(firstRender).toContain("2. [ ] B");
	});

	it("multi mode refuses to confirm an empty selection", async () => {
		// enter with nothing checked, then check A, then enter
		const { ctx, renders } = multiSelectContext(["\r", " ", "\r"]);
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B"]);
		expect(result).toEqual({ kind: "selected", selected: ["A"] });
		expect(renders[0]!.join("\n")).toContain("0 selected");
	});

	it("multi mode cancels on escape", async () => {
		const { ctx } = multiSelectContext(["\x1b"]);
		expect(await pickDiscussionOptions(ctx, "multi", ["A", "B"])).toBeUndefined();
	});

	it("multi mode: the appended freeform row is its own numbered choice, not a togglable checkbox -- picking it (by number or enter) exits straight to a text prompt", async () => {
		// "3" is the freeform row for a 2-option list (A, B, freeform)
		const { ctx, inputCalls } = multiSelectContext(["3"], "typed instead of picking");
		const result = await pickDiscussionOptions(ctx, "multi", ["A", "B"]);
		expect(result).toEqual({ kind: "freeform", text: "typed instead of picking" });
		expect(inputCalls).toEqual(["Your answer:"]);
	});

	it("multi mode: does not append a freeform row when allowFreeform is false", async () => {
		const { ctx, renders } = multiSelectContext(["\r", " ", "\r"]);
		await pickDiscussionOptions(ctx, "multi", ["A", "B"], false);
		expect(renders[0]!.join("\n")).not.toContain("Something else");
	});
});
