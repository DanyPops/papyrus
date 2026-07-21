/**
 * modules/skills.ts — Skills as a Papyrus-native registered module
 * (step 5, continued, of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo).
 *
 * skills.instantiate is intentionally NOT registered here even though its operation name
 * starts with "skills.": when the target template's targetKind is "task" it calls
 * tasks.create() directly instead of the generic instantiateTemplate path — a genuine
 * cross-module concern, same category as rules.injectable (see modules/rules.ts). It
 * stays a composition-root operation in src/service.ts.
 *
 * skills.run depends on the Task-domain ports (TaskEventStore, TaskScopeStore) as
 * constructor parameters. These are shared port contracts every module may depend on,
 * the same way every module already depends on ArtifactStore — not "another module's
 * infrastructure" in the sense of a concrete class. skill-execution.ts already has this
 * port dependency pre-existing; untangling it is a separate, larger concern than this
 * extraction.
 */
import type { AuthorityRegistry } from "../authority-registry.ts";
import { assignSkillProject, createArtifactTemplate, createSkill, listSkills, showSkill, skillInvocation, transitionSkill } from "../domain-services.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { TaskEventStore } from "../ports/task-event-store.ts";
import type { TaskScopeStore } from "../ports/task-scope-store.ts";
import { instantiateSkillWorkflow } from "../skill-execution.ts";

const MODULE_ID = "skills";

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

export interface SkillsModuleDeps {
	artifacts: ArtifactStore;
	events: TaskEventStore;
	scopes: TaskScopeStore;
	/** Docs/Rules/Skills project scoping (distinct from `scopes`, which is Task-run project scoping for skills.run's materialized blueprint tasks). */
	artifactScopes: ArtifactScopeStore;
	authority: AuthorityRegistry;
}

/** Registers every skills.* operation except skills.instantiate (see module comment). Behavior is unchanged from the prior inline handlers in src/service.ts. */
export function skillsOperations({ artifacts, events, scopes, artifactScopes, authority }: SkillsModuleDeps): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("skills.create", (input: OperationInput) => createSkill(artifacts, artifactScopes, {
			title: string(input, "title"), body: optionalString(input, "body"), trigger: optionalString(input, "trigger"),
			steps: input["steps"] as string[] | undefined, tools: input["tools"] as string[] | undefined,
			definition: input["definition"],
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			projectRoot: optionalString(input, "project_root"),
		}, authority, eventContext(input))),
		define("skills.create_template", (input: OperationInput) => createArtifactTemplate(artifacts, artifactScopes, {
			title: string(input, "title"), targetKind: string(input, "target_kind"), defaults: input["defaults"] as Record<string, unknown> | undefined,
			required: input["required"] as string[] | undefined, body: optionalString(input, "body"), labels: input["labels"] as string[] | undefined,
			projectRoot: optionalString(input, "project_root"),
		}, authority, eventContext(input))),
		define("skills.list", (input: OperationInput) => listSkills(artifacts, artifactScopes, artifactFilter(input))),
		define("skills.show", (input: OperationInput) => showSkill(artifacts, string(input, "id"))),
		define("skills.invoke", (input: OperationInput) => skillInvocation(artifacts, string(input, "id"))),
		define("skills.run", (input: OperationInput) => instantiateSkillWorkflow(artifacts, string(input, "id"), {
			runId: optionalString(input, "run_id") ?? optionalString(input, "runId"),
			arguments: input["arguments"] as Record<string, unknown> | undefined,
		}, { events, scopes, projectRoot: string(input, "project_root"), context: eventContextFor(input, "skill-run") })),
		define("skills.enable", (input: OperationInput) => transitionSkill(artifacts, string(input, "id"), "enable", eventContext(input))),
		define("skills.disable", (input: OperationInput) => transitionSkill(artifacts, string(input, "id"), "disable", eventContext(input))),
		define("skills.assign_project", (input: OperationInput) => assignSkillProject(artifacts, artifactScopes, string(input, "id"), optionalString(input, "project_root"))),
	];
}
