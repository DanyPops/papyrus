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
import { listPlaybooks } from "../domain-services.ts";
import { playbooksOperations } from "../modules/playbooks.ts";
import type { PlaybookInvocationResult, PlaybookMissingArguments } from "../playbook/playbook-execution.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import type { TaskEventStore } from "../stores/task-event-store.ts";
import type { TaskScopeStore } from "../stores/task-scope-store.ts";
import type { Tasks } from "../task/task-service.ts";
import {
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

export interface PlaybooksVehicleDeps {
	artifacts: ArtifactStore;
	events: TaskEventStore;
	scopes: TaskScopeStore;
	artifactScopes: ArtifactScopeStore;
	tasks: Tasks;
	sessionIdentity: SessionIdentity;
}

/** Unscoped resolution -- a Playbook is commonly cross-project (e.g. a lab-deploy playbook), matching the hand-rolled tool's own resolutionRequest choice. */
function resolvePlaybookId(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	return resolveArtifactIdWidened(artifacts, name, () => listPlaybooks(artifacts, scopes, { text: name }));
}

export function registerPlaybooksVehicleOperations(registry: VehicleRegistry, deps: PlaybooksVehicleDeps): void {
	const { artifacts, events, scopes, artifactScopes, tasks, sessionIdentity } = deps;
	const moduleOperations = new Map(
		playbooksOperations({ artifacts, events, scopes, artifactScopes, tasks, sessionIdentity }).map((op) => [op.name, op]),
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
			labels: { type: "array" },
			extra: { type: "object" },
			project_root: stringProp,
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
		"Lists Playbooks matching an optional status/text filter, scoped to project_root when given.",
		"read",
		{ status: stringProp, text: stringProp, limit: numberProp, project_root: stringProp },
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
		{ id: stringProp, name: stringProp, arguments: { type: "object" } },
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
		{ id: stringProp, name: stringProp, run_id: stringProp, arguments: { type: "object" }, project_root: stringProp },
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
		"update",
		"Changes a Playbook's title/body/labels (at least one required). Refused for a read-only external projection.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			title: stringProp,
			body: stringProp,
			labels: { type: "array" },
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
