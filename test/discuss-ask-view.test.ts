import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
	askQuestion,
	ensureTypingCourtesyTracking,
	isLiveAskPending,
	isRecentlyTyping,
	resetTypingCourtesyTrackingForTests,
	setTypingCourtesyTimingForTests,
	waitForTypingCourtesy,
} from "../extension/src/discuss-ask-view.ts";

const originalEnv = { ...process.env };
// The ambient keystroke clock is module-level state (deliberately -- see ensureTypingCourtesyTracking's
// own comment) shared across every test in this file; reset it so one test's simulated typing can't
// bleed into another's. None of the tests outside the dedicated "typing courtesy" block below ever
// simulate a keystroke, so isRecentlyTyping() stays false for them without any extra setup.
beforeEach(() => {
	resetTypingCourtesyTrackingForTests();
	setTypingCourtesyTimingForTests();
});
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
});

const theme = { bold: (t: string) => t, italic: (t: string) => t, underline: (t: string) => t, strikethrough: (t: string) => t, fg: (_c: string, t: string) => t } as Theme;
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const ENTER = "\r";
const ESCAPE = "\x1b";

/**
 * setEditorComponent as the real interactive TUI would run it, exercising the genuine
 * AskComponent/WrappedSingleSelectList/MultiSelectList code the same way a real session would.
 * Ignores the SECOND setEditorComponent call (restoring the previous factory once answered)
 * rather than treating it as a new ask.
 */
function interactiveCtx(keySequence: string[]): ExtensionContext {
	const tui = { terminal: { rows: 40 }, requestRender: () => {} };
	let installed = false;
	return {
		cwd: "/tmp", hasUI: true,
		ui: {
			select: async () => { throw new Error("should not fall back to dialog select in interactive mode"); },
			input: async () => { throw new Error("should not fall back to dialog input in interactive mode"); },
			notify: () => {},
			theme,
			getEditorText: () => "",
			getEditorComponent: () => undefined,
			setEditorComponent: (factory: any) => {
				if (installed || !factory) { installed = false; return; }
				installed = true;
				const host = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keybindings);
				for (const key of keySequence) host.handleInput(key);
			},
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
				notify: () => {}, theme, getEditorText: () => "", getEditorComponent: () => undefined,
				setEditorComponent: (factory: any) => { if (factory) component = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keybindings); },
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
				theme, getEditorText: () => "", getEditorComponent: () => undefined,
				setEditorComponent: (factory: any) => { if (factory) factory(tui, { borderColor: (s: string) => s, selectList: {} }, keybindings); },
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
		let component: { render: (w: number) => string[]; handleInput: (data: string) => void } | undefined;
		const ctx = {
			cwd: "/tmp", hasUI: true,
			ui: {
				select: async () => { throw new Error("unexpected"); }, input: async () => { throw new Error("unexpected"); }, notify: () => {},
				theme, getEditorText: () => "", getEditorComponent: () => undefined,
				setEditorComponent: (factory: any) => { if (factory) component = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keybindings); },
			} as any,
		} as ExtensionContext;
		const pending = askQuestion(ctx, { question: "Should we ship Friday?", subtitle: "Ship or not?" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = component!.render(100).join("\n");
		expect(rendered).toContain("Ship or not?"); // subtitle present
		expect(rendered).not.toContain("Question"); // no generic header
		expect(rendered).not.toContain("Custom answer"); // no options to contrast against
		component!.handleInput(ESCAPE);
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
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async () => undefined, input: async (title: string) => { prompts.push(title); return "42"; }, notify: () => {} } } as unknown as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "How many replicas?" });
		expect(prompts).toEqual(["How many replicas?"]);
		expect(answer).toEqual({ content: "42" });
	});

	it("freeform-only cancel (empty answer) resolves to undefined, not an empty content string", async () => {
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async () => undefined, input: async () => undefined, notify: () => {} } } as unknown as ExtensionContext;
		expect(await askQuestion(ctx, { question: "How many replicas?" })).toBeUndefined();
	});

	it("degrades to the dialog fallback (ctx.ui.select) when setEditorComponent isn't available -- RPC/headless mode", async () => {
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return "Ship Friday"; }, input: async () => undefined, notify: () => {} } } as unknown as ExtensionContext;
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
				notify: () => {},
			},
		} as unknown as ExtensionContext;
		const answer = await askQuestion(ctx, { question: "How many replicas?" });
		expect(observedDuringAsk).toBe(true);
		expect(isLiveAskPending()).toBe(false);
		expect(answer).toEqual({ content: "42" });
	});

	it("isLiveAskPending() still clears on cancel, so a rejected/cancelled ask never leaves the guard stuck open", async () => {
		const ctx = { cwd: "/tmp", hasUI: true, ui: { select: async () => undefined, input: async () => undefined, notify: () => {} } } as unknown as ExtensionContext;
		await askQuestion(ctx, { question: "How many replicas?" });
		expect(isLiveAskPending()).toBe(false);
	});

	/** The picker is always hosted via ctx.ui.setEditorComponent, Pi's own slash-command menu mechanism. */
	describe("hosted in the real input editor via setEditorComponent -- the only interactive path", () => {
		function editorCtx() {
			const setCalls: Array<((...args: unknown[]) => unknown) | undefined> = [];
			const previousFactory = () => "previous-editor-sentinel";
			const ctx = {
				cwd: "/tmp", hasUI: true,
				ui: {
					select: async () => { throw new Error("should not fall back to dialogs"); },
					input: async () => { throw new Error("should not fall back to dialogs"); },
					notify: () => {},
					theme,
					getEditorText: () => "human's in-progress draft",
					getEditorComponent: () => previousFactory,
					setEditorComponent: (factory: ((...args: unknown[]) => unknown) | undefined) => { setCalls.push(factory); },
				} as any,
			} as ExtensionContext;
			return { ctx, setCalls, previousFactory };
		}

		it("hosts the AskComponent via setEditorComponent", async () => {
			const { ctx, setCalls } = editorCtx();
			const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }, { title: "Slip to Monday" }] });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(setCalls).toHaveLength(1);
			const host = (setCalls[0] as any)({ terminal: { rows: 40 }, requestRender: () => {} }, { borderColor: (s: string) => s, selectList: {} }, keybindings);
			host.handleInput(ENTER);
			const answer = await promise;
			expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
		});

		it("restores the exact previous editor factory once answered, and the host's getText() always returns the preserved draft verbatim", async () => {
			const { ctx, setCalls, previousFactory } = editorCtx();
			const promise = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
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

		it("degrades to the plain dialog fallback, never a floating overlay, when setEditorComponent isn't available in this UI mode", async () => {
			const selectCalls: Array<{ title: string; options: string[] }> = [];
			const ctx = {
				cwd: "/tmp", hasUI: true,
				ui: {
					select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return "Ship Friday"; },
					input: async () => { throw new Error("unexpected"); }, notify: () => {},
				} as any,
			} as ExtensionContext;
			const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
			expect(selectCalls).toHaveLength(1);
			expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
		});
	});

	/**
	 * Politeness: a live ask must not pop over the human actively typing. Real keystrokes via
	 * ctx.ui.onTerminalInput, not editor text content -- content can't distinguish "actively typing"
	 * from "a stale draft sitting there", and misses a mid-thought erase-and-resume. isRecentlyTyping
	 * is a plain synchronous check so the common (nobody typing) case never adds an await -- an
	 * unconditional await, even one that resolves immediately, still yields a microtask, which is
	 * enough for a signal aborted synchronously right after invoking askQuestion to race past the
	 * deeper abort listener and get missed (caught live in this file's own "signal DOES cancel" test
	 * above once an unconditional wait was first added).
	 */
	describe("typing courtesy: waits out real keystroke activity before asking", () => {
		function fakeTypingUi(): { ui: any; keystroke: () => void } {
			let handler: ((data: string) => unknown) | undefined;
			const ui = { onTerminalInput: (h: (data: string) => unknown) => { handler = h; return () => {}; } };
			return { ui, keystroke: () => handler?.("x") };
		}

		it("isRecentlyTyping: false at rest, and false when onTerminalInput isn't available in this UI mode", () => {
			expect(isRecentlyTyping()).toBe(false);
			ensureTypingCourtesyTracking({} as any);
			expect(isRecentlyTyping()).toBe(false);
		});

		it("isRecentlyTyping: true immediately after a real keystroke arrives through the tracked ui", () => {
			const { ui, keystroke } = fakeTypingUi();
			ensureTypingCourtesyTracking(ui);
			expect(isRecentlyTyping()).toBe(false);
			keystroke();
			expect(isRecentlyTyping()).toBe(true);
		});

		it("tracking is ambient, not per-ask: a keystroke observed before an ask starts still counts", () => {
			// The exact case this feature protects: typing already in progress when the tool call
			// begins, not just typing that starts after. ensureTypingCourtesyTracking is idempotent per
			// distinct ui instance, matching how it's actually attached once from session_start.
			const { ui, keystroke } = fakeTypingUi();
			ensureTypingCourtesyTracking(ui);
			keystroke();
			ensureTypingCourtesyTracking(ui); // a later ask's call site re-invoking it must not reset anything
			expect(isRecentlyTyping()).toBe(true);
		});

		it("waitForTypingCourtesy resolves once the required quiet gap has elapsed since the last keystroke", async () => {
			setTypingCourtesyTimingForTests({ pollMs: 5, initialQuietMs: 40, floorMs: 40, decayHorizonMs: 1000 });
			const { ui, keystroke } = fakeTypingUi();
			ensureTypingCourtesyTracking(ui);
			keystroke();
			let waitedMessage: string | undefined;
			const start = Date.now();
			await waitForTypingCourtesy({ onUpdate: (update: any) => { waitedMessage = update.content?.[0]?.text; } });
			expect(Date.now() - start).toBeGreaterThanOrEqual(35);
			expect(waitedMessage).toContain("finish typing");
		});

		it("a fresh keystroke mid-wait pushes the resolution out further -- true debounce, not a fixed timer from the first keystroke", async () => {
			setTypingCourtesyTimingForTests({ pollMs: 5, initialQuietMs: 60, floorMs: 60, decayHorizonMs: 10_000 });
			const { ui, keystroke } = fakeTypingUi();
			ensureTypingCourtesyTracking(ui);
			keystroke();
			const start = Date.now();
			setTimeout(() => keystroke(), 30); // resets the quiet gap before the first one would have elapsed
			await waitForTypingCourtesy({});
			expect(Date.now() - start).toBeGreaterThanOrEqual(85);
		});

		it("decays: the required quiet gap shrinks the longer someone types continuously, converging on the floor", async () => {
			// A steady 20ms drip of keystrokes: under the wide initial quiet gap (200ms) this would never
			// settle, but once decayed to the 5ms floor (well below the drip interval) a natural gap
			// between two keystrokes clears it -- proves the required gap actually shrinks over time,
			// not just that it eventually gives up. clearInterval is in a finally: this loop must never
			// leak into later tests by continuing to touch the shared keystroke clock past this test.
			setTypingCourtesyTimingForTests({ pollMs: 5, initialQuietMs: 200, floorMs: 5, decayHorizonMs: 150 });
			const { ui, keystroke } = fakeTypingUi();
			ensureTypingCourtesyTracking(ui);
			keystroke();
			const interval = setInterval(() => keystroke(), 20);
			const start = Date.now();
			try {
				await waitForTypingCourtesy({});
			} finally {
				clearInterval(interval);
			}
			expect(Date.now() - start).toBeGreaterThanOrEqual(90);
			expect(Date.now() - start).toBeLessThan(1000);
		});

		it("stops immediately when the tool call's own signal aborts mid-wait", async () => {
			setTypingCourtesyTimingForTests({ pollMs: 5, initialQuietMs: 5000, floorMs: 5000, decayHorizonMs: 10_000 });
			const { ui, keystroke } = fakeTypingUi();
			ensureTypingCourtesyTracking(ui);
			keystroke();
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 20);
			const start = Date.now();
			await waitForTypingCourtesy({ signal: controller.signal });
			expect(Date.now() - start).toBeLessThan(500);
		});

		it("end-to-end through askQuestion: the picker does not open while real keystrokes are still arriving", async () => {
			setTypingCourtesyTimingForTests({ pollMs: 5, initialQuietMs: 40, floorMs: 40, decayHorizonMs: 1000 });
			const tui = { terminal: { rows: 40 }, requestRender: () => {} };
			let handler: ((data: string) => unknown) | undefined;
			let hostedAt = 0;
			const start = Date.now();
			const ctx = {
				cwd: "/tmp", hasUI: true,
				ui: {
					select: async () => { throw new Error("should not fall back to dialogs"); },
					input: async () => { throw new Error("should not fall back to dialogs"); },
					notify: () => {}, theme, getEditorText: () => "", getEditorComponent: () => undefined,
					onTerminalInput: (h: (data: string) => unknown) => { handler = h; return () => {}; },
					setEditorComponent: (factory: any) => {
						if (!factory) return;
						hostedAt = Date.now() - start;
						const host = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keybindings);
						host.handleInput(ENTER);
					},
				} as any,
			} as ExtensionContext;
			ensureTypingCourtesyTracking(ctx.ui);
			handler?.("x"); // simulates typing already in progress when the ask begins
			const answer = await askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
			expect(hostedAt).toBeGreaterThanOrEqual(35);
			expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
		});
	});
});
