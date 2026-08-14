/**
 * Shared, kind-agnostic CRUD composition helpers used by docs/docs-service.ts,
 * rules/rules-service.ts, and playbook/playbook-service.ts. Split out of the former
 * domain-services.ts (which combined all three domains in one 849-line file) so each
 * domain's own service file only imports the cross-domain pieces it actually needs.
 */

import type { Artifact } from "./artifact/artifact.ts";
import type { ArtifactEventContext } from "./artifact/artifact-event.ts";
import type { ArtifactScope, ArtifactScopeStore } from "./artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "./artifact/artifact-store.ts";
import {
	ARTIFACT_BODY_MAX_LENGTH,
	ARTIFACT_LABEL_MAX_COUNT,
	ARTIFACT_LABEL_MAX_LENGTH,
	ARTIFACT_SCOPE_MAX_ARTIFACTS,
	ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT,
	ARTIFACT_TITLE_MAX_LENGTH,
} from "./constants.ts";
import { resolveProjectReference } from "./domain/project-registry.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";
import type { ProjectRegistryStore } from "./ports/project-registry-store.ts";
import { resolveScopeGroupReference } from "./scope-group/scope-group.ts";
import type { ScopeGroupStore } from "./scope-group/scope-group-store.ts";

export interface UpdateContentInput {
	title?: string;
	body?: string;
	labels?: string[];
}

export function requireContentUpdateFields(input: UpdateContentInput): void {
	if (input.title === undefined && input.body === undefined && input.labels === undefined) {
		throw new Error("update requires title, body, or labels");
	}
}

export function assertTitleBounds(title: string | undefined): void {
	if (title !== undefined && (title.trim().length === 0 || title.length > ARTIFACT_TITLE_MAX_LENGTH)) {
		throw new Error(`title must be between 1 and ${ARTIFACT_TITLE_MAX_LENGTH} characters`);
	}
}

export function assertBodyBounds(body: string | undefined): void {
	if (body !== undefined && body.length > ARTIFACT_BODY_MAX_LENGTH)
		throw new Error(`body cannot exceed ${ARTIFACT_BODY_MAX_LENGTH} characters`);
}

export function assertLabelsBounds(labels: string[] | undefined): void {
	if (labels === undefined) return;
	if (labels.length > ARTIFACT_LABEL_MAX_COUNT) throw new Error(`labels cannot exceed ${ARTIFACT_LABEL_MAX_COUNT} entries`);
	if (labels.some((label) => label.length === 0 || label.length > ARTIFACT_LABEL_MAX_LENGTH)) {
		throw new Error(`each label must be between 1 and ${ARTIFACT_LABEL_MAX_LENGTH} characters`);
	}
}

export interface ListFilter {
	status?: string;
	text?: string;
	limit?: number;
	/** When supplied, results are limited to artifacts with EXACT membership in this project (or the unscoped bucket) -- audit semantics, never includes a global artifact unless it happens to also carry this exact membership (it never does; global and "projects" are mutually exclusive modes). Mutually exclusive with applicableToProjectRoot -- pass at most one. */
	projectRoot?: string;
	/** When supplied instead of projectRoot, results are APPLICABLE to this project: every global artifact, plus every artifact whose bounded membership set includes this registered project root -- "would this show up for someone working in this project", not "is this project its only home". Distinct from projectRoot's exact-membership audit semantics. An empty string is not accepted -- use normalizeProjectRoot's own validation. */
	applicableToProjectRoot?: string;
}

/**
 * Shared by listDocuments/listRules/listPlaybooks: when filter.projectRoot is given, resolve
 * via ArtifactScopeStore first and post-filter by kind/status/text (mirrors Tasks.list's
 * established scoped-listing shape); otherwise fall back to the existing unscoped query
 * path unchanged, so every caller that predates project scoping keeps working exactly as
 * before. filter.applicableToProjectRoot takes a separate, additive branch -- see its own
 * doc comment on ListFilter for why this is not the same query as filter.projectRoot.
 */
export function listScoped(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	kind: string,
	filter: ListFilter,
	excludeSubtype?: string,
): Artifact[] {
	if (filter.applicableToProjectRoot !== undefined) {
		const limit = filter.limit ?? ARTIFACT_SCOPE_MAX_ARTIFACTS;
		if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_SCOPE_MAX_ARTIFACTS) {
			throw new Error(`list limit must be between 1 and ${ARTIFACT_SCOPE_MAX_ARTIFACTS}`);
		}
		const projectRoot = normalizeProjectRoot(filter.applicableToProjectRoot);
		// Bounded (not a genuinely unlimited table scan) by capping the underlying query at
		// ARTIFACT_SCOPE_MAX_ARTIFACTS before the applicability filter -- the same bounded-
		// approximation tradeoff listInjectableRules already makes for "active rules," accepted
		// here since a real kind/status/text-matching artifact count beyond that bound is not a
		// realistic Papyrus deployment shape.
		return artifacts
			.query({ kind, excludeSubtype, status: filter.status, text: filter.text, limit: ARTIFACT_SCOPE_MAX_ARTIFACTS })
			.filter((artifact) => scopes.appliesToProjectRoot(artifact.id, projectRoot))
			.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
			.slice(0, limit);
	}
	if (filter.projectRoot === undefined)
		return artifacts.query({ kind, excludeSubtype, status: filter.status, text: filter.text, limit: filter.limit });
	const limit = filter.limit ?? ARTIFACT_SCOPE_MAX_ARTIFACTS;
	if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_SCOPE_MAX_ARTIFACTS) {
		throw new Error(`list limit must be between 1 and ${ARTIFACT_SCOPE_MAX_ARTIFACTS}`);
	}
	const projectRoot = normalizeProjectRoot(filter.projectRoot);
	const ids = scopes.ids(projectRoot, ARTIFACT_SCOPE_MAX_ARTIFACTS);
	if (ids.length === 0) return [];
	// artifacts.query (not a manual ids.map(artifacts.get)) so a trashed member is excluded the
	// same way every other listing path already excludes trash by default -- a real, confirmed
	// bug live-verifying this feature: artifacts.get() has no trash awareness at all, so a
	// project-scoped listing kept surfacing an artifact for weeks after artifact.remove trashed
	// it, while the unscoped and applicable branches (both already query-backed) never did.
	return artifacts
		.query({ ids, kind, excludeSubtype, status: filter.status, text: filter.text })
		.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
		.slice(0, limit);
}

export function requireKind(artifacts: ArtifactStore, id: string, kind: string): Artifact {
	const artifact = artifacts.get(id);
	if (!artifact) throw new Error(`${kind} artifact "${id}" not found`);
	if (artifact.kind !== kind) throw new Error(`artifact "${id}" is not a ${kind}`);
	return artifact;
}

/**
 * Shared shape for a kind's own declarative status-transition table -- Document and Task
 * already independently converged on this exact shape; Rule/Playbook used an inline ternary
 * instead only because they happened to have just two states. See validateTransitionFrom's
 * own comment for why this is split from runTransition rather than always combined.
 */
export type TransitionTable<Action extends string, Status extends string> = Record<Action, { from: Status[]; to: Status }>;

/**
 * The from/to-table lookup+validation half of a transition, split out from runTransition
 * (below) so a caller with its own side effects gated on "is this action even valid from the
 * current status" can call this directly instead of duplicating the same lookup+throw.
 * Task lifecycle now uses its richer retry-safe transition primitive instead. Every other caller
 * (Document/Rule/Playbook, none of which have that ordering constraint) uses runTransition
 * instead, which does this same check plus the write in one call.
 */
export function validateTransitionFrom<Action extends string, Status extends string>(
	kind: string,
	action: Action,
	status: string,
	table: TransitionTable<Action, Status>,
): { from: Status[]; to: Status } {
	const transition = table[action];
	if (!transition.from.includes(status as Status)) throw new Error(`cannot ${action} ${kind} from ${status}`);
	return transition;
}

/**
 * Shared by transitionDocument/transitionRule/transitionPlaybook: validates the requested
 * action is legal from the artifact's current status per its own kind's transition table, then
 * writes the resulting status. Any authority/ownership guard (e.g. requireMutableDocument,
 * requireLocallyOwnedContent) is the caller's own responsibility, resolved on `artifact`
 * *before* calling this -- kept out of this primitive so it stays usable by a kind with no
 * such guard (Rule, Playbook) without a no-op parameter every call site has to pass.
 */
export function runTransition<Action extends string, Status extends string>(
	artifacts: ArtifactStore,
	artifact: Artifact,
	kind: string,
	action: Action,
	table: TransitionTable<Action, Status>,
	context?: ArtifactEventContext,
): Artifact {
	const transition = validateTransitionFrom(kind, action, artifact.status, table);
	return artifacts.setStatus(artifact.id, transition.to, context)!;
}

/** Shared by assignRuleProject/assignPlaybookProject. assignDocumentProject has its own body -- it must reject Notes via requireDocument, not the generic requireKind this helper uses. */
export function assignArtifactProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	id: string,
	kind: string,
	projectRoot: string | undefined,
): Artifact {
	requireKind(artifacts, id, kind);
	scopes.assign(
		id,
		projectRoot === undefined ? undefined : normalizeProjectRoot(projectRoot),
		projectRoot === undefined ? "unscoped" : "explicit",
	);
	return artifacts.get(id)!;
}

/**
 * Kind-agnostic scope-mutation primitives shared by docs/rules/playbook-service.ts's own thin,
 * per-kind wrappers (each of which validates the artifact's own kind/subtype first -- e.g.
 * requireDocument's Note exclusion -- then delegates here for the actual reference-resolution +
 * bounds-check + store-call, which is genuinely identical across every kind). Mirrors
 * assignArtifactProject's own already-established split, extended to the tri-state
 * none/all/explicit model and to scope groups ('nested scopes').
 */
export function setArtifactScopeNone(scopes: ArtifactScopeStore, artifactId: string): ArtifactScope {
	return scopes.setNone(artifactId, "explicit");
}

export function replaceArtifactScopeProjects(
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	artifactId: string,
	projectReferences: readonly string[],
): ArtifactScope {
	if (projectReferences.length === 0) throw new Error("projectReferences must be non-empty; use set_none/set_global to clear scoping");
	if (projectReferences.length > ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT) {
		throw new Error(`projectReferences may include at most ${ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT} entries`);
	}
	const members = projectReferences.map((reference) => ({ type: "project" as const, id: resolveProjectReference(registry, reference).id }));
	return scopes.replaceMembers(artifactId, members, "explicit");
}

export function addArtifactScopeProject(
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	artifactId: string,
	projectReference: string,
): ArtifactScope {
	const project = resolveProjectReference(registry, projectReference);
	return scopes.addMember(artifactId, { type: "project", id: project.id }, "explicit");
}

export function removeArtifactScopeProject(
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	artifactId: string,
	projectReference: string,
): ArtifactScope {
	const project = resolveProjectReference(registry, projectReference);
	return scopes.removeMember(artifactId, { type: "project", id: project.id });
}

export function replaceArtifactScopeGroups(
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	artifactId: string,
	groupReferences: readonly string[],
): ArtifactScope {
	if (groupReferences.length === 0) throw new Error("groupReferences must be non-empty; use set_none/set_global to clear scoping");
	if (groupReferences.length > ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT) {
		throw new Error(`groupReferences may include at most ${ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT} entries`);
	}
	const members = groupReferences.map((reference) => ({
		type: "group" as const,
		id: resolveScopeGroupReference(scopeGroups, reference).id,
	}));
	return scopes.replaceMembers(artifactId, members, "explicit");
}

export function addArtifactScopeGroup(
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	artifactId: string,
	groupReference: string,
): ArtifactScope {
	const group = resolveScopeGroupReference(scopeGroups, groupReference);
	return scopes.addMember(artifactId, { type: "group", id: group.id }, "explicit");
}

export function removeArtifactScopeGroup(
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	artifactId: string,
	groupReference: string,
): ArtifactScope {
	const group = resolveScopeGroupReference(scopeGroups, groupReference);
	return scopes.removeMember(artifactId, { type: "group", id: group.id });
}
