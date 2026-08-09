/**
 * Runs Vehicle's own host-neutral Tool Shell dual-channel conformance suite against
 * pi-papyrus's real production projector/renderer pair (papyrusVehiclePresentations), proving
 * the actual code -- not a hand-rolled stand-in -- satisfies the published contract: model
 * content and persisted presentation details stay independent under their own named bounds,
 * a malformed/legacy/unknown replay degrades to useful model content instead of throwing, and
 * call rendering never echoes a credential-shaped argument.
 */

import { TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS, TOOL_MODEL_CONTENT_MAX_CHARACTERS } from "@danypops/papyrus";
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import type { JsonValue, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { papyrusVehiclePresentations, papyrusVehicleRenderers } from "../extension/src/tools/vehicle-artifact-renderers.ts";

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

const vehicleIdentity = { name: "papyrus", version: "1", operation: "tasks.show", operationVersion: 1, toolCallId: "call-1" };

/** A real Artifact-shaped raw output -- the same shape tasks.show/docs.show actually return.
 * The title carries the PRESENTATION_ONLY marker so it lands in the persisted details, never
 * the model channel: the projector (createArtifactDetails) never reads or touches `content`. */
function representativeArtifact(): Record<string, unknown> {
	return {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		alias: "presentation-only-marker-task",
		kind: "task",
		title: "PRESENTATION_ONLY marker task",
		status: "todo",
		subtype: "",
		body: "some body text",
		labels: [],
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

const fixture: ToolShellDualChannelFixture = {
	label: "pi-papyrus (papyrusVehiclePresentations, tasks.show)",
	async create() {
		const desc = descriptor("tasks.show");
		const { projector, renderResult } = papyrusVehiclePresentations(desc);
		const subject = {
			bounds: { modelContentBytes: TOOL_MODEL_CONTENT_MAX_CHARACTERS, presentationDetailsBytes: TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS },
			execute: async () => {
				const presentation = await projector.project(representativeArtifact(), {} as never);
				return {
					content: "MODEL_ONLY: fetched the task",
					details: { vehicle: vehicleIdentity, presentation },
				};
			},
			render: (
				snapshot: { content: string; details: unknown },
				options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean },
			) => {
				const details = (snapshot.details as { presentation?: JsonValue }) ?? {};
				const component = renderResult!(
					{
						content: [{ type: "text", text: snapshot.content }],
						details: options.partial
							? { vehicle: vehicleIdentity, progress: { current: 1, total: 2 } }
							: { vehicle: vehicleIdentity, presentation: details.presentation },
					},
					{ isPartial: options.partial === true, expanded: options.expanded },
					fakeTheme,
					{ cwd: "/tmp", isError: false } as never,
				);
				return component.render(options.width);
			},
			replay: (details: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) => {
				const component = renderResult!(
					{
						content: [{ type: "text", text: fallbackContent }],
						details: { vehicle: vehicleIdentity, presentation: details as JsonValue | undefined },
					},
					{ isPartial: false, expanded: false },
					fakeTheme,
					{ cwd: "/tmp", isError: false } as never,
				);
				return component.render(options.width);
			},
			renderCall: (args: unknown, width: 40 | 80 | 120) => {
				const { renderCall } = papyrusVehicleRenderers(desc);
				const component = renderCall!(args, fakeTheme, { cwd: "/tmp" } as never);
				return component.render(width);
			},
			invalidProjection: async () => {
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				return projector.project(cyclic, {} as never);
			},
		};
		return { subject, cleanup: () => Promise.resolve() };
	},
};

runToolShellDualChannelConformance(fixture);
