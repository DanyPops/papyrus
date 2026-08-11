/**
 * Base shape-detection kernel shared by every renderers/*.ts result-kind module: the generic
 * "looks like an Artifact" duck-typing every other detector in this directory builds on, plus the
 * Task Focus wrapper shape and small rendering primitives with no kind-specific machinery of their
 * own. Split out of the former single vehicle-artifact-renderers.ts as part of a SOLID-audit-driven
 * decomposition (see Doc "Modularity playbook: building-block-shaped TypeScript modules for
 * papyrus/pi-papyrus" and the "pi-papyrus vehicle-artifact-renderers.ts split" child of "Epic:
 * Modularize papyrus/pi-papyrus god-files into building-block modules").
 */
import type { Artifact } from "@danypops/papyrus";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { ArtifactFocusAnnotation } from "../../tool-rendering/render-model.ts";

/** Every field an Artifact and its lean list-default ArtifactSummary (tasks.list/docs.list/
 * rules.list/playbooks.list without full:true -- see summarizeArtifact()) both always carry. */
export function hasArtifactCoreFields(value: unknown): value is Omit<Artifact, "body" | "extra"> {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.kind === "string" &&
		typeof row.title === "string" &&
		typeof row.status === "string" &&
		typeof row.subtype === "string" &&
		Array.isArray(row.labels) &&
		typeof row.created_at === "string" &&
		typeof row.updated_at === "string"
	);
}

export function isArtifact(value: unknown): value is Artifact {
	return hasArtifactCoreFields(value) && typeof (value as Record<string, unknown>).body === "string";
}

/**
 * Regression (real, live-observed): tasks.list's own documented default ("Returns a lean
 * summary (no body/extra) unless full: true is passed") returns ArtifactSummary rows, which
 * omit body entirely. createArtifactListDetails/artifactSummary (render-model.ts) never read
 * .body for list rendering -- only single-artifact createArtifactDetails does -- so requiring
 * body here (matching isArtifact) silently fell every default (lean, the common case) list
 * call for tasks.list/docs.list/rules.list/playbooks.list through to the generic raw Vehicle
 * table renderer instead of the curated ArtifactListCard.
 */
export function isArtifactArray(value: unknown): value is Artifact[] {
	return Array.isArray(value) && value.every(hasArtifactCoreFields);
}

/** tasks.focused/tasks.pause/tasks.unpause's own wrapper shape -- an Artifact
 * plus Task Focus's separate active/paused dimension. Detected the same
 * name-independent, shape-based way as isArtifact/isArtifactArray above. */
export interface TaskFocusOutput {
	artifact: Artifact;
	status: string;
	updatedAt: string;
	pauseReason?: string;
}

export function isTaskFocus(value: unknown): value is TaskFocusOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		isArtifact(row.artifact) &&
		typeof row.status === "string" &&
		typeof row.updatedAt === "string" &&
		(row.pauseReason === undefined || typeof row.pauseReason === "string")
	);
}

export function focusAnnotation(output: TaskFocusOutput): ArtifactFocusAnnotation {
	return { status: output.status, updatedAt: output.updatedAt, ...(output.pauseReason ? { pauseReason: output.pauseReason } : {}) };
}

export function renderNoFocusedTask(theme: Theme): Component {
	return new Text(theme.fg("dim", "No focused task."), 0, 0);
}

/** What renderDiscussionAndRounds/renderTaskCompletion actually read -- satisfied by both a raw
 * Artifact (the live duck-typed output path) and the leaner projected ToolArtifactSummary (the
 * typed-DTO path), with no cast needed at either call site. */
export interface RenderableDiscussionParent {
	title: string;
	status: string;
}

/** Deliberately does not catch: a value JSON.stringify can't serialize (e.g. a circular
 * reference) has no safe textual fallback, so this propagates and the projector's own caller
 * (invokeVehicleOperation) fails the whole call closed rather than persisting a placeholder --
 * the same "never silently substitute raw/unsafe output" contract every other projection
 * failure already carries. */
export function boundedJsonPreview(value: unknown): string {
	const text = JSON.stringify(value, null, 2);
	return typeof text === "string" ? text : String(value);
}
