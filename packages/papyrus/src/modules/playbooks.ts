/**
 * modules/playbooks.ts — Playbooks as a Papyrus-native registered module.
 *
 * A Playbook is prose-first, whole-artifact composition (contains/depends_on between real
 * Playbook artifacts) rather than a raw JSON blueprint -- but its own step list can now also
 * declare Doc/Rule blueprints and typed arguments and nested pipeline calls, the same
 * Blueprint richness a workflow Skill's JSON definition always had. playbooks.invoke recycles
 * the exact same materialization engine workflow Skills use (playbook-execution.ts compiles a
 * Playbook's steps and composition tree into a SkillDefinition, then hands off to
 * workflow-execution.ts's shared core). See domain-services.ts's Playbook section and
 * playbook-definition.ts for the full rationale.
 *
 * Also home to skills.* (below): Skill-the-kind is retired (domain-services.ts's own
 * createSkill/createArtifactTemplate/instantiateTemplate/listSkills/assignSkillProject/
 * showSkill/updateSkill/skillInvocation/transitionSkill are gone), but the skills.* operation
 * NAMES stay registered and functional for skills-vehicle.ts/the CLI/the TUI, none of which
 * are retired yet -- they now delegate straight to the same Playbook domain-services functions
 * playbooks.* itself uses. A workflow Skill's raw `definition` field and the artifact-template
 * compatibility mechanism (confirmed zero real production usage, either one, ever) are not
 * carried forward: both throw a clear, actionable error instead. skills.instantiate is
 * intentionally NOT registered here even for its still-live callers -- same composition-root
 * reason as ever, see instantiateSkillOrTemplate's own doc comment below.
 */
import type { AuthorityRegistry } from "../authority-registry.ts";
import type { Artifact } from "../domain/artifact.ts";
import type { ArtifactEventContext } from "../domain/artifact-event.ts";
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

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. skills.instantiate is deliberately absent -- see instantiateSkillOrTemplate's own doc comment below. */
export const SKILLS_OPERATION_NAMES = [
	"skills.create", "skills.create_template", "skills.list", "skills.show", "skills.invoke", "skills.run", "skills.enable", "skills.disable", "skills.assign_project", "skills.update",
] as const;

export interface SkillsModuleDeps {
	artifacts: ArtifactStore;
	/**
	 * events/scopes/authority are no longer read by any skills.* operation below -- Skill's own
	 * creation/lifecycle functions were retired in favor of Playbook's equivalents, none of which
	 * need them. Kept in the deps shape only so service.ts's and skills-vehicle.ts's existing
	 * construction call sites don't need touching before their own retirement tasks land.
	 */
	events: TaskEventStore;
	scopes: TaskScopeStore;
	artifactScopes: ArtifactScopeStore;
	authority: AuthorityRegistry;
}

/**
 * skills.instantiate's own branching logic (compatibility-template creation vs. a
 * task-target template's tasks.create() call) -- shared between service.ts's raw RPC
 * forwarder and skills-vehicle.ts's Vehicle operation, the two real callers, instead
 * of reimplemented in each. Retired: the artifact-template compatibility mechanism
 * (createArtifactTemplate/instantiateTemplate) had zero real production rows, ever, in any
 * environment checked. Kept registered (rather than deleted outright) purely so those two
 * still-live callers don't break at wiring time before their own retirement tasks remove
 * this operation from the surface entirely.
 */
export interface InstantiateSkillDeps {
	artifacts: ArtifactStore;
	tasks: Tasks;
	authority: AuthorityRegistry;
}

export function instantiateSkillOrTemplate(_deps: InstantiateSkillDeps, _input: OperationInput, _context?: ArtifactEventContext): Artifact {
	throw new Error("artifact templates are retired (zero real production usage, confirmed live) -- create the target artifact directly (e.g. docs.create, tasks.create, playbooks.create) instead of skills.instantiate");
}

/** Registers every skills.* operation except skills.instantiate (see module comment). skills.create/create_template/run reject the workflow-Skill-definition and artifact-template paths outright -- see the module doc comment above. */
export function skillsOperations({ artifacts, artifactScopes }: SkillsModuleDeps): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("skills.create", (input: OperationInput) => {
			if (input["definition"] !== undefined) {
				throw new Error("workflow Skill definitions are retired (zero real production usage, confirmed live) -- author a Playbook with structured (doc/rule/call) steps and typed arguments instead: see playbooks.create");
			}
			return createPlaybook(artifacts, artifactScopes, {
				title: string(input, "title"), body: optionalString(input, "body"), trigger: optionalString(input, "trigger"),
				steps: input["steps"], tools: input["tools"] as string[] | undefined,
				labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
				projectRoot: optionalString(input, "project_root"),
			}, eventContext(input));
		}),
		define("skills.create_template", () => {
			throw new Error("artifact templates are retired (zero real production usage, confirmed live) -- create the target artifact directly (e.g. docs.create, tasks.create, playbooks.create) instead of skills.create_template");
		}),
		define("skills.list", (input: OperationInput) => listPlaybooks(artifacts, artifactScopes, artifactFilter(input))),
		define("skills.show", (input: OperationInput) => showPlaybook(artifacts, string(input, "id"))),
		define("skills.invoke", (input: OperationInput) => playbookInvocation(artifacts, string(input, "id"))),
		define("skills.run", () => {
			throw new Error("workflow Skill execution is retired (zero real production usage, confirmed live) -- author a Playbook with structured (doc/rule/call) steps and typed arguments, then call playbooks.invoke instead");
		}),
		define("skills.enable", (input: OperationInput) => transitionPlaybook(artifacts, string(input, "id"), "enable", eventContext(input))),
		define("skills.disable", (input: OperationInput) => transitionPlaybook(artifacts, string(input, "id"), "disable", eventContext(input))),
		define("skills.assign_project", (input: OperationInput) => assignPlaybookProject(artifacts, artifactScopes, string(input, "id"), optionalString(input, "project_root"))),
		define("skills.update", (input: OperationInput) => updatePlaybook(artifacts, string(input, "id"), {
			title: optionalString(input, "title"), body: optionalString(input, "body"), labels: input["labels"] as string[] | undefined,
		}, eventContext(input))),
	];
}
