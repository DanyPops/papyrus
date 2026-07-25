import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { askQuestion, isLiveAskPending } from "../extension/src/discuss-ask-view.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

const originalEnv = { ...process.env };
// askQuestion's diag() heartbeat writes go through callService -- without a mocked connector
// they'd hit whatever real Papyrus daemon happens to be running on this machine, polluting its
// live log store with test fixture data. A no-op connector keeps every test hermetic.
setPapyrusClientConnectorForTests(async () => ({ call: async () => undefined }) as any);
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	resetPapyrusClientForTests();
	setPapyrusClientConnectorForTests(async () => ({ call: async () => undefined }) as any);
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

	/**
	 * Regression coverage for a real live-observed bug: extension/src/index.ts's active-task
	 * continuation driver queues a "continue the active task" nudge on agent_settled, and
	 * ctx.isIdle() ("not streaming") reads true while a live ask is genuinely still pending on the
	 * human -- so without this guard, that nudge starts a second, concurrent turn reasoning about
	 * the very Discussion the pending live ask hasn't resolved yet. index.ts's driveActiveTasks
	 * checks isLiveAskPending() and skips queuing while a live ask is in flight.
	 */
	it("isLiveAskPending() is false at rest, true only while a live ask is genuinely blocked on the human, and false again once it resolves", async () => {
		expect(isLiveAskPending()).toBe(false);
		let observedDuringAsk: boolean | undefined;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => undefined,
				input: async () => { observedDuringAsk = isLiveAskPending(); return "42"; },
				notify: () => {}, custom: async () => undefined,
			},
		} as unknown as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "How many replicas?" });
		expect(observedDuringAsk).toBe(true);
		expect(isLiveAskPending()).toBe(false);
		expect(answer).toEqual({ content: "42" });
	});

	it("isLiveAskPending() still clears on cancel, so a rejected/cancelled ask never leaves the guard stuck open", async () => {
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async () => undefined } } as unknown as ExtensionContext;
		await askQuestion(ctx, { question: "How many replicas?" });
		expect(isLiveAskPending()).toBe(false);
	});

	/**
	 * Regression coverage for a real live-observed bug that persisted even after the heartbeat and
	 * isLiveAskPending fixes: whatever the exact external trigger, a second concurrent live ask for
	 * the same Discussion must never open a second picker. Keying by the Discussion's id makes a
	 * genuine duplicate call join the first's in-flight promise instead of starting a new one.
	 */
	it("a second concurrent call with the same key joins the first's in-flight picker instead of opening a second one", async () => {
		let customCalls = 0;
		let resolveFirst: ((value: unknown) => void) | undefined;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("should not fall back to dialogs"); },
				input: async () => { throw new Error("should not fall back to dialogs"); },
				notify: () => {},
				custom: (_factory: any) => { customCalls += 1; return new Promise((resolve) => { resolveFirst = resolve; }); },
			} as any,
		} as ExtensionContext;
		const first = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }], key: "disc-1" });
		const second = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }], key: "disc-1" });
		expect(customCalls).toBe(1);
		resolveFirst?.({ kind: "selection", selections: ["Ship Friday"] });
		const [firstAnswer, secondAnswer] = await Promise.all([first, second]);
		expect(firstAnswer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
		expect(secondAnswer).toEqual(firstAnswer);
		expect(customCalls).toBe(1);
	});

	it("different keys never join -- each gets its own independent picker", async () => {
		let customCalls = 0;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("should not fall back to dialogs"); },
				input: async () => { throw new Error("should not fall back to dialogs"); },
				notify: () => {},
				custom: async (_factory: any) => { customCalls += 1; return { kind: "selection", selections: ["Ship Friday"] }; },
			} as any,
		} as ExtensionContext;
		await Promise.all([
			askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], key: "disc-1" }),
			askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], key: "disc-2" }),
		]);
		expect(customCalls).toBe(2);
	});

	it("a key is freed once the ask resolves, so a later call with the same key opens a fresh picker rather than joining a stale one", async () => {
		let customCalls = 0;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("should not fall back to dialogs"); },
				input: async () => { throw new Error("should not fall back to dialogs"); },
				notify: () => {},
				custom: async (_factory: any) => { customCalls += 1; return { kind: "selection", selections: ["Ship Friday"] }; },
			} as any,
		} as ExtensionContext;
		await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], key: "disc-1" });
		await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], key: "disc-1" });
		expect(customCalls).toBe(2);
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
