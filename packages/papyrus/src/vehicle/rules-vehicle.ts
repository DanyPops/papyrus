/**
 * Rules projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/rules.ts's operation definitions (rules.injectable stays a
 * composition-root-only concern, absent here too). remove/restore/remove_subtree
 * are not duplicated here -- see ./artifact-trash-vehicle.ts.
 */
import { bindVehicleOperation, defineVehicleOperation } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { listRules } from "../domain-services.ts";
import { rulesOperations } from "../modules/rules.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import { looseObjectSchema, numberProp, passthroughOutput, resolveArtifactIdWidened, stringProp } from "./artifact-vehicle-shared.ts";

const OWNER = "rules";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

/** Resolves a rule's id from either an explicit id or its title, widened past project_root when unscoped-vs-scoped search finds nothing. */
function resolveRuleId(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRoot: string | undefined,
	id: unknown,
	name: unknown,
): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw new Error("id or name is required");
	return resolveArtifactIdWidened(
		name,
		() => listRules(artifacts, scopes, { text: name, projectRoot }),
		projectRoot === undefined ? undefined : () => listRules(artifacts, scopes, { text: name }),
	);
}

/**
 * Resolves a task's id from its title for rules.gate. No ambient cwd to default
 * project_root to server-side -- pass project_root explicitly, or this searches
 * unscoped.
 */
function resolveTaskId(artifacts: ArtifactStore, _projectRoot: string | undefined, id: unknown, name: unknown): string | undefined {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) return undefined;
	return resolveArtifactIdWidened(name, () => artifacts.query({ kind: "task", text: name }));
}

export function registerRulesVehicleOperations(registry: VehicleRegistry, artifacts: ArtifactStore, scopes: ArtifactScopeStore): void {
	const moduleOperations = new Map(rulesOperations(artifacts, scopes).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);

	const define = (
		action: string,
		description: string,
		effect: "read" | "local-write",
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
	): void => {
		const operation = defineVehicleOperation({
			name: `rules.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["rules:read", "rules:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => call(`rules.${action}`, resolve(context.input))),
		);
	};

	define(
		"create",
		"Creates a Rule -- a standing constraint injected into the agent system prompt while active. project_root is optional (omitted = unscoped).",
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			condition: stringProp,
			rule_action: stringProp,
			severity: { type: "string", enum: ["block", "warn", "info"] },
			labels: { type: "array" } as unknown as { type: string },
			extra: { type: "object" } as unknown as { type: string },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["title"],
		(input) => input,
	);

	define(
		"list",
		"Lists Rules matching an optional status/text filter, scoped to project_root when given.",
		"read",
		{ status: stringProp, text: stringProp, limit: numberProp, project_root: stringProp },
		[],
		(input) => input,
	);

	define("show", "Shows one Rule by id or title.", "read", { id: stringProp, name: stringProp, project_root: stringProp }, [], (input) => ({
		...input,
		id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name),
	}));

	define(
		"preview",
		"Renders a Rule's own condition/action/body preview text with no side effects.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"enable",
		"Enables a Rule so it starts injecting into the agent system prompt.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"disable",
		"Disables a Rule; it stops injecting into the agent system prompt.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"gate",
		"Attaches a Rule as a gate condition on a Task. Prefer task_name over task_id -- resolved server-side (unscoped if project_root is omitted, since there is no ambient cwd to default to here).",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			task_id: stringProp,
			task_name: stringProp,
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const taskId = resolveTaskId(artifacts, input.project_root as string | undefined, input.task_id, input.task_name);
			if (!taskId) throw new Error("task_id or task_name is required");
			return {
				...input,
				id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name),
				task_id: taskId,
			};
		},
	);

	define(
		"assign_project",
		"Reassigns a Rule's project_root, or unscopes it when project_root is omitted.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, undefined, input.id, input.name) }),
	);

	define(
		"update",
		"Changes a Rule's title/body/labels (at least one required). Body updates still enforce the same combined condition+action+body context-tax bound as creation.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			title: stringProp,
			body: stringProp,
			labels: { type: "array" } as unknown as { type: string },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);
}
