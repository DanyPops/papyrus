/**
 * modules/playbooks.ts — Playbooks as a Papyrus-native registered module.
 *
 * A Playbook is prose-first, whole-artifact composition (contains/depends_on between real
 * Playbook artifacts) rather than a raw JSON blueprint -- but its own step list can also
 * declare Doc/Rule blueprints and typed arguments and nested pipeline calls. playbooks.invoke
 * recycles the shared blueprint materialization engine (playbook-execution.ts compiles a
 * Playbook's steps and composition tree into a BlueprintDefinition, then hands off to
 * workflow-execution.ts's shared core). See domain-services.ts's Playbook section and
 * playbook-definition.ts for the full rationale.
 */
import {
	assignPlaybookProject,
	containPlaybook,
	createPlaybook,
	dependPlaybook,
	listPlaybooks,
	playbookInvocation,
	showPlaybook,
	transitionPlaybook,
	uncontainPlaybook,
	undependPlaybook,
	updatePlaybook,
} from "../domain-services.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { TaskEventStore } from "../ports/task-event-store.ts";
import type { TaskScopeStore } from "../ports/task-scope-store.ts";
import { invokePlaybook } from "../playbook-execution.ts";
import type { SessionIdentity } from "../session-identity-service.ts";
import type { Tasks } from "../task-service.ts";

const MODULE_ID = "playbooks";

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

const eventContextFor = (input: OperationInput, source: string) => {
	const context = eventContext(input);
	return { ...context, source: context.source ?? source };
};

const artifactFilter = (input: OperationInput) => ({
	status: optionalString(input, "status"),
	text: optionalString(input, "text"),
	limit: optionalNumber(input, "limit"),
	projectRoot: optionalString(input, "project_root"),
});

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const PLAYBOOKS_OPERATION_NAMES = [
	"playbooks.create", "playbooks.list", "playbooks.show", "playbooks.invoke", "playbooks.preview", "playbooks.enable", "playbooks.disable", "playbooks.assign_project", "playbooks.update",
	"playbooks.contain", "playbooks.uncontain", "playbooks.depend", "playbooks.undepend",
] as const;

export interface PlaybooksModuleDeps {
	artifacts: ArtifactStore;
	events: TaskEventStore;
	scopes: TaskScopeStore;
	/** Docs/Rules/Skills/Playbooks project scoping (distinct from `scopes`, which is Task-run project scoping for playbooks.invoke's materialized tasks). */
	artifactScopes: ArtifactScopeStore;
	/** Used for exactly one thing: focusing the entry task after a successful invoke -- the one safety-checked Tasks operation this module needs, not bulk graph construction (that goes straight through artifacts/events/scopes in playbook-execution.ts, mirroring workflow-execution.ts). */
	tasks: Tasks;
	/** Guards the same session_secret check tasks.focus's own operation enforces (guardFocusMutation in modules/tasks.ts) -- invoke's internal tasks.focus() call goes straight through the Tasks class, bypassing that operation wrapper entirely, so the check must be applied here instead of silently skipped. */
	sessionIdentity: SessionIdentity;
}

export function playbooksOperations({ artifacts, events, scopes, artifactScopes, tasks, sessionIdentity }: PlaybooksModuleDeps): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("playbooks.create", (input: OperationInput) => createPlaybook(artifacts, artifactScopes, {
			title: string(input, "title"), body: optionalString(input, "body"), trigger: optionalString(input, "trigger"),
			steps: input["steps"], tools: input["tools"] as string[] | undefined,
			arguments: input["arguments"],
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			projectRoot: optionalString(input, "project_root"),
		}, eventContext(input))),
		define("playbooks.list", (input: OperationInput) => listPlaybooks(artifacts, artifactScopes, artifactFilter(input))),
		define("playbooks.show", (input: OperationInput) => showPlaybook(artifacts, string(input, "id"))),
		define("playbooks.preview", (input: OperationInput) => playbookInvocation(artifacts, string(input, "id"), input["arguments"] as Record<string, unknown> | undefined)),
		define("playbooks.invoke", (input: OperationInput) => {
			const result = invokePlaybook(artifacts, string(input, "id"), {
				runId: optionalString(input, "run_id") ?? optionalString(input, "runId"),
				arguments: input["arguments"] as Record<string, unknown> | undefined,
			}, { events, scopes, projectRoot: optionalString(input, "project_root"), context: eventContextFor(input, "playbook-run") });
			if ("missingArguments" in result) return result;
			const focusContext = eventContextFor(input, "playbook-run");
			sessionIdentity.assertAuthorized(focusContext.sessionId, optionalString(input, "session_secret"));
			tasks.focus(result.entryTaskId, focusContext);
			return result;
		}),
		define("playbooks.enable", (input: OperationInput) => transitionPlaybook(artifacts, string(input, "id"), "enable", eventContext(input))),
		define("playbooks.disable", (input: OperationInput) => transitionPlaybook(artifacts, string(input, "id"), "disable", eventContext(input))),
		define("playbooks.assign_project", (input: OperationInput) => assignPlaybookProject(artifacts, artifactScopes, string(input, "id"), optionalString(input, "project_root"))),
		define("playbooks.update", (input: OperationInput) => updatePlaybook(artifacts, string(input, "id"), {
			title: optionalString(input, "title"), body: optionalString(input, "body"), labels: input["labels"] as string[] | undefined,
		}, eventContext(input))),
		define("playbooks.contain", (input: OperationInput) => containPlaybook(artifacts, string(input, "parent_id"), string(input, "child_id"), eventContext(input))),
		define("playbooks.uncontain", (input: OperationInput) => uncontainPlaybook(artifacts, string(input, "parent_id"), string(input, "child_id"), eventContext(input))),
		define("playbooks.depend", (input: OperationInput) => dependPlaybook(artifacts, string(input, "id"), string(input, "dependency_id"), eventContext(input))),
		define("playbooks.undepend", (input: OperationInput) => undependPlaybook(artifacts, string(input, "id"), string(input, "dependency_id"), eventContext(input))),
	];
}


