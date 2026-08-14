/**
 * modules/docs.ts — Docs as a Papyrus-native registered module
 * (step 5, continued, of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo).
 *
 * Imports only src/docs/docs-service.ts's Doc functions, which are already generic
 * ArtifactStore-based with no other module's concrete class dependency.
 */

import { summarizeArtifact } from "../artifact/artifact.ts";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { AuthorityRegistry } from "../authority-registry.ts";
import {
	addDocGroup,
	addDocProject,
	assignDocumentProject,
	createDocument,
	type DocumentRelation,
	docScope,
	linkDocument,
	listDocuments,
	removeDocGroup,
	removeDocProject,
	replaceDocGroups,
	replaceDocProjects,
	setDocGlobal,
	setDocNone,
	showDocument,
	transitionDocument,
	updateDocument,
} from "../docs/docs-service.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { type OperationInput, optionalBoolean, optionalNumber, optionalString, string } from "./operation-input.ts";

const MODULE_ID = "docs";

const eventContext = (input: OperationInput) => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
});

/**
 * applicable=true switches project_root's meaning from exact-membership audit listing to
 * applicable listing (global Docs plus Docs whose bounded membership includes this project) --
 * see ListFilter's own doc comment on projectRoot vs applicableToProjectRoot for why these are
 * two distinct, non-overlapping query modes rather than one.
 */
const artifactFilter = (input: OperationInput) => {
	const projectRoot = optionalString(input, "project_root");
	const applicable = optionalBoolean(input, "applicable") === true;
	if (applicable && projectRoot === undefined) throw new Error("applicable requires project_root");
	return {
		status: optionalString(input, "status"),
		text: optionalString(input, "text"),
		limit: optionalNumber(input, "limit"),
		...(applicable ? { applicableToProjectRoot: projectRoot } : { projectRoot }),
	};
};

/** Registers every docs.* operation against the shared ArtifactStore port. Behavior is unchanged from the prior inline handlers in src/service.ts. */
/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const DOCS_OPERATION_NAMES = [
	"docs.create",
	"docs.list",
	"docs.show",
	"docs.activate",
	"docs.archive",
	"docs.reopen",
	"docs.link",
	"docs.assign_project",
	"docs.scope",
	"docs.set_global",
	"docs.set_none",
	"docs.add_project",
	"docs.remove_project",
	"docs.add_group",
	"docs.remove_group",
	"docs.replace_groups",
	"docs.replace_projects",
	"docs.update",
] as const;

export function docsOperations(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	authority: AuthorityRegistry,
	registry: ProjectRegistryStore,
	scopeGroups: ScopeGroupStore,
): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("docs.create", (input: OperationInput) =>
			createDocument(
				artifacts,
				scopes,
				{
					title: string(input, "title"),
					body: optionalString(input, "body"),
					subtype: optionalString(input, "subtype"),
					labels: input.labels as string[] | undefined,
					extra: input.extra as Record<string, unknown> | undefined,
					templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
					projectRoot: optionalString(input, "project_root"),
					projectReferences: input.projects as string[] | undefined,
				},
				authority,
				eventContext(input),
				registry,
			),
		),
		define("docs.list", (input: OperationInput) => {
			const docs = listDocuments(artifacts, scopes, artifactFilter(input));
			return optionalBoolean(input, "full") === true ? docs : docs.map(summarizeArtifact);
		}),
		define("docs.show", (input: OperationInput) => showDocument(artifacts, string(input, "id"))),
		define("docs.activate", (input: OperationInput) =>
			transitionDocument(artifacts, string(input, "id"), "activate", authority, eventContext(input)),
		),
		define("docs.archive", (input: OperationInput) =>
			transitionDocument(artifacts, string(input, "id"), "archive", authority, eventContext(input)),
		),
		define("docs.reopen", (input: OperationInput) =>
			transitionDocument(artifacts, string(input, "id"), "reopen", authority, eventContext(input)),
		),
		define("docs.link", (input: OperationInput) =>
			linkDocument(
				artifacts,
				string(input, "id"),
				string(input, "relation") as DocumentRelation,
				string(input, "target_id"),
				authority,
				eventContext(input),
			),
		),
		define("docs.assign_project", (input: OperationInput) =>
			assignDocumentProject(artifacts, scopes, string(input, "id"), optionalString(input, "project_root")),
		),
		define("docs.scope", (input: OperationInput) => docScope(artifacts, scopes, string(input, "id"))),
		define("docs.set_global", (input: OperationInput) => setDocGlobal(artifacts, scopes, string(input, "id"))),
		define("docs.set_none", (input: OperationInput) => setDocNone(artifacts, scopes, string(input, "id"))),
		define("docs.add_project", (input: OperationInput) =>
			addDocProject(artifacts, scopes, registry, string(input, "id"), string(input, "project")),
		),
		define("docs.remove_project", (input: OperationInput) =>
			removeDocProject(artifacts, scopes, registry, string(input, "id"), string(input, "project")),
		),
		define("docs.replace_projects", (input: OperationInput) =>
			replaceDocProjects(artifacts, scopes, registry, string(input, "id"), (input.projects as string[] | undefined) ?? []),
		),
		define("docs.add_group", (input: OperationInput) =>
			addDocGroup(artifacts, scopes, scopeGroups, string(input, "id"), string(input, "group")),
		),
		define("docs.remove_group", (input: OperationInput) =>
			removeDocGroup(artifacts, scopes, scopeGroups, string(input, "id"), string(input, "group")),
		),
		define("docs.replace_groups", (input: OperationInput) =>
			replaceDocGroups(artifacts, scopes, scopeGroups, string(input, "id"), (input.groups as string[] | undefined) ?? []),
		),
		define("docs.update", (input: OperationInput) =>
			updateDocument(
				artifacts,
				string(input, "id"),
				{
					title: optionalString(input, "title"),
					body: optionalString(input, "body"),
					labels: input.labels as string[] | undefined,
				},
				authority,
				eventContext(input),
			),
		),
	];
}
