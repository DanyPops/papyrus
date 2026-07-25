import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { askQuestion, isLiveAskPending, setLiveAskHeartbeatIntervalMsForTests } from "../extension/src/discuss-ask-view.ts";

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

/**
 * Regression coverage for a real live-observed bug: the picker silently resolved to "cancelled"
 * roughly 7-10 seconds after opening, well before a human had actually finished deciding, with
 * their real answer then arriving disconnected as a stray follow-up message. Root cause: the
 * abort listener was wired to ExtensionContext.signal ("is the agent currently streaming") --
 * which settles/aborts shortly after the assistant's tool_call message finishes generating, not
 * when the human is done -- instead of the tool call's own per-execution signal (execute()'s 3rd
 * parameter). ctx.signal firing must never cancel the ask; only the passed-through params.signal
 * (or its absence) should.
 */
describe("discuss-ask-view: Discuss's own live:true ask UI, owned end-to-end", () => {
	it("ctx.signal aborting must NOT cancel the ask -- only the tool call's own passed-through signal should", async () => {
		const tui = { terminal: { rows: 40 }, requestRender: () => {} };
		const contextSignalController = new AbortController();
		let component: { handleInput: (data: string) => void } | undefined;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			signal: contextSignalController.signal,
			ui: {
				select: async () => { throw new Error("should not fall back to dialog select in interactive mode"); },
				input: async () => { throw new Error("should not fall back to dialog input in interactive mode"); },
				notify: () => {},
				custom: async (factory: any) => new Promise((resolve) => { component = factory(tui, theme, keybindings, resolve); }),
			} as any,
		} as ExtensionContext;
		const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Simulate the session's own streaming-turn signal settling shortly after the tool_call was
		// emitted -- routine, unrelated bookkeeping that happens long before a human actually answers.
		contextSignalController.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The ask must still be genuinely pending -- ctx.signal aborting must not have resolved it.
		const raced = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("still-pending"), 20))]);
		expect(raced).toBe("still-pending");
		// Clean up: answer for real so this test doesn't leak a permanently-pending ask/livePendingCount into later tests.
		component?.handleInput(ENTER);
		expect(await promise).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
	});

	it("the tool call's own passed-through signal DOES cancel the ask when it aborts", async () => {
		const tui = { terminal: { rows: 40 }, requestRender: () => {} };
		const toolCallController = new AbortController();
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("unexpected"); }, input: async () => { throw new Error("unexpected"); }, notify: () => {},
				custom: async (factory: any) => new Promise((resolve) => { factory(tui, theme, keybindings, resolve); }),
			} as any,
		} as ExtensionContext;
		const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], signal: toolCallController.signal });
		toolCallController.abort();
		expect(await promise).toBeUndefined();
	});

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

	/**
	 * Regression coverage for a real live-observed bug: a single upfront heartbeat only covers the
	 * first ~8s. Cancellation kept citing "idle timeout, no interaction within 8000ms" regardless of
	 * whether the real human wait was 5 seconds or 18 minutes -- proof that whatever's upstream
	 * re-checks liveness periodically, not once. A periodic heartbeat for the whole wait is required.
	 */
	it("streams a heartbeat repeatedly for the whole wait, not just once at the start", async () => {
		setLiveAskHeartbeatIntervalMsForTests(5);
		const updates: Array<{ content: Array<{ type: "text"; text: string }> }> = [];
		let resolveCustom: ((value: unknown) => void) | undefined;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("unexpected"); }, input: async () => { throw new Error("unexpected"); }, notify: () => {},
				custom: () => new Promise((resolve) => { resolveCustom = resolve; }),
			} as any,
		} as ExtensionContext;
		const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], onUpdate: (update) => updates.push(update as any) });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(updates.length).toBeGreaterThan(1);
		expect(updates.every((update) => update.content[0]!.text === "Waiting for human input...")).toBe(true);
		resolveCustom?.({ kind: "selection", selections: ["Ship Friday"] });
		await promise;
		const countAfterResolve = updates.length;
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The interval must be cleared once resolved -- no further heartbeats after the ask is done.
		expect(updates.length).toBe(countAfterResolve);
		setLiveAskHeartbeatIntervalMsForTests(4_000);
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
