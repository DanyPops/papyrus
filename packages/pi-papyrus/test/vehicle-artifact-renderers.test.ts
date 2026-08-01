import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { papyrusVehicleRenderers } from "../extension/src/vehicle-artifact-renderers.ts";

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
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: { ok: true } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("ok");
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
});
