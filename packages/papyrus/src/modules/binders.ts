import { summarizeArtifact } from "../artifact/artifact.ts";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { ArtifactTrashStore } from "../artifact/artifact-trash-store.ts";
import {
	addBinderGroup,
	addBinderProject,
	binderScope,
	binderTree,
	createBinder,
	fileArtifact,
	listBinders,
	moveBinder,
	removeBinder,
	removeBinderGroup,
	removeBinderProject,
	replaceBinderGroups,
	replaceBinderProjects,
	setBinderGlobal,
	setBinderNone,
	unfileArtifact,
	updateBinder,
} from "../binder/binder-service.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { type OperationInput, optionalBoolean, optionalNumber, optionalString, string } from "./operation-input.ts";

const MODULE_ID = "binders";

const eventContext = (input: OperationInput) => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
});

const listFilter = (input: OperationInput) => {
	const projectRoot = optionalString(input, "project_root");
	const applicable = optionalBoolean(input, "applicable") === true;
	if (applicable && projectRoot === undefined) throw new Error("applicable requires project_root");
	return {
		text: optionalString(input, "text"),
		limit: optionalNumber(input, "limit"),
		...(applicable ? { applicableToProjectRoot: projectRoot } : { projectRoot }),
	};
};

export const BINDERS_OPERATION_NAMES = [
	"binders.create",
	"binders.list",
	"binders.tree",
	"binders.show",
	"binders.update",
	"binders.move",
	"binders.file",
	"binders.unfile",
	"binders.remove",
	"binders.scope",
	"binders.set_global",
	"binders.set_none",
	"binders.add_project",
	"binders.remove_project",
	"binders.replace_projects",
	"binders.add_group",
	"binders.remove_group",
	"binders.replace_groups",
] as const;

export function bindersOperations(
	artifacts: ArtifactStore & ArtifactTrashStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	scopeGroups: ScopeGroupStore,
): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("binders.create", (input: OperationInput) =>
			createBinder(
				artifacts,
				scopes,
				{
					title: string(input, "title"),
					labels: input.labels as string[] | undefined,
					parentId: optionalString(input, "parent_id"),
					projectRoot: optionalString(input, "project_root"),
					projectReferences: input.projects as string[] | undefined,
				},
				eventContext(input),
				registry,
			),
		),
		define("binders.list", (input: OperationInput) => {
			const binders = listBinders(artifacts, scopes, listFilter(input));
			return optionalBoolean(input, "full") === true ? binders : binders.map(summarizeArtifact);
		}),
		define("binders.tree", (input: OperationInput) =>
			binderTree(artifacts, scopes, {
				projectRoot: optionalString(input, "project_root"),
				artifactIds: input.artifact_ids as string[] | undefined,
			}),
		),
		define("binders.show", (input: OperationInput) => {
			const id = string(input, "id");
			const tree = binderTree(artifacts, scopes, { projectRoot: optionalString(input, "project_root") });
			const node = tree.nodes.find((candidate) => candidate.binder.id === id);
			if (!node) throw new Error(`binder artifact "${id}" not found in this project context`);
			return node;
		}),
		define("binders.update", (input: OperationInput) =>
			updateBinder(
				artifacts,
				scopes,
				string(input, "id"),
				{ title: optionalString(input, "title"), labels: input.labels as string[] | undefined },
				optionalString(input, "project_root"),
				eventContext(input),
			),
		),
		define("binders.move", (input: OperationInput) =>
			moveBinder(
				artifacts,
				scopes,
				string(input, "id"),
				optionalString(input, "parent_id"),
				optionalString(input, "project_root"),
				eventContext(input),
			),
		),
		define("binders.file", (input: OperationInput) =>
			fileArtifact(
				artifacts,
				scopes,
				string(input, "artifact_id"),
				string(input, "binder_id"),
				optionalString(input, "project_root"),
				eventContext(input),
			),
		),
		define("binders.unfile", (input: OperationInput) =>
			unfileArtifact(artifacts, scopes, string(input, "artifact_id"), optionalString(input, "project_root"), eventContext(input)),
		),
		define("binders.remove", (input: OperationInput) =>
			removeBinder(artifacts, string(input, "id"), eventContext(input), optionalString(input, "reason")),
		),
		define("binders.scope", (input: OperationInput) => binderScope(artifacts, scopes, string(input, "id"))),
		define("binders.set_global", (input: OperationInput) => setBinderGlobal(artifacts, scopes, string(input, "id"))),
		define("binders.set_none", (input: OperationInput) => setBinderNone(artifacts, scopes, string(input, "id"))),
		define("binders.add_project", (input: OperationInput) =>
			addBinderProject(artifacts, scopes, registry, string(input, "id"), string(input, "project")),
		),
		define("binders.remove_project", (input: OperationInput) =>
			removeBinderProject(artifacts, scopes, registry, string(input, "id"), string(input, "project")),
		),
		define("binders.replace_projects", (input: OperationInput) =>
			replaceBinderProjects(artifacts, scopes, registry, string(input, "id"), (input.projects as string[] | undefined) ?? []),
		),
		define("binders.add_group", (input: OperationInput) =>
			addBinderGroup(artifacts, scopes, scopeGroups, string(input, "id"), string(input, "group")),
		),
		define("binders.remove_group", (input: OperationInput) =>
			removeBinderGroup(artifacts, scopes, scopeGroups, string(input, "id"), string(input, "group")),
		),
		define("binders.replace_groups", (input: OperationInput) =>
			replaceBinderGroups(artifacts, scopes, scopeGroups, string(input, "id"), (input.groups as string[] | undefined) ?? []),
		),
	];
}
