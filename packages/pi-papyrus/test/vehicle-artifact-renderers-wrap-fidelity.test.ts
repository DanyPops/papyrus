import { describe, expect, it } from "bun:test";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { papyrusVehicleRenderers } from "../extension/src/tools/vehicle-artifact-renderers.ts";
import { realAnsiTheme } from "./support/real-ansi-theme.ts";

/**
 * vehicle-artifact-renderers.ts's own buildDetailLines call sites (discuss.open/rounds'
 * roundsSection, tasks.complete's checklist/blocked sections) never pass a real `measure`
 * -- the same gap artifact-card.ts had before it was fixed (see that fix's commit). Without
 * one, buildDetailLines falls back to Malevich's asciiTextMeasure, which slices an
 * already-themed string by raw character index: only the first and last resulting physical
 * lines keep the color escape, every line in between renders in the terminal's default
 * color. Reproduced here against the real papyrusVehicleRenderers entry point (not a
 * hand-rolled buildDetailLines repro), with a real ANSI theme -- a bracket-tag/no-op theme
 * fixture can never exercise this, which is why it went uncaught alongside artifact-card.ts.
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

const vehicleIdentity = { name: "papyrus", version: "1", operation: "discuss.open", operationVersion: 1, toolCallId: "call-1" };

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

describe("papyrusVehicleRenderers: wrapped continuation lines keep their intended foreground styling (regression)", () => {
	it("discuss.open's round transcript keeps the body color on every wrapped continuation line", () => {
		const { renderResult } = papyrusVehicleRenderers(descriptor("discuss.open"));
		const output = {
			discussion: artifact(),
			rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "agent", content: LONG_TEXT, occurredAt: "2026-01-01T00:00:00.000Z" }],
			content: [{ type: "text", text: "Opened discussion" }],
		};
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: true },
			realAnsiTheme(),
			resultContext(),
		);
		const lines = component.render(60);
		const continuationLines = lines.filter(
			(line) => line.includes("physical terminal lines") || line.includes("not fit on one") || line.includes("must wrap across"),
		);
		expect(continuationLines.length).toBeGreaterThan(0);
		for (const line of continuationLines) {
			expect(line).toContain("\x1b[38;2;200;200;200m");
		}
	});

	it("discuss.rounds' bare transcript keeps the body color on every wrapped continuation line", () => {
		const { renderResult } = papyrusVehicleRenderers(descriptor("discuss.rounds"));
		const output = {
			rounds: [{ id: 1, discussionId: "d1", roundNumber: 1, actor: "agent", content: LONG_TEXT, occurredAt: "2026-01-01T00:00:00.000Z" }],
			content: [{ type: "text", text: "transcript" }],
		};
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output } },
			{ isPartial: false, expanded: true },
			realAnsiTheme(),
			resultContext(),
		);
		const lines = component.render(60);
		const continuationLines = lines.filter(
			(line) => line.includes("physical terminal lines") || line.includes("not fit on one") || line.includes("must wrap across"),
		);
		expect(continuationLines.length).toBeGreaterThan(0);
		for (const line of continuationLines) {
			expect(line).toContain("\x1b[38;2;200;200;200m");
		}
	});

	it("tasks.complete's checklist keeps the accept/reject color on every wrapped continuation line", () => {
		const { renderResult } = papyrusVehicleRenderers(descriptor("tasks.complete"));
		const output = {
			artifact: artifact({ title: "Ship the feature", status: "done" }),
			gates: [],
			checklist: [{ item: LONG_TEXT, accepted: true }],
			completed: true,
			focused: null,
			blocked: [],
			content: [{ type: "text", text: "Completed" }],
		};
		const component = renderResult!(
			{ content: [], details: { vehicle: { ...vehicleIdentity, operation: "tasks.complete" }, output } },
			{ isPartial: false, expanded: true },
			realAnsiTheme(),
			resultContext(),
		);
		const lines = component.render(60);
		const continuationLines = lines.filter(
			(line) => line.includes("physical terminal lines") || line.includes("not fit on one") || line.includes("must wrap across"),
		);
		expect(continuationLines.length).toBeGreaterThan(0);
		for (const line of continuationLines) {
			expect(line).toContain("\x1b[38;2;200;200;200m");
		}
	});
});
