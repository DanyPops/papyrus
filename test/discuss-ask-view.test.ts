import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { askQuestion } from "../extension/src/discuss-ask-view.ts";

const originalEnv = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
});

const theme = { bold: (t: string) => t, italic: (t: string) => t, underline: (t: string) => t, strikethrough: (t: string) => t, fg: (_c: string, t: string) => t } as Theme;
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const ENTER = "\r";
const ESCAPE = "\x1b";

/**
 * ctx.ui.custom() as the real interactive TUI would run it: invokes the real factory with a
 * real KeybindingsManager and a minimal tui stub, then feeds it real terminal key sequences.
 * This exercises the genuine AskComponent/WrappedSingleSelectList/MultiSelectList code owned by
 * discuss-ask-view.ts, not a hand-built substitute for it.
 */
function interactiveCtx(keySequence: string[]): ExtensionContext {
	const tui = { terminal: { rows: 40 }, requestRender: () => {} };
	return {
		cwd: "/tmp", hasUI: true,
		ui: {
			select: async () => { throw new Error("should not fall back to dialog select in interactive mode"); },
			input: async () => { throw new Error("should not fall back to dialog input in interactive mode"); },
			notify: () => {},
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory(tui, theme, keybindings, resolve);
				for (const key of keySequence) component.handleInput(key);
			}),
		} as any,
	} as ExtensionContext;
}

describe("discuss-ask-view: Discuss's own live:true ask UI, owned end-to-end", () => {
	it("single-select: pressing enter picks the currently highlighted option through the real AskComponent", async () => {
		const ctx = interactiveCtx([ENTER]);
		const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }] });
		expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
	});

	it("single-select: arrow-down then enter picks the second option", async () => {
		const ctx = interactiveCtx(["\x1b[B", ENTER]);
		const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }] });
		expect(answer).toEqual({ content: "Slip to Monday", selected: ["Slip to Monday"] });
	});

	it("multi-select: toggling two rows by digit then confirming returns both, comma-joined", async () => {
		const ctx = interactiveCtx(["1", "2", ENTER]);
		const answer = await askQuestion(ctx, { question: "Which regions?", options: [{ title: "us-east" }, { title: "eu-west" }], allowMultiple: true });
		expect(answer).toEqual({ content: "us-east, eu-west", selected: ["us-east", "eu-west"] });
	});

	it("escape cancels the picker -- resolves to undefined, never a fabricated answer", async () => {
		const ctx = interactiveCtx([ESCAPE]);
		const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }] });
		expect(answer).toBeUndefined();
	});

	it("a freeform-only question (no options) skips AskComponent entirely and goes straight through ctx.ui.input", async () => {
		const prompts: string[] = [];
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async () => undefined, input: async (title: string) => { prompts.push(title); return "42"; }, notify: () => {}, custom: async () => undefined } } as unknown as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "How many replicas?" });
		expect(prompts).toEqual(["How many replicas?"]);
		expect(answer).toEqual({ content: "42" });
	});

	it("freeform-only cancel (empty answer) resolves to undefined, not an empty content string", async () => {
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async () => undefined } } as unknown as ExtensionContext;
		expect(await askQuestion(ctx, { question: "How many replicas?" })).toBeUndefined();
	});

	it("degrades to the dialog fallback (ctx.ui.select) when ctx.ui.custom() returns undefined -- RPC/headless mode", async () => {
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return "Ship Friday"; }, input: async () => undefined, notify: () => {}, custom: async () => undefined } } as unknown as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }] });
		expect(selectCalls).toEqual([{ title: "Ship or not?", options: ["Ship Friday", "Slip to Monday", "\u270f\ufe0f Type a custom answer..."] }]);
		expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
	});

	it("degrades to undefined, not a throw, when there is no interactive UI at all", async () => {
		const ctx = { cwd: "/tmp", hasUI: false, ui: {} } as unknown as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
		expect(answer).toBeUndefined();
	});

	it("honors PAPYRUS_DISCUSS_DISPLAY_MODE=inline instead of the default overlay -- render never throws in inline layout", async () => {
		process.env["PAPYRUS_DISCUSS_DISPLAY_MODE"] = "inline";
		const tui = { terminal: { rows: 40 }, requestRender: () => {} };
		let rendered: string[] = [];
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("unexpected"); }, input: async () => { throw new Error("unexpected"); }, notify: () => {},
				custom: async (factory: any) => new Promise((resolve) => {
					const component = factory(tui, theme, keybindings, resolve);
					rendered = component.render(80);
					component.handleInput(ENTER);
				}),
			} as any,
		} as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
		expect(rendered.length).toBeGreaterThan(0);
		expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
	});
});
