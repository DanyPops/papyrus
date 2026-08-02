import { describe, expect, it } from "bun:test";
import type { DiscussionAndRounds } from "@danypops/papyrus";
import type { PiVehicleInvocationRequest } from "@danypops/vehicle-client-pi";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discussLiveFollowUp } from "../extension/src/discuss-live-follow-up.ts";

const OPENED_DISCUSSION = {
	id: "d1",
	kind: "task",
	subtype: "discussion",
	title: "Ship or not?",
	status: "in-progress",
	body: "",
	labels: [],
	extra: { discussion: { state: "active", roundCount: 1 } },
	created_at: "x",
	updated_at: "x",
};

function fakeRequest(overrides: Partial<PiVehicleInvocationRequest> = {}): PiVehicleInvocationRequest {
	return {
		descriptor: {} as PiVehicleInvocationRequest["descriptor"],
		manifest: {} as PiVehicleInvocationRequest["manifest"],
		toolName: "discuss_open",
		toolCallId: "call-1",
		input: { live: true },
		context: {
			hasUI: true,
			ui: { select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async () => undefined },
		} as unknown as ExtensionContext,
		...overrides,
	};
}

function fakeClient(overrides: Partial<VehicleClient> = {}): { client: VehicleClient; calls: Array<{ name: string; input: unknown }> } {
	const calls: Array<{ name: string; input: unknown }> = [];
	const client: VehicleClient = {
		manifest: async () => ({ name: "papyrus", version: "1.0.0", description: "", operations: [] }),
		invoke: (async (name: string, _version: number, input: unknown) => {
			calls.push({ name, input });
			if (name === "discuss.reply") {
				return {
					discussion: { ...OPENED_DISCUSSION, title: "Ship or not?" },
					rounds: [
						{ id: 2, discussionId: "d1", roundNumber: 2, actor: "human", content: (input as { content: string }).content, occurredAt: "x" },
					],
				};
			}
			throw new Error(`unexpected invoke ${name}`);
		}) as VehicleClient["invoke"],
		close: async () => {},
		...overrides,
	};
	return { client, calls };
}

const OPEN_OUTPUT: DiscussionAndRounds = {
	discussion: OPENED_DISCUSSION as unknown as DiscussionAndRounds["discussion"],
	rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "Should we ship Friday?", occurredAt: "x" }],
};

describe("discussLiveFollowUp", () => {
	it("live not requested: returns undefined without touching ctx.ui at all", async () => {
		let uiTouched = false;
		const request = fakeRequest({
			input: { live: false },
			context: {
				hasUI: true,
				ui: {
					select: async () => {
						uiTouched = true;
						return undefined;
					},
					input: async () => {
						uiTouched = true;
						return undefined;
					},
					notify: () => {},
					custom: async () => undefined,
				},
			} as unknown as ExtensionContext,
		});
		const { client } = fakeClient();
		const result = await discussLiveFollowUp(request, OPEN_OUTPUT, client);
		expect(result).toBeUndefined();
		expect(uiTouched).toBe(false);
	});

	it("live:true but no interactive UI available: degrades silently to undefined (default content/details stand)", async () => {
		const request = fakeRequest({ context: { hasUI: false } as unknown as ExtensionContext });
		const { client } = fakeClient();
		const result = await discussLiveFollowUp(request, OPEN_OUTPUT, client);
		expect(result).toBeUndefined();
	});

	it("live:true with no pending options: prompts freeform via ctx.ui.input using the round's own content as the question, then replies", async () => {
		const inputPrompts: string[] = [];
		const request = fakeRequest({
			context: {
				hasUI: true,
				ui: {
					select: async () => undefined,
					input: async (title: string) => {
						inputPrompts.push(title);
						return "Yes, ship Friday";
					},
					notify: () => {},
					custom: async () => undefined,
				},
			} as unknown as ExtensionContext,
		});
		const { client, calls } = fakeClient();
		const result = await discussLiveFollowUp(request, OPEN_OUTPUT, client);
		expect(inputPrompts).toEqual(["Should we ship Friday?"]);
		expect(result?.content[0]).toMatchObject({ text: '"Ship or not?": Yes, ship Friday' });
		const replyCall = calls.find((call) => call.name === "discuss.reply");
		expect(replyCall?.input).toMatchObject({ id: "d1", actor: "human", content: "Yes, ship Friday", source: "discuss-live" });
	});

	it("live:true with a pending structured choice: renders the picker (ctx.ui.select for single mode), never freeform", async () => {
		const withPending: DiscussionAndRounds = {
			discussion: {
				...OPENED_DISCUSSION,
				extra: {
					discussion: { state: "active", roundCount: 1, pendingOptions: ["Ship Friday", "Slip to Monday"], pendingOptionsMode: "single" },
				},
			} as unknown as DiscussionAndRounds["discussion"],
			rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "q", occurredAt: "x" }],
		};
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		let inputTouched = false;
		const request = fakeRequest({
			context: {
				hasUI: true,
				ui: {
					select: async (title: string, options: string[]) => {
						selectCalls.push({ title, options });
						return "Slip to Monday";
					},
					input: async () => {
						inputTouched = true;
						return undefined;
					},
					notify: () => {},
					custom: async () => undefined,
				},
			} as unknown as ExtensionContext,
		});
		const { client, calls } = fakeClient();
		const result = await discussLiveFollowUp(request, withPending, client);
		expect(inputTouched).toBe(false);
		expect(selectCalls).toEqual([{ title: "q", options: ["Ship Friday", "Slip to Monday", "\u270f\ufe0f Type a custom answer..."] }]);
		expect(result?.content[0]).toMatchObject({ text: '"Ship or not?": Slip to Monday' });
		const replyCall = calls.find((call) => call.name === "discuss.reply");
		expect(replyCall?.input).toMatchObject({ selected: ["Slip to Monday"] });
	});

	it("live:true where the human cancels the prompt: returns undefined, never calls discuss.reply", async () => {
		const request = fakeRequest({
			context: {
				hasUI: true,
				ui: { select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async () => undefined },
			} as unknown as ExtensionContext,
		});
		const { client, calls } = fakeClient();
		const result = await discussLiveFollowUp(request, OPEN_OUTPUT, client);
		expect(result).toBeUndefined();
		expect(calls.filter((call) => call.name === "discuss.reply")).toHaveLength(0);
	});

	it("streams a heartbeat onUpdate before blocking on the human, so a slow human response isn't mistaken for a dead tool call", async () => {
		const updates: unknown[] = [];
		const request = fakeRequest({
			onUpdate: (update) => updates.push(update),
			context: {
				hasUI: true,
				ui: { select: async () => undefined, input: async () => "Yes", notify: () => {}, custom: async () => undefined },
			} as unknown as ExtensionContext,
		});
		const { client } = fakeClient();
		await discussLiveFollowUp(request, OPEN_OUTPUT, client);
		expect(updates).toHaveLength(1);
		expect((updates[0] as { content: { text: string }[] }).content[0]?.text).toBe("Waiting for human input...");
	});

	it("falls back to the degenerate 'Reply to <title>:' question only when the round's own content is empty", async () => {
		const emptyContentOutput: DiscussionAndRounds = {
			discussion: OPENED_DISCUSSION as unknown as DiscussionAndRounds["discussion"],
			rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "assistant", content: "", occurredAt: "x" }],
		};
		const inputPrompts: string[] = [];
		const request = fakeRequest({
			context: {
				hasUI: true,
				ui: {
					select: async () => undefined,
					input: async (title: string) => {
						inputPrompts.push(title);
						return "answer";
					},
					notify: () => {},
					custom: async () => undefined,
				},
			} as unknown as ExtensionContext,
		});
		const { client } = fakeClient();
		await discussLiveFollowUp(request, emptyContentOutput, client);
		expect(inputPrompts).toEqual(['Reply to "Ship or not?":']);
	});
});
