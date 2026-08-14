/**
 * Doc domain composition logic (create/list/show/transition/update/link), split out of the
 * former domain-services.ts into its own per-domain file alongside rules/rules-service.ts and
 * playbook/playbook-service.ts. Shared, kind-agnostic helpers live in ../domain-service-shared.ts.
 */

import { type Artifact, requireLocallyOwnedContent } from "../artifact/artifact.ts";
import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { ArtifactScope, ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { ArtifactAction, AuthorityRegistry } from "../authority-registry.ts";
import {
	addArtifactScopeGroup,
	addArtifactScopeProject,
	assertBodyBounds,
	assertLabelsBounds,
	assertTitleBounds,
	type ListFilter,
	listScoped,
	removeArtifactScopeGroup,
	removeArtifactScopeProject,
	replaceArtifactScopeGroups,
	replaceArtifactScopeProjects,
	requireContentUpdateFields,
	requireKind,
	runTransition,
	setArtifactScopeNone,
	type TransitionTable,
	type UpdateContentInput,
} from "../domain-service-shared.ts";
import { NOTE_SUBTYPE } from "../note/note-service.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { normalizeProjectRoot } from "../task-scope/task-scope.ts";

function rejectsNoteTemplate(artifacts: ArtifactStore, templateId: string | undefined, subtype: string | undefined): boolean {
	if (subtype === NOTE_SUBTYPE) return true;
	if (!templateId) return false;
	const template = artifacts.get(templateId);
	const defaults = template?.extra.defaults;
	return (
		typeof defaults === "object" &&
		defaults !== null &&
		!Array.isArray(defaults) &&
		(defaults as Record<string, unknown>).subtype === NOTE_SUBTYPE
	);
}

/** caller never owns NOTE_SUBTYPE, so requireArtifactAllowed always throws — the trailing throw only satisfies TypeScript's control-flow analysis for a `never`-returning function. */
function requireNotesFacade(authority: AuthorityRegistry, caller: string): never {
	authority.requireArtifactAllowed("doc", NOTE_SUBTYPE, "create", caller);
	throw new Error("note creation requires notes.capture");
}

function templateSubtype(artifacts: ArtifactStore, templateId: string | undefined): string | undefined {
	if (!templateId) return undefined;
	const defaults = artifacts.get(templateId)?.extra.defaults;
	if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return undefined;
	const subtype = (defaults as Record<string, unknown>).subtype;
	return typeof subtype === "string" ? subtype : undefined;
}

// No default action: linkDocument's own bug (both target and source checks silently defaulting to
// "status" here) was exactly what let a plain reference edge to a Task trip the tasks.* lifecycle
// guard, which is scoped to actual status changes only. Every call site now names its real action.
function requireMutableDocument(document: Artifact, authority: AuthorityRegistry, action: ArtifactAction): Artifact {
	authority.requireArtifactAllowed(document.kind, document.subtype, action, "docs");
	return document;
}

export interface CreateDocumentInput {
	title: string;
	body?: string;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	templateId?: string;
	/** Optional at creation, unlike Tasks -- omitting it leaves the Doc in the unscoped bucket, matching today's default behavior for every existing caller. */
	projectRoot?: string;
	/** Bounded exact registered project references (id/name/alias/root) -- fail-closed unlike projectRoot's auto-register-by-root legacy form. Takes precedence over projectRoot when both are given. */
	projectReferences?: string[];
}

export type UpdateDocumentInput = UpdateContentInput;

export type DocumentTransition = "activate" | "archive" | "reopen";
export type DocumentRelation = "references" | "documents" | "supersedes" | "relates_to" | "contains" | "part_of";

const DOCUMENT_TRANSITIONS: TransitionTable<DocumentTransition, string> = {
	activate: { from: ["draft"], to: "active" },
	archive: { from: ["draft", "active"], to: "archived" },
	reopen: { from: ["archived"], to: "draft" },
};

export function createDocument(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	input: CreateDocumentInput,
	authority: AuthorityRegistry,
	context?: ArtifactEventContext,
	registry?: ProjectRegistryStore,
): Artifact {
	if (rejectsNoteTemplate(artifacts, input.templateId, input.subtype)) requireNotesFacade(authority, "docs");
	authority.requireArtifactAllowed("doc", input.subtype ?? templateSubtype(artifacts, input.templateId), "create", "docs");
	if (input.projectReferences !== undefined && input.projectReferences.length > 0 && registry === undefined) {
		throw new Error("projectReferences requires a project registry");
	}
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const document = artifacts.create(
		{
			kind: "doc",
			// Explicit, not defaultStatusFor's "first status row by rowid" fallback -- the same
			// heuristic that made Task creation non-deterministic on a migrated database. Every
			// creation path that has no caller-supplied initial status must set one explicitly.
			status: "draft",
			title: input.title,
			body: input.body,
			subtype: input.subtype,
			labels: input.labels,
			extra: input.extra,
			templateId: input.templateId,
		},
		context,
	);
	if (input.projectReferences !== undefined && input.projectReferences.length > 0) {
		replaceArtifactScopeProjects(scopes, registry!, document.id, input.projectReferences);
	} else {
		scopes.assign(document.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	}
	return document;
}

export function listDocuments(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "doc", filter, NOTE_SUBTYPE);
}

export function assignDocumentProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	id: string,
	projectRoot: string | undefined,
): Artifact {
	requireDocument(artifacts, id); // rejects Notes -- project reassignment for notes goes through notes.* like everything else about them
	scopes.assign(
		id,
		projectRoot === undefined ? undefined : normalizeProjectRoot(projectRoot),
		projectRoot === undefined ? "unscoped" : "explicit",
	);
	return artifacts.get(id)!;
}

/**
 * The multi-project scope surface docs.assign_project cannot express (more than one membership,
 * or exact fail-closed reference resolution instead of assign's auto-register-by-root). Mirrors
 * rules.ts's own ruleScope/setRuleGlobal/replaceRuleProjects/addRuleProject/removeRuleProject --
 * id is resolved through requireDocument so these reject the same way against a non-Doc, unknown
 * id, or a Note as every other docs.* mutation; the project REFERENCE (name/alias/root) is
 * resolved through the shared registry's resolveProjectReference, so an unknown or ambiguous
 * project fails closed with bounded candidates rather than silently creating a new registration.
 */
export function docScope(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireDocument(artifacts, id);
	return scopes.scope(id);
}

export function setDocGlobal(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireDocument(artifacts, id);
	return scopes.setAll(id, "explicit");
}

/** Fully hides this Doc -- never applicable, never context-injected, regardless of project. The only new mode beyond the pre-existing global/projects pair. */
export function setDocNone(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireDocument(artifacts, id);
	return setArtifactScopeNone(scopes, id);
}

export function replaceDocProjects(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReferences: readonly string[],
): ArtifactScope {
	requireDocument(artifacts, id);
	return replaceArtifactScopeProjects(scopes, registry, id, projectReferences);
}

export function addDocProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReference: string,
): ArtifactScope {
	requireDocument(artifacts, id);
	return addArtifactScopeProject(scopes, registry, id, projectReference);
}

export function removeDocProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReference: string,
): ArtifactScope {
	requireDocument(artifacts, id);
	return removeArtifactScopeProject(scopes, registry, id, projectReference);
}

/** Scope-group ('nested scope') siblings of replaceDocProjects/addDocProject/removeDocProject -- same Note-rejecting Doc guard, delegating the actual reference-resolution and store call to the shared, kind-agnostic helpers. */
export function replaceDocGroups(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReferences: readonly string[],
): ArtifactScope {
	requireDocument(artifacts, id);
	return replaceArtifactScopeGroups(scopes, scopeGroups, id, groupReferences);
}

export function addDocGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReference: string,
): ArtifactScope {
	requireDocument(artifacts, id);
	return addArtifactScopeGroup(scopes, scopeGroups, id, groupReference);
}

export function removeDocGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReference: string,
): ArtifactScope {
	requireDocument(artifacts, id);
	return removeArtifactScopeGroup(scopes, scopeGroups, id, groupReference);
}

function requireDocument(artifacts: ArtifactStore, id: string): Artifact {
	const document = requireKind(artifacts, id, "doc");
	if (document.subtype === NOTE_SUBTYPE) throw new Error("note access requires a notes.* operation");
	return document;
}

export function showDocument(artifacts: ArtifactStore, id: string): Artifact {
	requireDocument(artifacts, id);
	return artifacts.get(id, { tree: true })!;
}

export function transitionDocument(
	artifacts: ArtifactStore,
	id: string,
	action: DocumentTransition,
	authority: AuthorityRegistry,
	context?: ArtifactEventContext,
): Artifact {
	const document = requireLocallyOwnedContent(requireMutableDocument(requireDocument(artifacts, id), authority, "status"));
	return runTransition(artifacts, document, "doc", action, DOCUMENT_TRANSITIONS, context);
}

/**
 * Docs are immutable-by-convention only in the sense that no path existed to change them --
 * this is that path. A read-only external projection (see requireLocallyOwnedContent) still
 * refuses, on purpose: rewriting it here would silently fork from whatever system actually
 * owns it (e.g. web-spider's ingested pages), with nothing to ever reconcile the two again.
 */
export function updateDocument(
	artifacts: ArtifactStore,
	id: string,
	input: UpdateDocumentInput,
	authority: AuthorityRegistry,
	context?: ArtifactEventContext,
): Artifact {
	requireContentUpdateFields(input);
	assertTitleBounds(input.title);
	assertBodyBounds(input.body);
	assertLabelsBounds(input.labels);
	const _document = requireLocallyOwnedContent(requireMutableDocument(requireDocument(artifacts, id), authority, "update"));
	const updated = artifacts.updateContent(id, input, context);
	if (!updated) throw new Error(`document "${id}" not found`);
	return updated;
}

export function linkDocument(
	artifacts: ArtifactStore,
	id: string,
	relation: DocumentRelation,
	targetId: string,
	authority: AuthorityRegistry,
	context?: ArtifactEventContext,
): Artifact {
	requireLocallyOwnedContent(requireMutableDocument(requireDocument(artifacts, id), authority, "link"));
	const target = artifacts.get(targetId);
	if (!target) throw new Error(`target artifact "${targetId}" not found`);
	requireLocallyOwnedContent(requireMutableDocument(target, authority, "link"));
	artifacts.link({ from: id, relation, to: targetId }, context);
	return showDocument(artifacts, id);
}
