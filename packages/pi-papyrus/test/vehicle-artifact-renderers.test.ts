import { describe, expect, it } from "bun:test";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { ArtifactListCard } from "../extension/src/tool-rendering/artifact-list.ts";
import { parsePapyrusToolDetails } from "../extension/src/tool-rendering/render-model.ts";
import { papyrusVehiclePresentations, papyrusVehicleRenderers } from "../extension/src/tools/vehicle-artifact-renderers.ts";

// expandHint() calls Pi's own keyHint(), which reads Pi's global theme singleton
// (not this file's own fakeTheme below).
initTheme();

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function descriptor(name: string): VehicleOperationDescriptor {
	return {
		name,
		version: 1,
		description: "",
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
	};
}

function resultContext(overrides: Record<string, unknown> = {}) {
	return { cwd: "/tmp", isError: false, ...overrides } as never;
}

const vehicleIdentity = { name: "papyrus", version: "1", operation: "tasks.list", operationVersion: 1, toolCallId: "call-1" };

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		kind: "task",
		title: "A real task",
		status: "todo",
		subtype: "",
		body: "some body text",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("papyrusVehicleRenderers", () => {
	const { renderResult } = papyrusVehicleRenderers(descriptor("tasks.list"));

	it("provides renderCall too, delegating to the generic renderer -- never falls back to Pi's own default raw-args display", () => {
		const { renderCall } = papyrusVehicleRenderers(descriptor("tasks.update"));
		const component = renderCall!({ id: "task-1", title: "New title" }, fakeTheme, { cwd: "/tmp" } as never);
		const text = component.render(80).join("\n");
		expect(text.length).toBeGreaterThan(0);
		expect(text).toContain("Tasks Update");
	});

	it("renders an artifact-array output as the curated list card, not a raw column dump", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: [artifact({ title: "First" }), artifact({ title: "Second" })] } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("First");
		expect(text).toContain("Second");
		expect(text).not.toContain("some body text");
	});

	/**
	 * Regression: tasks.list's own documented default ("Returns a lean summary (no body/extra)
	 * unless full: true is passed") returns ArtifactSummary rows -- no body/extra field at all.
	 * isArtifact()'s type guard required body as a string, so every default (lean, the common
	 * case) list call for tasks.list/docs.list/rules.list/playbooks.list silently fell through to
	 * the generic raw Vehicle renderer instead of the curated ArtifactListCard. Every existing
	 * array-rendering test above used the full artifact() fixture (always carrying body), so this
	 * gap was invisible until a real, undecorated lean tasks.list call was observed live.
	 */
	it("renders a lean (no body/extra) artifact-array output -- tasks.list's own documented default shape -- as the curated list card", () => {
		const leanSummary = (title: string) => ({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			kind: "task",
			title,
			status: "todo",
			subtype: "",
			labels: [],
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			alias: "a-real-task",
		});
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: [leanSummary("First"), leanSummary("Second")] } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		// A bare text/absence check on the rendered lines isn't discriminating enough here: the
		// generic Vehicle renderer's fallback BoundedTable also happens to print each row's title
		// verbatim as a column value. Only an identity check on the actual component actually proves
		// which renderer ran.
		expect(component).toBeInstanceOf(ArtifactListCard);
		const text = component.render(80).join("\n");
		expect(text).toContain("First");
		expect(text).toContain("Second");
	});

	it("renders a single artifact output as the curated artifact card", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: artifact({ title: "Just one" }) } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("Just one");
	});

	it("falls back to the generic Vehicle renderer for a non-artifact output", () => {
		// A flat all-primitive object is exactly the shape the generic renderer's own
		// flatRecordEnvelope now handles as a field list (vehicle-render.test.ts covers
		// that rendering itself) -- this test only cares that it's NOT mistaken for a
		// papyrus Artifact and routed to ArtifactCard.
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: { ok: true } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Ok");
		expect(text).toContain("true");
	});

	it("renders task lease responses with the reusable task name and title instead of a Task Id field", () => {
		const { renderResult: renderClaim } = papyrusVehicleRenderers(descriptor("tasks.claim"));
		const component = renderClaim!(
			{
				content: [],
				details: {
					vehicle: vehicleIdentity,
					output: {
						taskName: "lector-adaptive-resource-harness",
						taskTitle: "Lector: add adaptive resource harness",
						owner: "worker-a",
						token: "9dfc97cc-ab19-4dac-8098-3d62cd5dfa2a",
						claimedAt: "2026-01-01T00:00:00.000Z",
						leaseExpiresAt: "2026-01-01T01:00:00.000Z",
					},
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(100).join("\n");
		expect(text).toContain("lector-adaptive-resource-harness");
		expect(text).toContain("Lector: add adaptive resource harness");
		expect(text).not.toContain("Task Id");
	});

	it("falls back to the generic renderer for a partial (progress) result", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, progress: { current: 1, total: 2 } } },
			{ isPartial: true, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(40).join("\n")).toContain("50%");
	});

	it("falls back to the generic renderer on error, ignoring an otherwise artifact-shaped output", () => {
		const component = renderResult!(
			{ content: [{ type: "text", text: "backend unreachable" }], details: { vehicle: vehicleIdentity, output: artifact() } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext({ isError: true }),
		);
		expect(component.render(80).join("\n")).toContain("backend unreachable");
	});

	it("renders tasks.focused/pause/unpause's {artifact, status, updatedAt} wrapper as the curated artifact card, not a raw JSON dump", () => {
		const { renderResult: renderFocused } = papyrusVehicleRenderers(descriptor("tasks.focused"));
		const component = renderFocused!(
			{
				content: [],
				details: {
					vehicle: vehicleIdentity,
					output: { artifact: artifact({ title: "Focused task" }), status: "active", updatedAt: "2026-01-02T00:00:00.000Z" },
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Focused task");
		expect(text).toContain("focus active");
	});

	it("distinguishes a paused focus, including its reason, from the artifact's own lifecycle status", () => {
		const { renderResult: renderPause } = papyrusVehicleRenderers(descriptor("tasks.pause"));
		const component = renderPause!(
			{
				content: [],
				details: {
					vehicle: vehicleIdentity,
					output: {
						artifact: artifact({ title: "Paused task", status: "in-progress" }),
						status: "paused",
						updatedAt: "2026-01-02T00:00:00.000Z",
						pauseReason: "waiting on review",
					},
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("in-progress"); // the artifact's own lifecycle status, unchanged
		expect(text).toContain("focus paused");
		expect(text).toContain("waiting on review");
	});

	it("renders a friendly message for tasks.focused's null (nothing focused) output, not the literal word 'null'", () => {
		const { renderResult: renderFocused } = papyrusVehicleRenderers(descriptor("tasks.focused"));
		const component = renderFocused!(
			{ content: [], details: { vehicle: vehicleIdentity, output: null } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text.toLowerCase()).toContain("no focused task");
		expect(text).not.toBe("null");
	});

	it("does not misrender an unrelated null output as a focus state -- scoped to tasks.focused by name", () => {
		const { renderResult: renderShow } = papyrusVehicleRenderers(descriptor("docs.show"));
		const component = renderShow!(
			{ content: [], details: { vehicle: vehicleIdentity, output: null } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n").toLowerCase()).not.toContain("focused");
	});

	it("renders tasks.plan's TaskExecutionPlan through DagView -- layers, a blocked node's dependency, and a cycle section", () => {
		const { renderResult: renderPlan } = papyrusVehicleRenderers(descriptor("tasks.plan"));
		const plan = {
			nodes: [
				{ id: "a", title: "Task A", status: "todo", active: false, state: "ready", layer: 0, prerequisiteIds: [], successorIds: ["b"] },
				{
					id: "b",
					title: "Task B",
					status: "todo",
					active: false,
					state: "blocked",
					layer: 1,
					prerequisiteIds: ["a"],
					successorIds: [],
				},
				{ id: "x", title: "Task X", status: "todo", active: false, state: "invalid", layer: null, prerequisiteIds: [], successorIds: [] },
				{ id: "y", title: "Task Y", status: "todo", active: false, state: "invalid", layer: null, prerequisiteIds: [], successorIds: [] },
			],
			layers: [["a"], ["b"]],
			cycleIds: ["x", "y"],
		};
		const component = renderPlan!(
			{ content: [], details: { vehicle: vehicleIdentity, output: plan } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");
		expect(text).toContain("depends on");
		expect(text.split("depends on")[1]).toContain("Task A");
		expect(text).toContain("Task X");
		expect(text).toContain("Task Y");
		expect(text).toContain("Cycle");
	});

	it("renders playbooks.invoke's PlaybookInvocationResult through DagView with a created-summary line, not raw JSON", () => {
		const { renderResult: renderInvoke } = papyrusVehicleRenderers(descriptor("playbooks.invoke"));
		const result = {
			playbookId: "pb-1",
			runId: "run-1",
			arguments: {},
			created: { docs: ["d1"], rules: [], tasks: ["t1", "t2"] },
			rootTaskIds: ["t1"],
			entryTaskId: "t1",
			execution: {
				nodes: [
					{
						id: "t1",
						title: "Step one",
						status: "todo",
						active: true,
						state: "ready",
						layer: 0,
						prerequisiteIds: [],
						successorIds: ["t2"],
					},
					{
						id: "t2",
						title: "Step two",
						status: "todo",
						active: false,
						state: "blocked",
						layer: 1,
						prerequisiteIds: ["t1"],
						successorIds: [],
					},
				],
				layers: [["t1"], ["t2"]],
				cycleIds: [],
			},
			content: [{ type: "text", text: "Invoked playbook run run-1" }],
		};
		const component = renderInvoke!(
			{ content: [], details: { vehicle: vehicleIdentity, output: result } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Step one");
		expect(text).toContain("Step two");
		expect(text).toContain("depends on");
		expect(text).toContain("2 task");
		expect(text).toContain("1 doc");
		expect(text).not.toContain("{");
	});

	it("renders playbooks.invoke's missingArguments case as a clear warning, not raw JSON", () => {
		const { renderResult: renderInvoke } = papyrusVehicleRenderers(descriptor("playbooks.invoke"));
		const result = {
			playbookId: "pb-1",
			missingArguments: ["jira_ticket"],
			content: [{ type: "text", text: "Missing required argument(s)" }],
		};
		const component = renderInvoke!(
			{ content: [], details: { vehicle: vehicleIdentity, output: result } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text.toLowerCase()).toContain("missing");
		expect(text).toContain("jira_ticket");
		expect(text).not.toContain("{");
	});

	function round(overrides: Record<string, unknown> = {}) {
		return {
			id: 1,
			discussionId: "d1",
			roundNumber: 1,
			actor: "agent",
			content: "First message",
			occurredAt: "2026-01-01T00:00:00.000Z",
			...overrides,
		};
	}

	it("renders discuss.open/reply/show's {discussion, rounds, content} as a labeled discussion card with a rounds transcript, not raw JSON", () => {
		for (const op of ["discuss.open", "discuss.reply", "discuss.show"]) {
			const { renderResult: renderDiscuss } = papyrusVehicleRenderers(descriptor(op));
			const output = {
				discussion: artifact({ kind: "task", title: "Should we do X?", status: "in-progress" }),
				rounds: [
					round({ roundNumber: 1, actor: "agent", content: "Opening question" }),
					round({ roundNumber: 2, actor: "human", content: "My answer" }),
				],
				content: [{ type: "text", text: "Opened discussion" }],
			};
			const component = renderDiscuss!(
				{ content: [], details: { vehicle: vehicleIdentity, output } },
				{ isPartial: false, expanded: true },
				fakeTheme,
				resultContext(),
			);
			const text = component.render(80).join("\n");
			expect(text).toContain("Should we do X?");
			expect(text).toContain("Opening question");
			expect(text).toContain("My answer");
			expect(text).not.toContain("{");
		}
	});

	it("collapses discuss.open/reply/show's rounds transcript when not expanded, with a count + expand hint", () => {
		const { renderResult: renderDiscuss } = papyrusVehicleRenderers(descriptor("discuss.open"));
		const output = {
			discussion: artifact({ title: "Should we do X?" }),
			rounds: [round({ content: "Opening question" })],
			content: [{ type: "text", text: "Opened discussion" }],
		};
		const component = renderDiscuss!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Should we do X?");
		expect(text).not.toContain("Opening question");
		expect(text).toContain("1 round");
	});

	it("renders discuss.rounds' {rounds, content} as a bare transcript, not raw JSON", () => {
		const { renderResult: renderRounds } = papyrusVehicleRenderers(descriptor("discuss.rounds"));
		const output = {
			rounds: [
				round({ roundNumber: 1, actor: "agent", content: "Opening question" }),
				round({ roundNumber: 2, actor: "human", content: "My answer" }),
			],
			content: [{ type: "text", text: "transcript" }],
		};
		const component = renderRounds!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Opening question");
		expect(text).toContain("My answer");
		expect(text).not.toContain("{");
	});

	it("renders discuss.list's {discussions, content} as the curated list card, not raw JSON", () => {
		const { renderResult: renderList } = papyrusVehicleRenderers(descriptor("discuss.list"));
		const output = {
			discussions: [artifact({ title: "First discussion" }), artifact({ title: "Second discussion" })],
			content: [{ type: "text", text: "2 discussions" }],
		};
		const component = renderList!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("First discussion");
		expect(text).toContain("Second discussion");
		expect(text).not.toContain("{");
	});

	it("discuss.block/unblock's {blocked, content} single-array envelope already renders as plain text, not raw JSON -- verified, not assumed", () => {
		const { renderResult: renderBlock } = papyrusVehicleRenderers(descriptor("discuss.block"));
		const output = { blocked: true, content: [{ type: "text", text: 'Discussion "X" now blocks "Y"' }] };
		const component = renderBlock!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("now blocks");
		expect(text).not.toContain("{");
	});

	it("renders tasks.complete's TaskCompletion as labeled fields plus gate/checklist summaries, not raw JSON", () => {
		const { renderResult: renderComplete } = papyrusVehicleRenderers(descriptor("tasks.complete"));
		const output = {
			artifact: artifact({ title: "Ship the feature", status: "done" }),
			gates: [{ gate: { type: "command", target: "bun test" }, passed: true, output: "ok" }],
			checklist: [{ item: "Tests pass", proof: [], accepted: true }],
			completed: true,
			focused: artifact({ title: "Next task" }),
			blocked: [],
			content: [{ type: "text", text: "Completed" }],
		};
		const component = renderComplete!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Ship the feature");
		expect(text).toContain("Tests pass");
		expect(text).not.toContain("{");
	});

	it("renders a rejected tasks.complete (gate/checklist failure, still blocked) with the real failure visible, not raw JSON", () => {
		const { renderResult: renderComplete } = papyrusVehicleRenderers(descriptor("tasks.complete"));
		const output = {
			artifact: artifact({ title: "Ship the feature", status: "rejected" }),
			gates: [{ gate: { type: "command", target: "bun test" }, passed: false, output: "1 failing" }],
			checklist: [],
			completed: false,
			focused: null,
			blocked: [{ artifact: artifact({ title: "Dependent task" }), dependencyIds: ["x"] }],
			content: [{ type: "text", text: "Rejected" }],
		};
		const component = renderComplete!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Ship the feature");
		expect(text).toContain("1 failing");
		expect(text).not.toContain("{");
	});
});

describe("papyrusVehiclePresentations", () => {
	async function project(name: string, output: unknown) {
		const { projector } = papyrusVehiclePresentations(descriptor(name));
		return await projector.project(output, {} as never);
	}

	async function renderProjected(name: string, output: unknown, expanded = false) {
		const presentation = await project(name, output);
		const { renderResult } = papyrusVehiclePresentations(descriptor(name));
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, presentation } },
			{ isPartial: false, expanded },
			fakeTheme,
			resultContext(),
		);
		return { presentation, text: component.render(80).join("\n") };
	}

	it("projects every recognized output shape into a validated, versioned PapyrusToolDetails variant, never a raw passthrough", async () => {
		const cases = [
			["tasks.list", [artifact({ title: "A" })], "artifact-list"],
			["tasks.show", artifact({ title: "A" }), "artifact"],
			["tasks.focused", null, "no-focus"],
			["tasks.plan", { nodes: [], layers: [], cycleIds: [] }, "execution-plan"],
			[
				"playbooks.invoke",
				{
					playbookId: "pb-1",
					runId: "run-1",
					created: { docs: [], rules: [], tasks: [] },
					rootTaskIds: [],
					entryTaskId: "t1",
					execution: { nodes: [], layers: [], cycleIds: [] },
				},
				"playbook-invocation",
			],
			["playbooks.invoke", { playbookId: "pb-1", missingArguments: ["x"] }, "playbook-missing-arguments"],
			["discuss.open", { discussion: artifact(), rounds: [] }, "discussion"],
			["discuss.rounds", { rounds: [] }, "discussion"],
			[
				"tasks.complete",
				{ artifact: artifact(), gates: [], checklist: [], completed: true, focused: null, blocked: [] },
				"task-completion",
			],
			[
				"tasks.claim",
				{
					taskName: "t",
					taskTitle: "T",
					owner: "me",
					token: "secret-token",
					claimedAt: "2026-01-01T00:00:00.000Z",
					leaseExpiresAt: "2026-01-01T01:00:00.000Z",
				},
				"lease",
			],
			[
				"tasks.context",
				{
					context: "Progress: 0/5 done",
					content: [{ type: "text", text: "Progress: 0/5 done" }],
				},
				"semantic-text",
			],
		] as const;
		for (const [name, output, expectedKind] of cases) {
			const presentation = await project(name, output);
			const parsed = parsePapyrusToolDetails(presentation);
			expect(parsed, `${name} projected an invalid/unparseable presentation: ${JSON.stringify(presentation)}`).toBeDefined();
			expect(parsed!.kind).toBe(expectedKind);
			expect(parsed!.schemaVersion).toBe("papyrus.tool-details/v1");
			expect(parsed!.operation).toBe(name);
		}
	});

	it("projects a Playbook preview string into bounded presentation details", async () => {
		const preview = "Apply playbook.\n".repeat(2_000);
		const presentation = await project("playbooks.preview", preview);
		const parsed = parsePapyrusToolDetails(presentation);
		expect(parsed).toMatchObject({
			kind: "preview",
			operation: "playbooks.preview",
			title: "Playbook preview",
			completeness: { truncated: true, omitted: preview.length - 20_000 },
		});
		expect(parsed?.kind === "preview" ? parsed.content.length : 0).toBeLessThan(preview.length);
	});

	it("projects an invalid Playbook preview result into an actionable bounded error", async () => {
		const presentation = await project("playbooks.preview", { content: "unexpected shape" });
		expect(parsePapyrusToolDetails(presentation)).toMatchObject({
			kind: "error",
			operation: "playbooks.preview",
			code: "playbook-preview-unprojectable",
			message: "Playbook preview returned no rendered text.",
		});
	});

	it("renders tasks.context from its semantic channel instead of serializing the raw output", async () => {
		const { presentation, text } = await renderProjected("tasks.context", {
			context: "Progress: 0/5 done",
			content: [{ type: "text", text: "Progress: 0/5 done" }],
		});
		expect(text.trimEnd()).toBe("Progress: 0/5 done");
		expect(text).not.toContain('"context"');
		expect(JSON.stringify(presentation)).not.toContain('"content":[{');
	});

	it("rejects an output that has no legal presentation variant", async () => {
		expect(project("some.unrecognized_operation", { anything: "goes" })).rejects.toThrow("no legal presentation");
	});

	it("never persists a lease's raw token in the projected presentation", async () => {
		const presentation = await project("tasks.claim", {
			taskName: "lector-adaptive-resource-harness",
			taskTitle: "Lector: add adaptive resource harness",
			owner: "worker-a",
			token: "9dfc97cc-ab19-4dac-8098-3d62cd5dfa2a",
			claimedAt: "2026-01-01T00:00:00.000Z",
			leaseExpiresAt: "2026-01-01T01:00:00.000Z",
		});
		expect(JSON.stringify(presentation)).not.toContain("9dfc97cc-ab19-4dac-8098-3d62cd5dfa2a");
		const { text } = await renderProjected("tasks.claim", {
			taskName: "lector-adaptive-resource-harness",
			taskTitle: "Lector: add adaptive resource harness",
			owner: "worker-a",
			token: "9dfc97cc-ab19-4dac-8098-3d62cd5dfa2a",
			claimedAt: "2026-01-01T00:00:00.000Z",
			leaseExpiresAt: "2026-01-01T01:00:00.000Z",
		});
		const unwrapped = text.replace(/\n/g, " ");
		expect(unwrapped).toContain("lector-adaptive-resource-harness");
		expect(unwrapped).toContain("Lector: add adaptive resource harness");
		expect(text).not.toContain("9dfc97cc-ab19-4dac-8098-3d62cd5dfa2a");
	});

	it("renders the same curated views as papyrusVehicleRenderers, driven from the typed presentation instead of raw output", async () => {
		const { text } = await renderProjected("tasks.list", [artifact({ title: "First" }), artifact({ title: "Second" })]);
		expect(text).toContain("First");
		expect(text).toContain("Second");
		expect(text).not.toContain("some body text");
	});

	it("falls back to papyrusVehicleRenderers' own legacy renderResult for a historical {vehicle, output} session row with no presentation", () => {
		const { renderResult } = papyrusVehiclePresentations(descriptor("tasks.show"));
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: artifact({ title: "Legacy row" }) } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("Legacy row");
	});

	it("falls back to the legacy renderer for a partial (progress) result, unaffected by the projector", () => {
		const { renderResult } = papyrusVehiclePresentations(descriptor("tasks.list"));
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, progress: { current: 1, total: 2 } } },
			{ isPartial: true, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(40).join("\n")).toContain("50%");
	});

	it("falls back to the legacy renderer on error, regardless of any presentation carried alongside it", async () => {
		const { renderResult } = papyrusVehiclePresentations(descriptor("tasks.show"));
		const presentation = await project("tasks.show", artifact({ title: "Should not show" }));
		const component = renderResult!(
			{ content: [{ type: "text", text: "backend unreachable" }], details: { vehicle: vehicleIdentity, presentation } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext({ isError: true }),
		);
		expect(component.render(80).join("\n")).toContain("backend unreachable");
	});
});
