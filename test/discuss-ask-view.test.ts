import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { askQuestion, isLiveAskPending } from "../extension/src/discuss-ask-view.ts";

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

	// Regression: a freeform-only ask (no options) used to bypass AskComponent entirely and go
	// straight through a bare ctx.ui.input(), rendering as a plain contextless line while every
	// options-bearing ask got the full bordered box, title, and markdown context. A human live-
	// observed this inconsistency directly. Freeform-only asks must use the same rich AskComponent
	// whenever a real ctx.ui.custom() is available, falling back to ctx.ui.input only in RPC/headless
	// mode (same fallback every other ask already uses).
	// Regression: liveAnswer's generic "Reply to <title>:" wrapper was shown as the primary,
	// bolded "Question", with the discussion's real content demoted to a "Context:" section below
	// it -- backwards, live-observed directly. The real content is now the question itself; the
	// discussion title is a plain dim subtitle, not a labeled section.
	it("renders the subtitle as plain dim text, never a generic 'Question' header, and never a redundant 'Custom answer' label when there are no options", async () => {
		const tui = { terminal: { rows: 40 }, requestRender: () => {} };
		let component: { render: (w: number) => string[] } | undefined;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("unexpected"); }, input: async () => { throw new Error("unexpected"); }, notify: () => {},
				custom: (factory: any) => new Promise((resolve) => { component = factory(tui, theme, keybindings, resolve); }),
			} as any,
		} as ExtensionContext;
		const pending = askQuestion(ctx, { question: "Should we ship Friday?", subtitle: "Ship or not?" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = component!.render(100).join("\n");
		expect(rendered).toContain("Ship or not?"); // subtitle present
		expect(rendered).not.toContain("Question"); // no generic header
		expect(rendered).not.toContain("Custom answer"); // no options to contrast against
		(component as unknown as { handleInput: (data: string) => void }).handleInput(ESCAPE);
		await pending; // let isLiveAskPending's guard clear before the next test observes it
	});

	it("a freeform-only question (no options) uses the real AskComponent, typing text and pressing enter", async () => {
		const ctx = interactiveCtx([..."42", ENTER]);
		const answer = await askQuestion(ctx, { question: "How many replicas?" });
		expect(answer).toEqual({ content: "42" });
	});

	it("a freeform-only question: escape cancels outright (no select mode to fall back to)", async () => {
		const ctx = interactiveCtx([ESCAPE]);
		const answer = await askQuestion(ctx, { question: "How many replicas?" });
		expect(answer).toBeUndefined();
	});

	it("a freeform-only question still degrades to ctx.ui.input via the dialog fallback in RPC/headless mode", async () => {
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

	/**
	 * displayMode: "editor" hosts the picker via ctx.ui.setEditorComponent -- Pi's own
	 * slash-command menu mechanism -- instead of a floating ctx.ui.custom() overlay.
	 */
	describe("displayMode: \"editor\" -- hosted in the real input editor, not a floating overlay", () => {
		function editorCtx() {
			const setCalls: Array<((...args: unknown[]) => unknown) | undefined> = [];
			const previousFactory = () => "previous-editor-sentinel";
			const ctx = {
				cwd: "/tmp", hasUI: true,
				ui: {
					select: async () => { throw new Error("should not fall back to dialogs"); },
					input: async () => { throw new Error("should not fall back to dialogs"); },
					notify: () => {},
					custom: async () => { throw new Error("editor mode must not use ctx.ui.custom()"); },
					theme,
					getEditorText: () => "human's in-progress draft",
					getEditorComponent: () => previousFactory,
					setEditorComponent: (factory: ((...args: unknown[]) => unknown) | undefined) => { setCalls.push(factory); },
				} as any,
			} as ExtensionContext;
			return { ctx, setCalls, previousFactory };
		}

		it("never touches ctx.ui.custom() -- hosts the AskComponent via setEditorComponent instead", async () => {
			const { ctx, setCalls } = editorCtx();
			const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }], displayMode: "editor" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(setCalls).toHaveLength(1);
			const host = (setCalls[0] as any)({ terminal: { rows: 40 }, requestRender: () => {} }, { borderColor: (s: string) => s, selectList: {} }, keybindings);
			host.handleInput(ENTER);
			const answer = await promise;
			expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
		});

		it("restores the exact previous editor factory once answered, and the host's getText() always returns the preserved draft verbatim", async () => {
			const { ctx, setCalls, previousFactory } = editorCtx();
			const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], displayMode: "editor" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			const host = (setCalls[0] as any)({ terminal: { rows: 40 }, requestRender: () => {} }, { borderColor: (s: string) => s, selectList: {} }, keybindings);
			// setEditorComponent's own swap logic reads getText() off the outgoing editor to carry a
			// draft forward -- must never report anything but the human's real preserved text, even
			// after setText() is called on it (Pi's swap machinery calls setText with the prior text
			// when installing a NEW custom editor, not this one, but the contract must hold regardless).
			host.setText("anything else");
			expect(host.getText()).toBe("human's in-progress draft");
			host.handleInput(ENTER);
			await promise;
			expect(setCalls).toHaveLength(2);
			expect(setCalls[1]).toBe(previousFactory);
		});

		it("degrades to inline (ctx.ui.custom(), not setEditorComponent) when setEditorComponent isn't available in this UI mode", async () => {
			const tui = { terminal: { rows: 40 }, requestRender: () => {} };
			const ctx = {
				cwd: "/tmp", hasUI: true,
				ui: {
					select: async () => { throw new Error("unexpected"); }, input: async () => { throw new Error("unexpected"); }, notify: () => {},
					custom: async (factory: any) => new Promise((resolve) => { const component = factory(tui, theme, keybindings, resolve); component.handleInput(ENTER); }),
				} as any,
			} as ExtensionContext;
			const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], displayMode: "editor" });
			expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
		});
	});
});
