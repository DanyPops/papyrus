import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
	askQuestion,
	ensureTypingCourtesyTracking,
	isLiveAskPending,
	resetTypingCourtesyTrackingForTests,
} from "../extension/src/discuss/discuss-ask-view.ts";

/**
 * discuss-ask-view.ts is now a thin wrapper over @danypops/vehicle-client-pi's requestPiAskPrompt:
 * the rich single-select/multi-select/freeform/typing-courtesy UI is fully covered by that
 * package's own hitl-ask-prompt.test.ts. This file owns exactly what's Papyrus-specific --
 * resolving PAPYRUS_DISCUSS_* environment preferences into explicit options, and the "discuss"
 * box branding -- driven through the real, unmocked shared component so the translation is
 * verified end to end rather than by asserting on a mocked call shape.
 */
const originalEnv = { ...process.env };
beforeEach(() => {
	resetTypingCourtesyTrackingForTests();
});
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
});

const theme = {
	bold: (t: string) => t,
	italic: (t: string) => t,
	underline: (t: string) => t,
	strikethrough: (t: string) => t,
	fg: (_c: string, t: string) => t,
} as Theme;
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const ENTER = "\r";

function editorHostCtx(): { ctx: ExtensionContext; getComponent: () => Component | undefined } {
	const tui = { terminal: { rows: 40 }, requestRender: () => {} };
	let component: Component | undefined;
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		ui: {
			select: async () => {
				throw new Error("should not fall back to dialogs");
			},
			input: async () => {
				throw new Error("should not fall back to dialogs");
			},
			notify: () => {},
			theme,
			getEditorText: () => "",
			getEditorComponent: () => undefined,
			setEditorComponent: (factory: any) => {
				if (factory) component = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keybindings);
			},
		} as any,
	} as ExtensionContext;
	return { ctx, getComponent: () => component };
}

describe("discuss-ask-view: thin Papyrus wrapper over the shared requestPiAskPrompt", () => {
	it('brands the shared component\'s box with "discuss"', async () => {
		const { ctx, getComponent } = editorHostCtx();
		const pending = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = getComponent()!.render(100).join("\n");
		expect(rendered).toContain("discuss");
		getComponent()!.handleInput?.(ENTER);
		await pending;
	});

	it("PAPYRUS_DISCUSS_ALLOW_COMMENT=true enables the comment-toggle row when the caller didn't set allowComment", async () => {
		process.env.PAPYRUS_DISCUSS_ALLOW_COMMENT = "true";
		const { ctx, getComponent } = editorHostCtx();
		const pending = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = getComponent()!.render(100).join("\n");
		expect(rendered).toContain("Add extra context after");
		getComponent()!.handleInput?.(ENTER);
		await pending;
	});

	it("an explicit allowComment: false call-site override wins over PAPYRUS_DISCUSS_ALLOW_COMMENT=true", async () => {
		process.env.PAPYRUS_DISCUSS_ALLOW_COMMENT = "true";
		const { ctx, getComponent } = editorHostCtx();
		const pending = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], allowComment: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = getComponent()!.render(100).join("\n");
		expect(rendered).not.toContain("Add extra context after");
		getComponent()!.handleInput?.(ENTER);
		await pending;
	});

	it("PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY remaps the shortcut that opens the optional comment editor", async () => {
		process.env.PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY = "ctrl+j";
		const { ctx, getComponent } = editorHostCtx();
		const pending = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], allowComment: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const component = getComponent()!;
		// The old default (ctrl+g) must no longer toggle the comment editor once remapped.
		component.handleInput?.("\x07"); // ctrl+g
		expect(component.render(100).join("\n")).not.toContain("Selected option:");
		component.handleInput?.(ENTER); // submits the selection with no comment requested
		const answer = await pending;
		expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
	});

	it("PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY=ctrl+j does open the comment editor once remapped", async () => {
		process.env.PAPYRUS_DISCUSS_COMMENT_TOGGLE_KEY = "ctrl+j";
		const { ctx, getComponent } = editorHostCtx();
		const pending = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }], allowComment: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const component = getComponent()!;
		component.handleInput?.("\n"); // ctrl+j
		expect(component.render(100).join("\n")).toContain("Add extra context after");
		component.handleInput?.(ENTER); // confirms the selection with the comment toggle now enabled
		component.handleInput?.("Reviewed it");
		component.handleInput?.(ENTER);
		const answer = await pending;
		expect(answer).toEqual({ content: "Ship Friday — Reviewed it", selected: ["Ship Friday"] });
	});

	it("PAPYRUS_DISCUSS_TYPING_COURTESY=false opens the prompt immediately, without waiting out recent keystrokes", async () => {
		process.env.PAPYRUS_DISCUSS_TYPING_COURTESY = "false";
		const tui = { terminal: { rows: 40 }, requestRender: () => {} };
		let handler: ((data: string) => unknown) | undefined;
		let hostedAt = 0;
		const start = Date.now();
		const ctx = {
			cwd: "/tmp",
			hasUI: true,
			ui: {
				select: async () => {
					throw new Error("should not fall back to dialogs");
				},
				input: async () => {
					throw new Error("should not fall back to dialogs");
				},
				notify: () => {},
				theme,
				getEditorText: () => "",
				getEditorComponent: () => undefined,
				onTerminalInput: (h: (data: string) => unknown) => {
					handler = h;
					return () => {};
				},
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
		expect(hostedAt).toBeLessThan(20);
		expect(answer).toEqual({ content: "Ship Friday", selected: ["Ship Friday"] });
	});

	it("isLiveAskPending() is a thin re-export tracking the shared component's own pending state", async () => {
		expect(isLiveAskPending()).toBe(false);
		const { ctx, getComponent } = editorHostCtx();
		const pending = askQuestion(ctx, { question: "Ship or not?", options: [{ title: "Ship Friday" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(isLiveAskPending()).toBe(true);
		getComponent()!.handleInput?.(ENTER);
		await pending;
		expect(isLiveAskPending()).toBe(false);
	});
});
