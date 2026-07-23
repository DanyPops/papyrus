import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import { showDiscussionDetailView } from "../extension/src/discussion-detail-view.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { DiscussionRound } from "../src/domain/discussion.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function discussion(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "discussion-1",
		kind: "doc",
		title: "Naming the thing",
		status: "active",
		subtype: "discussion",
		body: "",
		labels: [],
		extra: { discussion: { state: "active", roundCount: 2 } },
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function rounds(): DiscussionRound[] {
	return [
		{ id: 1, discussionId: "discussion-1", roundNumber: 1, actor: "alice", content: "Should we rename this?", occurredAt: "2026-01-01T00:00:00.000Z" },
		{ id: 2, discussionId: "discussion-1", roundNumber: 2, actor: "bob", content: "Yes, I think so.", occurredAt: "2026-01-01T00:05:00.000Z" },
	];
}

function tuiContext() {
	const notifications: Array<{ message: string; level?: string }> = [];
	const renders: string[][] = [];
	let closed = false;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/workspace/papyrus",
		ui: {
			notify(message: string, level?: string) { notifications.push({ message, level }); },
			async custom(factory: any) {
				const component = await factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					theme,
					{},
					() => { closed = true; },
				);
				renders.push(component.render(80));
				component.handleInput?.("\x1b[B"); // down
				renders.push(component.render(80));
				component.handleInput?.("\x1b[A"); // up
				component.handleInput?.("\x1b"); // escape
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, renders, closed: () => closed };
}

describe("Discussion transcript view", () => {
	it("renders the header, state, and every round's actor/content", async () => {
		const harness = tuiContext();
		await showDiscussionDetailView(harness.ctx, discussion(), rounds());
		const rendered = harness.renders[0]!.join("\n");
		expect(rendered).toContain("Naming the thing");
		expect(rendered).toContain("active");
		expect(rendered).toContain("round 1");
		expect(rendered).toContain("alice");
		expect(rendered).toContain("Should we rename this?");
		expect(rendered).toContain("round 2");
		expect(rendered).toContain("bob");
	});

	it("closes on escape", async () => {
		const harness = tuiContext();
		await showDiscussionDetailView(harness.ctx, discussion(), rounds());
		expect(harness.closed()).toBe(true);
	});

	it("shows deferredReason / settlement when present", async () => {
		const harness = tuiContext();
		await showDiscussionDetailView(
			harness.ctx,
			discussion({ extra: { discussion: { state: "deferred", roundCount: 1, deferredReason: "waiting on design review" } } }),
			[rounds()[0]!],
		);
		expect(harness.renders[0]!.join("\n")).toContain("waiting on design review");
	});

	it("shows 'No rounds recorded.' when a Discussion has none (defensive; open() always writes round 1 in practice)", async () => {
		const harness = tuiContext();
		await showDiscussionDetailView(harness.ctx, discussion(), []);
		expect(harness.renders[0]!.join("\n")).toContain("No rounds recorded.");
	});

	it("shows what was posed and what was picked, per round", async () => {
		const harness = tuiContext();
		const posedRounds: DiscussionRound[] = [
			{ id: 1, discussionId: "discussion-1", roundNumber: 1, actor: "alice", content: "A or B?", occurredAt: "2026-01-01T00:00:00.000Z", options: ["A", "B"], optionsMode: "single" },
			{ id: 2, discussionId: "discussion-1", roundNumber: 2, actor: "bob", content: "Going with B", occurredAt: "2026-01-01T00:05:00.000Z", selected: ["B"] },
		];
		await showDiscussionDetailView(harness.ctx, discussion(), posedRounds);
		const rendered = harness.renders[0]!.join("\n");
		expect(rendered).toContain("Posed (pick one): A, B");
		expect(rendered).toContain("Selected: B");
	});

	it("falls back to a plain notify outside TUI mode", async () => {
		const notifications: Array<{ message: string; level?: string }> = [];
		const ctx = {
			mode: "cli",
			hasUI: false,
			ui: { notify: (message: string, level?: string) => { notifications.push({ message, level }); } },
		} as unknown as ExtensionCommandContext;
		await showDiscussionDetailView(ctx, discussion(), rounds());
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.message).toContain("alice");
	});
});
