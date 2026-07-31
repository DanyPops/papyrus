/**
 * Skills projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/skills.ts's operation definitions plus skills.instantiate (composition-
 * root-only in the module -- see instantiateSkillOrTemplate's own doc comment).
 * remove/restore/remove_subtree are not duplicated here -- see ./artifact-trash-vehicle.ts.
 *
 * skills.run's output carries its own `content` block (see @danypops/vehicle-core's
 * WithVehicleContent) built from the same execution-DAG summary pi-papyrus's hand-rolled
 * tool used to build client-side -- the model reads a summary, not the raw node/layer/
 * cycleId structure.
 */
import { bindVehicleOperation, defineVehicleOperation } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { AuthorityRegistry } from "../authority-registry.ts";
import { listSkills } from "../domain-services.ts";
import { instantiateSkillOrTemplate, skillsOperations } from "../modules/skills.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { TaskEventStore } from "../ports/task-event-store.ts";
import type { TaskScopeStore } from "../ports/task-scope-store.ts";
import type { Tasks } from "../task-service.ts";
import type { WorkflowRunResult } from "../workflow-execution.ts";
import { buildWorkflowRunContent, looseObjectSchema, numberProp, passthroughOutput, resolveArtifactIdWidened, stringProp } from "./artifact-vehicle-shared.ts";

const OWNER = "skills";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

export interface SkillsVehicleDeps {
	artifacts: ArtifactStore;
	events: TaskEventStore;
	scopes: TaskScopeStore;
	artifactScopes: ArtifactScopeStore;
	authority: AuthorityRegistry;
	/** Only for skills.instantiate's task-target branch -- see instantiateSkillOrTemplate. */
	tasks: Tasks;
}

function resolveSkillId(artifacts: ArtifactStore, scopes: ArtifactScopeStore, projectRoot: string | undefined, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw new Error("id or name is required");
	return resolveArtifactIdWidened(
		name,
		() => listSkills(artifacts, scopes, { text: name, projectRoot }),
		projectRoot === undefined ? undefined : () => listSkills(artifacts, scopes, { text: name }),
	);
}

function resolveTemplateId(artifacts: ArtifactStore, scopes: ArtifactScopeStore, projectRoot: string | undefined, id: unknown, name: unknown): string | undefined {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) return undefined;
	return resolveArtifactIdWidened(
		name,
		() => listSkills(artifacts, scopes, { text: name, projectRoot }),
		projectRoot === undefined ? undefined : () => listSkills(artifacts, scopes, { text: name }),
	);
}

export function registerSkillsVehicleOperations(registry: VehicleRegistry, deps: SkillsVehicleDeps): void {
	const { artifacts, events, scopes, artifactScopes, authority, tasks } = deps;
	const moduleOperations = new Map(skillsOperations({ artifacts, events, scopes, artifactScopes, authority }).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);

	const define = (
		action: string,
		description: string,
		effect: "read" | "local-write",
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
		execute?: (input: Record<string, unknown>) => unknown,
	): void => {
		const operation = defineVehicleOperation({
			name: `skills.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["skills:read", "skills:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(OWNER, bindVehicleOperation(operation, () => async (context) => (execute ?? ((input: Record<string, unknown>) => call(`skills.${action}`, input)))(resolve(context.input))));
	};

	define(
		"create",
		"Creates a Skill -- a parameterized Task/Rule/Doc bundle, distinct from a prompt-only skill. project_root is optional (omitted = unscoped).",
		"local-write",
		{ title: stringProp, body: stringProp, trigger: stringProp, steps: { type: "array" }, tools: { type: "array" }, definition: { type: "object" }, labels: { type: "array" }, extra: { type: "object" }, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["title"],
		(input) => input,
	);

	define(
		"create_template",
		"Creates a compatibility artifact-template (defaults/required fields for a target kind), distinct from a workflow Skill.",
		"local-write",
		{ title: stringProp, target_kind: stringProp, defaults: { type: "object" }, required: { type: "array" }, body: stringProp, labels: { type: "array" }, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["title", "target_kind"],
		(input) => input,
	);

	define(
		"list",
		"Lists Skills matching an optional status/text filter, scoped to project_root when given.",
		"read",
		{ status: stringProp, text: stringProp, limit: numberProp, project_root: stringProp },
		[],
		(input) => input,
	);

	define(
		"show",
		"Shows one Skill by id or title.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"invoke",
		"Renders a Skill's own preview text with no side effects.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"run",
		"Validates arguments and atomically creates one scoped workflow run: real Tasks/Rules/Docs wired with dependsOn, one step surfacing at a time as it becomes focused -- no text dump. project_root is required here (no ambient cwd server-side); pass it explicitly.",
		"local-write",
		{ id: stringProp, name: stringProp, run_id: stringProp, arguments: { type: "object" }, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["project_root"],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, input.project_root as string | undefined, input.id, input.name) }),
		(input) => {
			const run = call("skills.run", input) as WorkflowRunResult;
			const content = buildWorkflowRunContent(artifacts, `Created Skill run ${run.runId}: ${run.created.tasks.length} tasks, ${run.created.rules.length} rules, ${run.created.docs.length} docs.`, run);
			return { ...run, content: [content] };
		},
	);

	define(
		"enable",
		"Enables a Skill.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"disable",
		"Disables a Skill.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"instantiate",
		"Instantiates a compatibility artifact-template (template_id/template_name) -- a task-target template calls tasks.create() directly; any other target creates a plain artifact. project_root is required here (no ambient cwd server-side).",
		"local-write",
		{ template_id: stringProp, template_name: stringProp, title: stringProp, body: stringProp, status: stringProp, labels: { type: "array" }, extra: { type: "object" }, subtype: stringProp, kind: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["title", "project_root"],
		(input) => {
			const templateId = resolveTemplateId(artifacts, artifactScopes, input.project_root as string | undefined, input.template_id, input.template_name);
			if (!templateId) throw new Error("template_id or template_name is required");
			return { ...input, template_id: templateId };
		},
		(input) => instantiateSkillOrTemplate({ artifacts, tasks, authority }, input, { actor: input.actor as string | undefined, source: input.source as string | undefined, sessionId: (input.session_id ?? input.sessionId) as string | undefined }),
	);

	define(
		"assign_project",
		"Reassigns a Skill's project_root, or unscopes it when project_root is omitted.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, undefined, input.id, input.name) }),
	);

	define(
		"update",
		"Changes a Skill's title/body/labels (at least one required). Refused for a read-only external projection.",
		"local-write",
		{ id: stringProp, name: stringProp, title: stringProp, body: stringProp, labels: { type: "array" }, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveSkillId(artifacts, artifactScopes, input.project_root as string | undefined, input.id, input.name) }),
	);
}
