/**
 * modules/playbooks.ts — Playbooks as a Papyrus-native registered module.
 *
 * A Playbook is prose-first, whole-artifact composition (contains/depends_on between real
 * Playbook artifacts) rather than a raw JSON blueprint -- but its own step list can also
 * declare Doc/Rule blueprints and typed arguments and nested pipeline calls. playbooks.invoke
 * recycles the shared blueprint materialization engine (playbook/playbook-execution.ts compiles a
 * Playbook's steps and composition tree into a BlueprintDefinition, then hands off to
 * playbook/workflow-execution.ts's shared core). See playbook/playbook-service.ts and
 * playbook/playbook-definition.ts for the full rationale.
 */

import { summarizeArtifact } from "../artifact/artifact.ts";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { OperationDefinition } from "../module-registry.ts";
import { invokePlaybook } from "../playbook/playbook-execution.ts";
import {
	addPlaybookGroup,
	addPlaybookProject,
	assignPlaybookProject,
	containPlaybook,
	createPlaybook,
	dependPlaybook,
	listPlaybooks,
	playbookInvocation,
	playbookScope,
	removePlaybookGroup,
	removePlaybookProject,
	replacePlaybookGroups,
	replacePlaybookProjects,
	setPlaybookGlobal,
	setPlaybookNone,
	showPlaybook,
	transitionPlaybook,
	uncontainPlaybook,
	undependPlaybook,
	updatePlaybook,
} from "../playbook/playbook-service.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import type { TaskEventSink } from "../task/event/task-event-store.ts";
import type { TaskScopeAssigner } from "../task/scope/task-scope-store.ts";
import type { Tasks } from "../task/task-service.ts";
import { type OperationInput, optionalBoolean, optionalNumber, optionalString, string } from "./operation-input.ts";

const MODULE_ID = "playbooks";

const eventContext = (input: OperationInput) => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
});

const eventContextFor = (input: OperationInput, source: string) => {
	const context = eventContext(input);
	return { ...context, source: context.source ?? source };
};

/**
 * applicable=true switches project_root's meaning from exact-membership audit listing to
 * applicable listing (global Playbooks plus Playbooks whose membership includes it) -- see
 * ListFilter's own doc comment on projectRoot vs applicableToProjectRoot. Used by pi-papyrus's
 * before_agent_start to inject only Playbooks applicable to ctx.cwd, not every active Playbook
 * across every project.
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

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const PLAYBOOKS_OPERATION_NAMES = [
	"playbooks.create",
	"playbooks.list",
	"playbooks.show",
	"playbooks.invoke",
	"playbooks.preview",
	"playbooks.enable",
	"playbooks.disable",
	"playbooks.assign_project",
	"playbooks.scope",
	"playbooks.set_global",
	"playbooks.set_none",
	"playbooks.add_project",
	"playbooks.remove_project",
	"playbooks.replace_projects",
	"playbooks.add_group",
	"playbooks.remove_group",
	"playbooks.replace_groups",
	"playbooks.update",
	"playbooks.contain",
	"playbooks.uncontain",
	"playbooks.depend",
	"playbooks.undepend",
] as const;

export interface PlaybooksModuleDeps {
	artifacts: ArtifactStore;
	events: TaskEventSink;
	scopes: TaskScopeAssigner;
	/** Docs/Rules/Skills/Playbooks project scoping (distinct from `scopes`, which is Task-run project scoping for playbooks.invoke's materialized tasks). */
	artifactScopes: ArtifactScopeStore;
	/** Used for exactly one thing: focusing the entry task after a successful invoke -- the one safety-checked Tasks operation this module needs, not bulk graph construction (that goes straight through artifacts/events/scopes in playbook/playbook-execution.ts, mirroring playbook/workflow-execution.ts). */
	tasks: Tasks;
	/** Guards the same session_secret check tasks.focus's own operation enforces (guardFocusMutation in modules/tasks.ts) -- invoke's internal tasks.focus() call goes straight through the Tasks class, bypassing that operation wrapper entirely, so the check must be applied here instead of silently skipped. */
	sessionIdentity: SessionIdentity;
	registry: ProjectRegistryStore;
	scopeGroups: ScopeGroupStore;
}

export function playbooksOperations({
	artifacts,
	events,
	scopes,
	artifactScopes,
	tasks,
	sessionIdentity,
	registry,
	scopeGroups,
}: PlaybooksModuleDeps): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("playbooks.create", (input: OperationInput) =>
			createPlaybook(
				artifacts,
				artifactScopes,
				{
					title: string(input, "title"),
					body: optionalString(input, "body"),
					trigger: optionalString(input, "trigger"),
					steps: input.steps,
					tools: input.tools as string[] | undefined,
					arguments: input.arguments,
					subtype: optionalString(input, "subtype"),
					labels: input.labels as string[] | undefined,
					extra: input.extra as Record<string, unknown> | undefined,
					templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
					projectRoot: optionalString(input, "project_root"),
					projectReferences: input.projects as string[] | undefined,
				},
				eventContext(input),
				registry,
			),
		),
		define("playbooks.list", (input: OperationInput) => {
			const playbooks = listPlaybooks(artifacts, artifactScopes, artifactFilter(input));
			return optionalBoolean(input, "full") === true ? playbooks : playbooks.map(summarizeArtifact);
		}),
		define("playbooks.show", (input: OperationInput) => showPlaybook(artifacts, string(input, "id"))),
		define("playbooks.preview", (input: OperationInput) =>
			playbookInvocation(artifacts, string(input, "id"), input.arguments as Record<string, unknown> | undefined),
		),
		define("playbooks.invoke", (input: OperationInput) => {
			const result = invokePlaybook(
				artifacts,
				string(input, "id"),
				{
					runId: optionalString(input, "run_id") ?? optionalString(input, "runId"),
					arguments: input.arguments as Record<string, unknown> | undefined,
				},
				{
					events,
					scopes,
					artifactScopes,
					projectRoot: optionalString(input, "project_root"),
					context: eventContextFor(input, "playbook-run"),
				},
			);
			if ("missingArguments" in result) return result;
			const focusContext = eventContextFor(input, "playbook-run");
			sessionIdentity.assertAuthorized(focusContext.sessionId, optionalString(input, "session_secret"));
			tasks.focus(result.entryTaskId, focusContext);
			return result;
		}),
		define("playbooks.enable", (input: OperationInput) =>
			transitionPlaybook(artifacts, string(input, "id"), "enable", eventContext(input)),
		),
		define("playbooks.disable", (input: OperationInput) =>
			transitionPlaybook(artifacts, string(input, "id"), "disable", eventContext(input)),
		),
		define("playbooks.assign_project", (input: OperationInput) =>
			assignPlaybookProject(artifacts, artifactScopes, string(input, "id"), optionalString(input, "project_root")),
		),
		define("playbooks.scope", (input: OperationInput) => playbookScope(artifacts, artifactScopes, string(input, "id"))),
		define("playbooks.set_global", (input: OperationInput) => setPlaybookGlobal(artifacts, artifactScopes, string(input, "id"))),
		define("playbooks.set_none", (input: OperationInput) => setPlaybookNone(artifacts, artifactScopes, string(input, "id"))),
		define("playbooks.add_group", (input: OperationInput) =>
			addPlaybookGroup(artifacts, artifactScopes, scopeGroups, string(input, "id"), string(input, "group")),
		),
		define("playbooks.remove_group", (input: OperationInput) =>
			removePlaybookGroup(artifacts, artifactScopes, scopeGroups, string(input, "id"), string(input, "group")),
		),
		define("playbooks.replace_groups", (input: OperationInput) =>
			replacePlaybookGroups(artifacts, artifactScopes, scopeGroups, string(input, "id"), (input.groups as string[] | undefined) ?? []),
		),
		define("playbooks.add_project", (input: OperationInput) =>
			addPlaybookProject(artifacts, artifactScopes, registry, string(input, "id"), string(input, "project")),
		),
		define("playbooks.remove_project", (input: OperationInput) =>
			removePlaybookProject(artifacts, artifactScopes, registry, string(input, "id"), string(input, "project")),
		),
		define("playbooks.replace_projects", (input: OperationInput) =>
			replacePlaybookProjects(artifacts, artifactScopes, registry, string(input, "id"), (input.projects as string[] | undefined) ?? []),
		),
		define("playbooks.update", (input: OperationInput) =>
			updatePlaybook(
				artifacts,
				string(input, "id"),
				{
					title: optionalString(input, "title"),
					body: optionalString(input, "body"),
					labels: input.labels as string[] | undefined,
					trigger: optionalString(input, "trigger"),
					steps: input.steps,
				},
				eventContext(input),
			),
		),
		define("playbooks.contain", (input: OperationInput) =>
			containPlaybook(artifacts, string(input, "parent_id"), string(input, "child_id"), eventContext(input)),
		),
		define("playbooks.uncontain", (input: OperationInput) =>
			uncontainPlaybook(artifacts, string(input, "parent_id"), string(input, "child_id"), eventContext(input)),
		),
		define("playbooks.depend", (input: OperationInput) =>
			dependPlaybook(artifacts, string(input, "id"), string(input, "dependency_id"), eventContext(input)),
		),
		define("playbooks.undepend", (input: OperationInput) =>
			undependPlaybook(artifacts, string(input, "id"), string(input, "dependency_id"), eventContext(input)),
		),
	];
}
