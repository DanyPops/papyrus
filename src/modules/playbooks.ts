/**
 * modules/playbooks.ts — Playbooks as a Papyrus-native registered module.
 *
 * A Playbook (trigger + ordered steps an agent reads and follows) is a completely different
 * beast from a Skill (a mechanically instantiated artifact-template or workflow blueprint) --
 * its own kind, not a subtype squeezed into "skill". See domain-services.ts's Playbook section
 * for the full rationale.
 */
import { assignPlaybookProject, createPlaybook, listPlaybooks, playbookInvocation, showPlaybook, transitionPlaybook, updatePlaybook } from "../domain-services.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";

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

const artifactFilter = (input: OperationInput) => ({
	status: optionalString(input, "status"),
	text: optionalString(input, "text"),
	limit: optionalNumber(input, "limit"),
	projectRoot: optionalString(input, "project_root"),
});

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const PLAYBOOKS_OPERATION_NAMES = [
	"playbooks.create", "playbooks.list", "playbooks.show", "playbooks.invoke", "playbooks.enable", "playbooks.disable", "playbooks.assign_project", "playbooks.update",
] as const;

export function playbooksOperations(artifacts: ArtifactStore, scopes: ArtifactScopeStore): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("playbooks.create", (input: OperationInput) => createPlaybook(artifacts, scopes, {
			title: string(input, "title"), body: optionalString(input, "body"), trigger: optionalString(input, "trigger"),
			steps: input["steps"] as string[] | undefined, tools: input["tools"] as string[] | undefined,
			arguments: input["arguments"],
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			projectRoot: optionalString(input, "project_root"),
		}, eventContext(input))),
		define("playbooks.list", (input: OperationInput) => listPlaybooks(artifacts, scopes, artifactFilter(input))),
		define("playbooks.show", (input: OperationInput) => showPlaybook(artifacts, string(input, "id"))),
		define("playbooks.invoke", (input: OperationInput) => playbookInvocation(artifacts, string(input, "id"), input["arguments"] as Record<string, string> | undefined)),
		define("playbooks.enable", (input: OperationInput) => transitionPlaybook(artifacts, string(input, "id"), "enable", eventContext(input))),
		define("playbooks.disable", (input: OperationInput) => transitionPlaybook(artifacts, string(input, "id"), "disable", eventContext(input))),
		define("playbooks.assign_project", (input: OperationInput) => assignPlaybookProject(artifacts, scopes, string(input, "id"), optionalString(input, "project_root"))),
		define("playbooks.update", (input: OperationInput) => updatePlaybook(artifacts, string(input, "id"), {
			title: optionalString(input, "title"), body: optionalString(input, "body"), labels: input["labels"] as string[] | undefined,
		}, eventContext(input))),
	];
}
