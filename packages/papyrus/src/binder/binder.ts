import type { Artifact } from "../artifact/artifact.ts";

/** A Binder is an organizational artifact. Its edges never participate in Task/Playbook execution. */
export const BINDER_KIND = "binder";
export const BINDER_ORGANIZES_RELATION = "organizes";
export const BINDER_FILED_IN_RELATION = "filed_in";

export interface BinderNode {
	binder: Artifact;
	/** The one visible parent selected for this project-context tree. */
	parentId?: string;
	childIds: string[];
	path: string;
	/** Labels contributed by ancestors, ordered root to immediate parent. */
	inheritedLabels: string[];
	/** Ancestor labels followed by this Binder's own direct labels, de-duplicated. */
	effectiveLabels: string[];
}

export interface BinderArtifactPlacement {
	artifactId: string;
	/** Omitted for an artifact at this project context's root. */
	binderId?: string;
	/** Labels contributed by the containing Binder and all of its ancestors. */
	inheritedLabels: string[];
	/** Inherited labels followed by the artifact's own direct labels, de-duplicated. */
	effectiveLabels: string[];
}

export interface BinderTree {
	nodes: BinderNode[];
	rootIds: string[];
	artifacts: BinderArtifactPlacement[];
}
