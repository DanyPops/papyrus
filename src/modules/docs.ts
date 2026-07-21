/**
 * modules/docs.ts — Docs as a Papyrus-native registered module
 * (step 5, continued, of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo).
 *
 * Imports only src/domain-services.ts's Doc functions, which are already generic
 * ArtifactStore-based with no other module's concrete class dependency.
 */
import type { AuthorityRegistry } from "../authority-registry.ts";
import { assignDocumentProject, createDocument, linkDocument, listDocuments, showDocument, transitionDocument, type DocumentRelation } from "../domain-services.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";

const MODULE_ID = "docs";

type OperationInput = Record<string, unknown>;

function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

const eventContext = (input: OperationInput) => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
});

const artifactFilter = (input: OperationInput) => ({
	status: optionalString(input, "status"),
	text: optionalString(input, "text"),
	limit: optionalNumber(input, "limit"),
	projectRoot: optionalString(input, "project_root"),
});

/** Registers every docs.* operation against the shared ArtifactStore port. Behavior is unchanged from the prior inline handlers in src/service.ts. */
/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const DOCS_OPERATION_NAMES = [
	"docs.create", "docs.list", "docs.show", "docs.activate", "docs.archive", "docs.reopen", "docs.link", "docs.assign_project",
] as const;

export function docsOperations(artifacts: ArtifactStore, scopes: ArtifactScopeStore, authority: AuthorityRegistry): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("docs.create", (input: OperationInput) => createDocument(artifacts, scopes, {
			title: string(input, "title"), body: optionalString(input, "body"), subtype: optionalString(input, "subtype"),
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
			projectRoot: optionalString(input, "project_root"),
		}, authority, eventContext(input))),
		define("docs.list", (input: OperationInput) => listDocuments(artifacts, scopes, artifactFilter(input))),
		define("docs.show", (input: OperationInput) => showDocument(artifacts, string(input, "id"))),
		define("docs.activate", (input: OperationInput) => transitionDocument(artifacts, string(input, "id"), "activate", authority, eventContext(input))),
		define("docs.archive", (input: OperationInput) => transitionDocument(artifacts, string(input, "id"), "archive", authority, eventContext(input))),
		define("docs.reopen", (input: OperationInput) => transitionDocument(artifacts, string(input, "id"), "reopen", authority, eventContext(input))),
		define("docs.link", (input: OperationInput) => linkDocument(artifacts, string(input, "id"), string(input, "relation") as DocumentRelation, string(input, "target_id"), authority, eventContext(input))),
		define("docs.assign_project", (input: OperationInput) => assignDocumentProject(artifacts, scopes, string(input, "id"), optionalString(input, "project_root"))),
	];
}
