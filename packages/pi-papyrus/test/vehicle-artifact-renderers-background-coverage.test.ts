import { describe, it } from "bun:test";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { papyrusVehicleRenderers } from "../extension/src/tools/vehicle-artifact-renderers.ts";
import { assertFullBackgroundCoverage, wrapInRealToolBox } from "./support/background-coverage.ts";
import { realAnsiTheme } from "./support/real-ansi-theme.ts";

/**
 * Same missing-`measure` gap as vehicle-artifact-renderers-wrap-fidelity.test.ts, checked
 * against the OTHER real fidelity contract instead: full-width background paint under the
 * real tool Box (see artifact-card-background-coverage.test.ts for why this needs a real
 * @xterm/headless VT parser, not a string guess).
 */

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

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		kind: "task",
		title: "A real discussion",
		status: "in-progress",
		subtype: "",
		body: "",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const LONG_TEXT =
	"This round's content is deliberately long enough that it must wrap across several physical terminal lines at a realistic width, not fit on one.";

describe("papyrusVehicleRenderers: full-width background coverage under the real tool Box (regression)", () => {
	it("discuss.open's round transcript covers every cell, no gaps", async () => {
		const { renderResult } = papyrusVehicleRenderers(descriptor("discuss.open"));
		const output = {
			discussion: artifact(),
			rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "agent", content: LONG_TEXT, occurredAt: "2026-01-01T00:00:00.000Z" }],
			content: [{ type: "text", text: "Opened discussion" }],
		};
		const component = renderResult!(
			{
				content: [],
				details: { vehicle: { name: "papyrus", version: "1", operation: "discuss.open", operationVersion: 1, toolCallId: "c" }, output },
			},
			{ isPartial: false, expanded: true },
			realAnsiTheme(),
			resultContext(),
		);
		for (const width of [60, 80, 120]) {
			const boxed = wrapInRealToolBox(component, width);
			await assertFullBackgroundCoverage(boxed, width);
		}
	});

	it("tasks.complete's checklist/blocked sections cover every cell, no gaps", async () => {
		const { renderResult } = papyrusVehicleRenderers(descriptor("tasks.complete"));
		const output = {
			artifact: artifact({ title: "Ship the feature", status: "done" }),
			gates: [],
			checklist: [{ item: LONG_TEXT, accepted: true }],
			completed: true,
			focused: null,
			blocked: [{ artifact: artifact({ title: LONG_TEXT }), dependencyIds: ["x"] }],
			content: [{ type: "text", text: "Completed" }],
		};
		const component = renderResult!(
			{
				content: [],
				details: { vehicle: { name: "papyrus", version: "1", operation: "tasks.complete", operationVersion: 1, toolCallId: "c" }, output },
			},
			{ isPartial: false, expanded: true },
			realAnsiTheme(),
			resultContext(),
		);
		for (const width of [60, 80, 120]) {
			const boxed = wrapInRealToolBox(component, width);
			await assertFullBackgroundCoverage(boxed, width);
		}
	});
});
