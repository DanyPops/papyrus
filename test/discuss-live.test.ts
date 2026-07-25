import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDomainTools } from "../extension/src/domain-tools.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

afterEach(resetPapyrusClientForTests);

type ToolUpdate = { content: Array<{ type: "text"; text: string }>; details?: unknown };
type ToolExecute = (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: ((update: ToolUpdate) => void) | undefined, ctx: ExtensionContext) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
interface RegisteredDiscussTool { execute: ToolExecute; executionMode?: string; }

/**
 * Discuss's own ask UI (discuss-ask-view.ts) runs directly -- no capture, no adapter, no
 * separate package. A fake ctx.ui.custom() returning undefined below exercises its real
 * RPC/headless dialog fallback (ctx.ui.select/input), the same path Papyrus runs in non-TUI
 * modes.
 */
function discussTool(): RegisteredDiscussTool {
	const tools = new Map<string, RegisteredDiscussTool>();
	const fakeApi = { registerTool: (tool: RegisteredDiscussTool & { name: string }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	registerDomainTools(fakeApi);
	return tools.get("discuss")!;
}

function discussExecute(): ToolExecute {
	return discussTool().execute;
}

function fakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return { cwd: "/home/dpopsuev/Projects/papyrus", hasUI: true, ui: { select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async () => undefined } as any, ...overrides } as ExtensionContext;
}

function mockCalls(handlers: Record<string, (input: any) => unknown>): Array<{ operation: string; input: unknown }> {
	const calls: Array<{ operation: string; input: unknown }> = [];
	setPapyrusClientConnectorForTests(async () => ({
		async call(operation: string, input: unknown) {
			calls.push({ operation, input });
			const handler = handlers[operation];
			if (!handler) throw new Error(`unexpected operation ${operation}`);
			return handler(input);
		},
	}) as any);
	return calls;
}

const OPENED_DISCUSSION = { id: "d1", kind: "task", subtype: "discussion", title: "Ship or not?", status: "in-progress", body: "", labels: [], extra: { discussion: { state: "active", roundCount: 1 } }, created_at: "x", updated_at: "x" };

describe("discuss tool: live:true synchronous ask, on top of the normal async round", () => {
	it("live:false (default): open just records the round and returns immediately, no ctx.ui touched", async () => {
		const execute = discussExecute();
		let uiTouched = false;
		mockCalls({ "discuss.open": () => ({ discussion: OPENED_DISCUSSION, rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "hi", occurredAt: "x" }] }) });
		const ctx = fakeCtx({ ui: { select: async () => { uiTouched = true; return undefined; }, input: async () => { uiTouched = true; return undefined; }, notify: () => {}, custom: async () => undefined } as any });
		const result = await execute("id1", { action: "open", title: "Ship or not?", actor: "assistant", content: "hi" }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("Opened discussion");
		expect(uiTouched).toBe(false);
	});

	it("live:true with no pending options: prompts freeform via ctx.ui.input and records the live answer as a second round", async () => {
		const execute = discussExecute();
		const calls = mockCalls({
			"discuss.open": () => ({ discussion: OPENED_DISCUSSION, rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "Should we ship Friday?", occurredAt: "x" }] }),
			"discuss.reply": (input: any) => ({ discussion: { ...OPENED_DISCUSSION, title: "Ship or not?" }, rounds: [{ id: 2, discussionId: "d1", roundNumber: 2, actor: "human", content: input.content, occurredAt: "x" }] }),
		});
		const inputPrompts: string[] = [];
		const ctx = fakeCtx({ ui: { select: async () => undefined, input: async (title: string) => { inputPrompts.push(title); return "Yes, ship Friday"; }, notify: () => {}, custom: async () => undefined } as any });
		const result = await execute("id1", { action: "open", title: "Ship or not?", actor: "assistant", content: "Should we ship Friday?", live: true }, undefined, undefined, ctx);
		// Regression: a bare "Reply to <title>:" prompt with no visible question content left the
		// human with nothing to answer -- the just-recorded round's own content must show as context.
		expect(inputPrompts).toEqual(['Reply to "Ship or not?":\n\nContext:\nShould we ship Friday?']);
		expect(result.content[0]!.text).toBe('"Ship or not?": Yes, ship Friday');
		const replyCall = calls.find((call) => call.operation === "discuss.reply");
		expect(replyCall?.input).toMatchObject({ id: "d1", actor: "human", content: "Yes, ship Friday", source: "discuss-live" });
	});

	it("live:true with a pending structured choice: renders the picker (ctx.ui.select for single mode), never the freeform input", async () => {
		const execute = discussExecute();
		const withPending = { ...OPENED_DISCUSSION, extra: { discussion: { state: "active", roundCount: 1, pendingOptions: ["Ship Friday", "Slip to Monday"], pendingOptionsMode: "single" } } };
		const calls = mockCalls({
			"discuss.open": () => ({ discussion: withPending, rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "q", occurredAt: "x", options: ["Ship Friday", "Slip to Monday"], optionsMode: "single" }] }),
			"discuss.reply": (input: any) => ({ discussion: withPending, rounds: [{ id: 2, discussionId: "d1", roundNumber: 2, actor: "human", content: input.content, occurredAt: "x", selected: input.selected }] }),
		});
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		let inputTouched = false;
		const ctx = fakeCtx({ ui: { select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return "Slip to Monday"; }, input: async () => { inputTouched = true; return undefined; }, notify: () => {}, custom: async () => undefined } as any });
		const result = await execute("id1", { action: "open", title: "Ship or not?", actor: "assistant", content: "q", options: ["Ship Friday", "Slip to Monday"], options_mode: "single", live: true }, undefined, undefined, ctx);
		expect(inputTouched).toBe(false);
		expect(selectCalls).toEqual([{ title: 'Reply to "Ship or not?":\n\nContext:\nq', options: ["Ship Friday", "Slip to Monday", "\u270f\ufe0f Type a custom answer..."] }]);
		expect(result.content[0]!.text).toBe('"Ship or not?": Slip to Monday');
		const replyCall = calls.find((call) => call.operation === "discuss.reply");
		expect(replyCall?.input).toMatchObject({ selected: ["Slip to Monday"] });
	});

	it("live:true degrades silently to the async result when there is no interactive UI (RPC/headless)", async () => {
		const execute = discussExecute();
		mockCalls({ "discuss.open": () => ({ discussion: OPENED_DISCUSSION, rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "q", occurredAt: "x" }] }) });
		const ctx = fakeCtx({ hasUI: false });
		const result = await execute("id1", { action: "open", title: "Ship or not?", actor: "assistant", content: "q", live: true }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("Opened discussion");
	});

	it("live:true where the human cancels the prompt: keeps the recorded round, does not fabricate a reply", async () => {
		const execute = discussExecute();
		const calls = mockCalls({ "discuss.reply": () => ({ discussion: OPENED_DISCUSSION, rounds: [{ id: 2, discussionId: "d1", roundNumber: 2, actor: "assistant", content: "q2", occurredAt: "x" }] }) });
		const ctx = fakeCtx({ ui: { select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async () => undefined } as any });
		const result = await execute("id1", { action: "reply", name: "Ship or not?", id: "d1", actor: "assistant", content: "q2", live: true }, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("Round 2 added");
		expect(calls.filter((call) => call.operation === "discuss.reply")).toHaveLength(1);
	});

	// The model must not batch a live ask with bash/edit/write and let those run before the human
	// sees the prompt; matches pi-ask-user's own tool's reasoning.
	it("declares executionMode: sequential, so the model can't batch other tool calls behind a pending live ask", () => {
		expect(discussTool().executionMode).toBe("sequential");
	});

	it("live:true streams a heartbeat onUpdate before blocking on the human, so a slow human response isn't mistaken for a dead tool call", async () => {
		const execute = discussExecute();
		mockCalls({
			"discuss.open": () => ({ discussion: OPENED_DISCUSSION, rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "q", occurredAt: "x" }] }),
			"discuss.reply": (input: any) => ({ discussion: OPENED_DISCUSSION, rounds: [{ id: 2, discussionId: "d1", roundNumber: 2, actor: "human", content: input.content, occurredAt: "x" }] }),
		});
		const updates: ToolUpdate[] = [];
		const ctx = fakeCtx({ ui: { select: async () => undefined, input: async () => "Yes", notify: () => {}, custom: async () => undefined } as any });
		await execute("id1", { action: "open", title: "Ship or not?", actor: "assistant", content: "q", live: true }, undefined, (update) => updates.push(update), ctx);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.content[0]!.text).toBe("Waiting for human input...");
	});
});
