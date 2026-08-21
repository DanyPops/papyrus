/**
 * Playbooks projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/playbooks.ts's operation definitions. remove/restore/remove_subtree are
 * not duplicated here -- see ./artifact-trash-vehicle.ts.
 *
 * playbooks.invoke's own module handler calls tasks.focus() directly (bypassing the
 * guarded tasks.focus operation, per modules/playbooks.ts's own doc comment) and re-runs
 * that exact guard itself via sessionIdentity.assertAuthorized(session_id, session_secret).
 * Those two fields never belong in this operation's model-visible inputSchema -- a model
 * has no business knowing or supplying a session secret. Instead they travel through
 * VehicleInvocationOptions.principal.claims, populated by pi-papyrus's own
 * resolveInvocation hook (see pi-papyrus's tools/vehicle-notes-client.ts) from its own already-cached
 * session_secret, the same value the hand-rolled tool used to thread through as a raw
 * input field. A caller with no cached secret for this session (unregistered, or a non-Pi
 * Vehicle client) simply gets the guard's own no-op-when-unset default, unchanged.
 *
 * invoke's output carries its own `content` block (see @danypops/vehicle-core's
 * WithVehicleContent) built from the same execution-DAG summary pi-papyrus's hand-rolled
 * tool used to build client-side.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { playbooksOperations } from "../modules/playbooks.ts";
import type { PlaybookInvocationResult, PlaybookMissingArguments } from "../playbook/playbook-execution.ts";
import { listPlaybooks } from "../playbook/playbook-service.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import type { TaskEventSink } from "../task/event/task-event-store.ts";
import type { TaskScopeAssigner } from "../task/scope/task-scope-store.ts";
import type { Tasks } from "../task/task-service.ts";
import {
	booleanProp,
	buildWorkflowRunContent,
	classifyPlaybookComposition,
	classifySessionAuthorization,
	classifyTaskExecutionBounds,
	createOperationDefiner,
	definePairedMutation,
	normalizeJsonEncodedField,
	numberProp,
	resolveArtifactIdWidened,
	stringProp,
	validationError,
} from "./shared.ts";

const OWNER = "playbooks";
const jsonObjectProp = {
	type: ["object", "string"],
	description: "A JSON object; a JSON-encoded object string is also accepted for tool-calling compatibility.",
} as const;

export interface PlaybooksVehicleDeps {
	artifacts: ArtifactStore;
	events: TaskEventSink;
	scopes: TaskScopeAssigner;
	artifactScopes: ArtifactScopeStore;
	tasks: Tasks;
	sessionIdentity: SessionIdentity;
	projectRegistry: ProjectRegistryStore;
	scopeGroups: ScopeGroupStore;
}

/** Unscoped resolution -- a Playbook is commonly cross-project (e.g. a lab-deploy playbook), matching the hand-rolled tool's own resolutionRequest choice. */
function resolvePlaybookId(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	return resolveArtifactIdWidened(artifacts, name, () => listPlaybooks(artifacts, scopes, { text: name }));
}

export function registerPlaybooksVehicleOperations(registry: VehicleRegistry, deps: PlaybooksVehicleDeps): void {
	const { artifacts, events, scopes, artifactScopes, tasks, sessionIdentity, projectRegistry, scopeGroups } = deps;
	const moduleOperations = new Map(
		playbooksOperations({ artifacts, events, scopes, artifactScopes, tasks, sessionIdentity, registry: projectRegistry, scopeGroups }).map(
			(op) => [op.name, op],
		),
	);
	/**
	 * Every playbooks.* action funnels through here. invoke's own module handler re-runs
	 * sessionIdentity.assertAuthorized directly (see this file's own doc comment) and its
	 * blueprint-materialization engine (playbook/workflow-execution.ts) can hit the same execution-graph
	 * bounds tasks-vehicle.ts's own operations do -- classifying both reviewed domain error classes
	 * at this one choke point covers every action that can throw them. Anything else propagates
	 * unchanged -- vehicle-registry's own secure-by-default handler-failed opacity still applies to a
	 * genuine unexpected crash (see artifact-vehicle-shared.ts's classify* helpers).
	 */
	const call = (name: string, input: Record<string, unknown>): unknown =>
		classifySessionAuthorization(() =>
			classifyTaskExecutionBounds(() => classifyPlaybookComposition(() => moduleOperations.get(name)!.execute(input))),
		);
	const define = createOperationDefiner(registry, OWNER, "playbooks", ["playbooks:read", "playbooks:write"], call);

	define(
		"create",
		"Creates a Playbook -- a trigger and an ordered list of steps. Each step is either a plain prose string (a task), or a structured object: {kind:'doc',title,body?,subtype?,labels?} creates a Doc, {kind:'rule',title,body?,condition?,action?,severity?,labels?} creates a Rule, {kind:'call',title,playbookId,arguments?} nests another Playbook's own run as a pipeline step gated in the same sequence, {kind:'task',title?,body} is an explicit task step. `arguments` declares named inputs: [{name, description?, required?, type?('string'|'number'|'boolean', default 'string'), enum?, default?}] (required defaults true), referenced in step text/call arguments as {{name}}. project_root is optional (omitted = unscoped).",
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			trigger: stringProp,
			steps: { type: "array" },
			tools: { type: "array" },
			arguments: { type: "array" },
			subtype: stringProp,
			labels: { type: "array" },
			extra: { type: "object" },
			activation: { type: "object", description: "Typed activation config: {enabled?,predicate?,labels?,priority?,injection?}." },
			activation_enabled: { ...booleanProp, description: "Persisted manual activation flag; defaults true." },
			template_id: stringProp,
			project_root: stringProp,
			projects: { type: "array" },
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["title"],
		(input) => {
			normalizeJsonEncodedField(input, "arguments");
			return input;
		},
	);

	define(
		"list",
		"Lists Playbooks matching an optional status/text filter. project_root alone scopes to EXACT membership in that project (audit semantics); project_root plus applicable:true instead lists every Playbook APPLICABLE to it (global Playbooks plus Playbooks whose membership includes it) -- what pi-papyrus's before_agent_start uses to inject only relevant Playbooks. Returns a lean summary (no body/steps) by default -- pass full: true for the complete artifact.",
		"read",
		{
			status: stringProp,
			text: stringProp,
			limit: numberProp,
			project_root: stringProp,
			applicable: booleanProp,
			activated: booleanProp,
			activation_context: { type: "object", description: "Trusted turn signals used by typed activation predicates." },
			full: booleanProp,
		},
		[],
		(input) => input,
	);

	define("show", "Shows one Playbook by id or title.", "read", { id: stringProp, name: stringProp }, [], (input) => ({
		...input,
		id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name),
	}));

	define(
		"preview",
		"Renders a Playbook's whole composition tree as text, with no side effects.",
		"read",
		{ id: stringProp, name: stringProp, arguments: jsonObjectProp },
		[],
		(input) => {
			normalizeJsonEncodedField(input, "arguments");
			return { ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) };
		},
	);

	define(
		"invoke",
		"Compiles the Playbook's steps and composition tree into real Tasks wired with dependsOn, and focuses the first one -- one step surfaces at a time as it becomes focused, exactly like any other Task. `arguments` supplies known values as {name: value}; if a declared REQUIRED argument is still missing, nothing is created and missingArguments is returned instead -- ask the human for these (discuss tool, live:true) and invoke again, never guess. Drive the returned entryTaskId forward with the tasks tool (start/submit/complete).",
		"local-write",
		{ id: stringProp, name: stringProp, run_id: stringProp, arguments: jsonObjectProp, project_root: stringProp },
		[],
		(input) => {
			normalizeJsonEncodedField(input, "arguments");
			return { ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) };
		},
		(input, context) => {
			const claims = context.principal?.claims as { sessionId?: string; sessionSecret?: string } | undefined;
			const invocation = call("playbooks.invoke", {
				...input,
				session_id: claims?.sessionId,
				session_secret: claims?.sessionSecret,
			}) as PlaybookInvocationResult | PlaybookMissingArguments;
			if ("missingArguments" in invocation) {
				const text = `Missing required argument(s): ${invocation.missingArguments.join(", ")}. Nothing was created -- ask the human for these (discuss tool, live:true), then invoke again.`;
				return { ...invocation, content: [{ type: "text" as const, text }] };
			}
			const nodeById = new Map(invocation.execution.nodes.map((node) => [node.id, node]));
			const entryLabel = nodeById.get(invocation.entryTaskId)?.title ?? invocation.entryTaskId;
			const content = buildWorkflowRunContent(
				artifacts,
				`Invoked playbook run ${invocation.runId}: ${invocation.created.tasks.length} task(s), ${invocation.created.rules.length} rule(s), ${invocation.created.docs.length} doc(s) created.`,
				invocation,
				[
					`Entry task now focused: ${entryLabel}. Drive it forward with the tasks tool (start/submit/complete) -- contains/depends_on wiring auto-focuses each next step.`,
				],
			);
			return { ...invocation, content: [content] };
		},
	);

	define(
		"enable",
		"Enables a Playbook.",
		"local-write",
		{ id: stringProp, name: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"disable",
		"Disables a Playbook.",
		"local-write",
		{ id: stringProp, name: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"assign_project",
		"Reassigns a Playbook's project_root, or unscopes it when project_root is omitted.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"scope",
		"Shows a Playbook's real project scope: global (applies everywhere) or the bounded set of registered projects it applies to.",
		"read",
		{ id: stringProp, name: stringProp },
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"set_global",
		"Makes a Playbook apply in every project, clearing any project membership. The only way to widen a project-bound Playbook back to global -- removing its last membership through remove_project is rejected instead.",
		"local-write",
		{ id: stringProp, name: stringProp },
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"add_project",
		"Adds one registered project (exact id, name, alias, or root) to a Playbook's membership, switching it from global to project-bound if it was global. Idempotent if the project is already a member.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project: { ...stringProp, description: "Exact project id, name, alias, or registered root to add." },
		},
		["project"],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"remove_project",
		"Removes one registered project from a Playbook's membership. Rejected while it is the Playbook's only remaining membership -- call set_global first if the Playbook should stop being project-bound entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project: { ...stringProp, description: "Exact project id, name, alias, or registered root to remove." },
		},
		["project"],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"replace_projects",
		"Replaces a Playbook's entire project membership with exactly this bounded, non-empty list of registered project references (id/name/alias/root). Use set_global instead to clear scoping entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			projects: { type: "array", description: "Non-empty list of exact project id/name/alias/root references." },
		},
		["projects"],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"set_none",
		"Fully hides a Playbook -- never applicable, never injected via before_agent_start, regardless of project. The only way back is set_global, add_project, add_group, or replace_projects/replace_groups.",
		"local-write",
		{ id: stringProp, name: stringProp },
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"add_group",
		"Adds one scope group (a named, reusable, possibly-nested collection of projects and/or other groups) to a Playbook's explicit scope, switching it from global/none to project-bound if it wasn't already. Idempotent if the group is already a member.",
		"local-write",
		{ id: stringProp, name: stringProp, group: { ...stringProp, description: "Exact scope group id, name, or alias to add." } },
		["group"],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"remove_group",
		"Removes one scope group from a Playbook's explicit scope. Rejected while it is the Playbook's only remaining scope member -- call set_global or set_none first.",
		"local-write",
		{ id: stringProp, name: stringProp, group: { ...stringProp, description: "Exact scope group id, name, or alias to remove." } },
		["group"],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"replace_groups",
		"Replaces a Playbook's entire scope-group membership with exactly this bounded, non-empty list of scope group references (id/name/alias). Use set_global/set_none instead to clear scoping entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			groups: { type: "array", description: "Non-empty list of exact scope group id/name/alias references." },
		},
		["groups"],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	define(
		"update",
		"Changes a Playbook's title/body/labels/trigger/steps (at least one required). `steps` accepts the exact same shape playbooks.create does and REPLACES the entire step list -- the way to fix a mistake or generalize a Playbook's steps after creation instead of the create-new+supersedes+disable workaround. Refused for a read-only external projection.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			title: stringProp,
			body: stringProp,
			labels: { type: "array" },
			trigger: stringProp,
			steps: { type: "array" },
			activation: { type: "object", description: "Replacement typed activation config." },
			activation_enabled: { ...booleanProp, description: "Persisted manual activation flag; retains other activation settings." },
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => ({ ...input, id: resolvePlaybookId(artifacts, artifactScopes, input.id, input.name) }),
	);

	const resolvePlaybookIdField = (input: Record<string, unknown>, idProp: string, nameProp: string): string =>
		resolvePlaybookId(artifacts, artifactScopes, input[idProp], input[nameProp]);

	definePairedMutation(
		define,
		{ idProp: "parent_id", nameProp: "parent_name" },
		{ idProp: "child_id", nameProp: "child_name" },
		{
			parent_id: stringProp,
			parent_name: stringProp,
			child_id: stringProp,
			child_name: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		resolvePlaybookIdField,
		{
			action: "contain",
			description:
				"Nests a child Playbook inside a parent -- the child's steps run AFTER the parent's own. Prefer parent_name/child_name over parent_id/child_id -- resolved server-side.",
		},
		{ action: "uncontain", description: "Removes a parent/child Playbook nesting. Idempotent -- a no-op if the edge is already absent." },
	);

	definePairedMutation(
		define,
		{ idProp: "id", nameProp: "name" },
		{ idProp: "dependency_id", nameProp: "dependency_name" },
		{
			id: stringProp,
			name: stringProp,
			dependency_id: stringProp,
			dependency_name: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		resolvePlaybookIdField,
		{
			action: "depend",
			description:
				"Chains a prerequisite Playbook before another -- it must fully complete FIRST. Prefer dependency_name over dependency_id.",
		},
		{ action: "undepend", description: "Removes a Playbook dependency. Idempotent -- a no-op if the edge is already absent." },
	);
}
