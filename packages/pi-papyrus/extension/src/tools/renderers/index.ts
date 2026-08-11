/**
 * Curated result rendering for Papyrus's own Vehicle-projected operations
 * (notes.*, tasks.*, docs.*, rules.*, playbooks.*, artifact.*): reuses the
 * same ArtifactCard/ArtifactListCard components the pre-Vehicle native tool
 * used, instead of the generic Vehicle renderer's raw full-column table
 * dump -- a human reading a task/note list doesn't need id/subtype/extra/
 * timestamps up front, only title + status, with the rest available on
 * expand. Detection is by output shape, not operation name: every operation
 * registered through this client is one of Papyrus's own artifact domains,
 * so "looks like an Artifact" is a safe, name-independent signal here.
 * Falls back to the generic Vehicle renderer for any other output shape
 * (progress, transitions, gate runs, errors).
 *
 * This file is the one place that assembles every result-kind's own detector/renderer into the
 * two exported Registry entry points (papyrusVehicleRenderers/papyrusVehiclePresentations) -- the
 * "wide internal, narrow public" shape: each sibling module in this directory owns one kind's own
 * real complexity, this one only ever needs to know each kind's own type + guard + renderer, never
 * re-derive it. Split out of the former single 670-line vehicle-artifact-renderers.ts as part of a
 * SOLID-audit-driven decomposition (see Doc "Modularity playbook: building-block-shaped
 * TypeScript modules for papyrus/pi-papyrus" and the "pi-papyrus vehicle-artifact-renderers.ts
 * split" child of "Epic: Modularize papyrus/pi-papyrus god-files into building-block modules").
 */

import { TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS } from "@danypops/papyrus";
import type { PiVehicleInvocationRequest, PiVehiclePresentationContract, VehicleToolRenderers } from "@danypops/vehicle-client-pi";
import { renderVehicleCall, renderVehicleResult } from "@danypops/vehicle-client-pi/vehicle-render";
import type { JsonValue, VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { ArtifactCard } from "../../tool-rendering/artifact-card.ts";
import { ArtifactListCard } from "../../tool-rendering/artifact-list.ts";
import {
	createArtifactDetails,
	createArtifactListDetails,
	createDiscussionDetails,
	createExecutionPlanDetails,
	createLeaseDetails,
	createNoFocusDetails,
	createPlaybookInvocationDetails,
	createPlaybookMissingArgumentsDetails,
	createPreviewDetails,
	createTaskCompletionDetails,
	parsePapyrusToolDetails,
} from "../../tool-rendering/render-model.ts";
import { recordRenderDiagnostic, shapeFingerprint } from "../render-diagnostics.ts";
import {
	isDiscussionAndRounds,
	isDiscussionListOutput,
	isDiscussionRoundsOnly,
	renderDiscussionAndRounds,
	renderDiscussionRoundsOnly,
} from "./discussion.ts";
import { isTaskLeaseView, renderLease } from "./lease.ts";
import {
	isPlaybookInvocationResult,
	isPlaybookMissingArguments,
	renderPlaybookInvocationResult,
	renderPlaybookMissingArguments,
} from "./playbook.ts";
import { boundedJsonPreview, focusAnnotation, isArtifact, isArtifactArray, isTaskFocus, renderNoFocusedTask } from "./shared.ts";
import { isTaskCompletion, renderTaskCompletion } from "./task-completion.ts";
import { isTaskExecutionPlan, renderTaskExecutionPlan } from "./task-execution.ts";

export function papyrusVehicleRenderers(descriptor: VehicleOperationDescriptor): VehicleToolRenderers {
	return {
		// Pure pass-through to the generic renderer -- the only reason this exists at all is
		// the /reload investigation (papyrus task 4930cd9b): its absence from the diagnostic
		// log for a real invocation (see onInvoked in vehicle-notes-client.ts) is itself
		// evidence Pi never found ANY renderer -- ours or vehicle-client-pi's generic default
		// -- for that specific tool call, distinct from this renderer running and choosing
		// the generic path internally (which DOES show up here).
		renderCall(args, theme, context) {
			recordRenderDiagnostic({ event: "render-call-invoked", operation: descriptor.name });
			return renderVehicleCall(descriptor, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			if (!options.isPartial && !context.isError) {
				const output = (result.details as { output?: unknown } | undefined)?.output;
				// /reload rendering-fallback investigation (papyrus task 4930cd9b) -- correlates
				// against vehicle-notes-client.ts's onInvoked/vehicle-ready diagnostics by
				// descriptor.name and wall-clock time.
				recordRenderDiagnostic({
					event: "render-result-dispatch",
					operation: descriptor.name,
					isArtifact: isArtifact(output),
					isArtifactArray: isArtifactArray(output),
					output: shapeFingerprint(output),
				});
				if (isArtifactArray(output)) {
					return new ArtifactListCard(createArtifactListDetails(descriptor.name, output), theme, options.expanded);
				}
				if (isArtifact(output)) {
					return new ArtifactCard(createArtifactDetails(descriptor.name, output), theme, options.expanded);
				}
				if (isTaskFocus(output)) {
					return new ArtifactCard(
						createArtifactDetails(descriptor.name, output.artifact, focusAnnotation(output)),
						theme,
						options.expanded,
					);
				}
				// tasks.focused specifically returns null for "nothing focused" --
				// scoped to this one operation so an unrelated null-output operation
				// (e.g. a not-found lookup) is never mislabeled as a focus state.
				if (output === null && descriptor.name === "tasks.focused") {
					return renderNoFocusedTask(theme);
				}
				if (isTaskExecutionPlan(output)) {
					return renderTaskExecutionPlan(output, theme, options.expanded);
				}
				if (isPlaybookInvocationResult(output)) {
					return renderPlaybookInvocationResult(output, theme, options.expanded);
				}
				if (isPlaybookMissingArguments(output)) {
					return renderPlaybookMissingArguments(output, theme);
				}
				if (isDiscussionAndRounds(output)) {
					return renderDiscussionAndRounds(output, theme, options.expanded);
				}
				if (isDiscussionRoundsOnly(output)) {
					return renderDiscussionRoundsOnly(output, theme);
				}
				if (isDiscussionListOutput(output)) {
					return new ArtifactListCard(createArtifactListDetails(descriptor.name, output.discussions), theme, options.expanded);
				}
				if (isTaskCompletion(output)) {
					return renderTaskCompletion(output, theme, options.expanded);
				}
				recordRenderDiagnostic({ event: "render-result-fell-through-to-generic", operation: descriptor.name });
			}
			return renderVehicleResult(descriptor, result, options, theme, context);
		},
	};
}

/**
 * Projects a raw Papyrus operation output into a bounded, versioned PapyrusToolDetails DTO
 * before Pi ever persists it -- the seam papyrusVehicleRenderers' own renderResult never had
 * (it only converts shape at render time, from whatever the legacy {vehicle, output} path
 * already persisted verbatim, lease tokens and all). Every branch here mirrors the same
 * shape-detection papyrusVehicleRenderers's own renderResult uses, so the two stay in lockstep;
 * anything genuinely unmatched still becomes a real, bounded PreviewToolDetails rather than an
 * unprojected raw passthrough -- the one requirement this whole seam exists to satisfy.
 */
function projectPapyrusPresentation(descriptor: VehicleOperationDescriptor, output: unknown): JsonValue {
	if (isArtifactArray(output)) return createArtifactListDetails(descriptor.name, output) as unknown as JsonValue;
	if (isArtifact(output)) return createArtifactDetails(descriptor.name, output) as unknown as JsonValue;
	if (isTaskFocus(output)) return createArtifactDetails(descriptor.name, output.artifact, focusAnnotation(output)) as unknown as JsonValue;
	if (output === null && descriptor.name === "tasks.focused") return createNoFocusDetails(descriptor.name) as unknown as JsonValue;
	if (isTaskExecutionPlan(output))
		return createExecutionPlanDetails(descriptor.name, output.nodes, output.layers, output.cycleIds) as unknown as JsonValue;
	if (isPlaybookInvocationResult(output)) {
		return createPlaybookInvocationDetails(descriptor.name, {
			playbookId: output.playbookId,
			runId: output.runId,
			created: output.created,
			rootTaskIds: output.rootTaskIds,
			entryTaskId: output.entryTaskId,
			execution: output.execution,
		}) as unknown as JsonValue;
	}
	if (isPlaybookMissingArguments(output)) {
		return createPlaybookMissingArgumentsDetails(descriptor.name, output.playbookId, output.missingArguments) as unknown as JsonValue;
	}
	if (isDiscussionAndRounds(output))
		return createDiscussionDetails(descriptor.name, output.rounds, output.discussion) as unknown as JsonValue;
	if (isDiscussionRoundsOnly(output)) return createDiscussionDetails(descriptor.name, output.rounds) as unknown as JsonValue;
	if (isDiscussionListOutput(output)) return createArtifactListDetails(descriptor.name, output.discussions) as unknown as JsonValue;
	if (isTaskCompletion(output)) return createTaskCompletionDetails(descriptor.name, output) as unknown as JsonValue;
	if (isTaskLeaseView(output)) return createLeaseDetails(descriptor.name, output) as unknown as JsonValue;
	return createPreviewDetails(descriptor.name, descriptor.name, boundedJsonPreview(output)) as unknown as JsonValue;
}

function renderFromPapyrusPresentation(
	presentation: NonNullable<ReturnType<typeof parsePapyrusToolDetails>>,
	theme: Theme,
	expanded: boolean,
): Component {
	switch (presentation.kind) {
		case "artifact-list":
			return new ArtifactListCard(presentation, theme, expanded);
		case "artifact":
			return new ArtifactCard(presentation, theme, expanded);
		case "no-focus":
			return renderNoFocusedTask(theme);
		case "execution-plan":
			return renderTaskExecutionPlan(presentation, theme, expanded);
		case "playbook-invocation":
			return renderPlaybookInvocationResult(presentation, theme, expanded);
		case "playbook-missing-arguments":
			return renderPlaybookMissingArguments(presentation, theme);
		case "discussion":
			return presentation.discussion
				? renderDiscussionAndRounds({ discussion: presentation.discussion, rounds: presentation.rounds }, theme, expanded)
				: renderDiscussionRoundsOnly(presentation, theme);
		case "task-completion":
			return renderTaskCompletion(presentation, theme, expanded);
		case "lease":
			return renderLease(presentation, theme);
		case "preview":
			return new Text(theme.fg("toolOutput", presentation.content), 0, 0);
		case "transition":
		case "graph":
		case "gate-run":
		case "invocation":
		case "error":
			// Reachable only if a future caller starts producing these kinds through this seam
			// (today's Papyrus Vehicle outputs never do) -- a bounded JSON preview is still a
			// real, safe rendering rather than a crash.
			return new Text(theme.fg("toolOutput", boundedJsonPreview(presentation)), 0, 0);
	}
}

/**
 * Pairs the projector above with a renderResult that reads the already-projected,
 * already-bounded `details.presentation` DTO instead of raw `details.output` -- the seam
 * pi-papyrus task "project typed bounded render details before Vehicle persists" exists for.
 * Falls back to papyrusVehicleRenderers' own renderResult (which still reads `details.output`)
 * for a partial/progress update, an error result, or a historical session row persisted before
 * this seam existed -- both keep working exactly as before, unchanged.
 */
export function papyrusVehiclePresentations(descriptor: VehicleOperationDescriptor): PiVehiclePresentationContract {
	return {
		projector: {
			maxBytes: TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
			project: (output: unknown, _request: PiVehicleInvocationRequest) => projectPapyrusPresentation(descriptor, output),
		},
		renderResult(result, options, theme, context) {
			if (!options.isPartial && !context.isError) {
				const presentation = parsePapyrusToolDetails((result.details as { presentation?: unknown } | undefined)?.presentation);
				if (presentation) return renderFromPapyrusPresentation(presentation, theme, options.expanded);
			}
			return papyrusVehicleRenderers(descriptor).renderResult!(result, options, theme, context);
		},
	};
}
