/**
 * Shared, kind-agnostic CRUD composition helpers used by docs/docs-service.ts,
 * rules/rules-service.ts, and playbook/playbook-service.ts. Split out of the former
 * domain-services.ts (which combined all three domains in one 849-line file) so each
 * domain's own service file only imports the cross-domain pieces it actually needs.
 */

import type { Artifact } from "./artifact/artifact.ts";
import type { ArtifactEventContext } from "./artifact/artifact-event.ts";
import type { ArtifactScopeStore } from "./artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "./artifact/artifact-store.ts";
import {
	ARTIFACT_BODY_MAX_LENGTH,
	ARTIFACT_LABEL_MAX_COUNT,
	ARTIFACT_LABEL_MAX_LENGTH,
	ARTIFACT_SCOPE_MAX_ARTIFACTS,
	ARTIFACT_TITLE_MAX_LENGTH,
} from "./constants.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";

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
	/** When supplied, results are limited to artifacts scoped to this project (or the unscoped bucket, for an empty string is not accepted -- use assignArtifactProject's own validation). */
	projectRoot?: string;
}

/**
 * Shared by listDocuments/listRules/listPlaybooks: when filter.projectRoot is given, resolve
 * via ArtifactScopeStore first and post-filter by kind/status/text (mirrors Tasks.list's
 * established scoped-listing shape); otherwise fall back to the existing unscoped query
 * path unchanged, so every caller that predates project scoping keeps working exactly as
 * before.
 */
export function listScoped(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	kind: string,
	filter: ListFilter,
	excludeSubtype?: string,
): Artifact[] {
	if (filter.projectRoot === undefined)
		return artifacts.query({ kind, excludeSubtype, status: filter.status, text: filter.text, limit: filter.limit });
	const limit = filter.limit ?? ARTIFACT_SCOPE_MAX_ARTIFACTS;
	if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_SCOPE_MAX_ARTIFACTS) {
		throw new Error(`list limit must be between 1 and ${ARTIFACT_SCOPE_MAX_ARTIFACTS}`);
	}
	const projectRoot = normalizeProjectRoot(filter.projectRoot);
	const ids = scopes.ids(projectRoot, ARTIFACT_SCOPE_MAX_ARTIFACTS);
	const text = filter.text?.toLowerCase();
	return ids
		.map((id) => artifacts.get(id))
		.filter((artifact): artifact is Artifact => artifact?.kind === kind && artifact.subtype !== excludeSubtype)
		.filter((artifact) => filter.status === undefined || artifact.status === filter.status)
		.filter((artifact) => text === undefined || artifact.title.toLowerCase().includes(text) || artifact.body.toLowerCase().includes(text))
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
 * current status" (e.g. Tasks.transition's dependency-blocking check and focus-store
 * bookkeeping, which must run -- or not -- before the status write itself) can call this
 * directly instead of duplicating the same lookup+throw three times. Every other caller
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
