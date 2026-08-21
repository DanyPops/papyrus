/**
 * Rules projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/rules.ts's operation definitions (rules.injectable stays a
 * composition-root-only concern, absent here too). remove/restore/remove_subtree
 * are not duplicated here -- see ./artifact-trash-vehicle.ts.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { rulesOperations } from "../modules/rules.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import { listRules } from "../rules/rules-service.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { booleanProp, createOperationDefiner, numberProp, resolveArtifactIdWidened, stringProp, validationError } from "./shared.ts";

const OWNER = "rules";

/**
 * Resolves a rule's id from either an explicit id or its title. When project_root is given and
 * the project-scoped search finds nothing, widens only to a rule that actually APPLIES to this
 * project (global, or explicitly scoped to it via appliesToProjectRoot) -- never to a same-named
 * rule that belongs to a different project. A prior version widened to every rule of that name
 * across every project unconditionally once the scoped search came up empty, silently leaking a
 * name-based mutation across project boundaries.
 */
function resolveRuleId(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRoot: string | undefined,
	id: unknown,
	name: unknown,
): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	return resolveArtifactIdWidened(
		artifacts,
		name,
		() => listRules(artifacts, scopes, { text: name, projectRoot }),
		projectRoot === undefined
			? undefined
			: () => artifacts.query({ kind: "rule", text: name }).filter((rule) => scopes.appliesToProjectRoot(rule.id, projectRoot)),
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
	return resolveArtifactIdWidened(artifacts, name, () => artifacts.query({ kind: "task", text: name }));
}

export function registerRulesVehicleOperations(
	registry: VehicleRegistry,
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRegistry: ProjectRegistryStore,
	scopeGroups: ScopeGroupStore,
): void {
	const moduleOperations = new Map(rulesOperations(artifacts, scopes, projectRegistry, scopeGroups).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);
	const define = createOperationDefiner(registry, OWNER, "rules", ["rules:read", "rules:write"], call);

	define(
		"create",
		"Creates a Rule -- a standing constraint injected into the agent system prompt while active. Plain Rules start active; a template_id creates an inert draft that must pass the template's completionRequired fields through rules.enable. project_root is optional (omitted = unscoped). The response includes combinedLength (condition+action+body character count) and a non-blocking warning once it exceeds the ~600-character soft target (hard-rejected past 4000).",
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			condition: stringProp,
			rule_action: stringProp,
			severity: { type: "string", enum: ["block", "warn", "info"] },
			subtype: stringProp,
			labels: { type: "array" } as unknown as { type: string },
			extra: { type: "object" } as unknown as { type: string },
			activation: { type: "object", description: "Typed activation config: {predicate?,priority?,injection?}." } as unknown as {
				type: string;
			},
			template_id: stringProp,
			project_root: stringProp,
			projects: { type: "array" } as unknown as { type: string },
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["title"],
		(input) => input,
	);

	define(
		"list",
		"Lists Rules matching an optional status/text filter, scoped to project_root when given. Returns a lean summary (no condition/action/body) by default -- pass full: true for the complete artifact.",
		"read",
		{ status: stringProp, text: stringProp, limit: numberProp, project_root: stringProp, full: booleanProp },
		[],
		(input) => input,
	);

	define(
		"show",
		"Shows one Rule by id or title. The response includes combinedLength (condition+action+body character count) and a non-blocking warning once it exceeds the ~600-character soft target.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({
			...input,
			id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name),
		}),
	);

	define(
		"preview",
		"Renders a Rule's own condition/action/body preview text with no side effects. Response: { preview, combinedLength, warning? } -- warning is present only once combinedLength exceeds the ~600-character soft target.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"enable",
		"Enables a Rule so it starts injecting into the agent system prompt. A template-derived draft is enabled only after every field path in its source template's completionRequired array is present.",
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
			if (!taskId) throw validationError("task_id or task_name is required");
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
		"scope",
		"Shows a Rule's real project scope: global (applies everywhere) or the bounded set of registered projects it applies to.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"set_global",
		"Makes a Rule apply in every project, clearing any project membership. The only way to widen an active project-bound Rule back to global -- removing its last membership through remove_project is rejected instead.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"add_project",
		"Adds one registered project (exact id, name, alias, or root) to a Rule's membership, switching it from global to project-bound if it was global. Idempotent if the project is already a member.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project: { ...stringProp, description: "Exact project id, name, alias, or registered root to add." },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["project"],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"remove_project",
		"Removes one registered project from a Rule's membership. Rejected while it is the Rule's only remaining membership -- call set_global first if the Rule should stop being project-bound entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project: { ...stringProp, description: "Exact project id, name, alias, or registered root to remove." },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["project"],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"replace_projects",
		"Replaces a Rule's entire project membership with exactly this bounded, non-empty list of registered project references (id/name/alias/root). Use set_global instead to clear scoping entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			projects: { type: "array", description: "Non-empty list of exact project id/name/alias/root references." } as unknown as {
				type: string;
			},
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["projects"],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"set_none",
		"Fully hides a Rule -- never applicable, never injected into the agent system prompt, regardless of project. The only way back is set_global, add_project, add_group, or replace_projects/replace_groups.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"add_group",
		"Adds one scope group (a named, reusable, possibly-nested collection of projects and/or other groups) to a Rule's explicit scope, switching it from global/none to project-bound if it wasn't already. Idempotent if the group is already a member.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			group: { ...stringProp, description: "Exact scope group id, name, or alias to add." },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["group"],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"remove_group",
		"Removes one scope group from a Rule's explicit scope. Rejected while it is the Rule's only remaining scope member -- call set_global or set_none first.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			group: { ...stringProp, description: "Exact scope group id, name, or alias to remove." },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["group"],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"replace_groups",
		"Replaces a Rule's entire scope-group membership with exactly this bounded, non-empty list of scope group references (id/name/alias). Use set_global/set_none instead to clear scoping entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			groups: { type: "array", description: "Non-empty list of exact scope group id/name/alias references." } as unknown as {
				type: string;
			},
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		["groups"],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"update",
		"Changes a Rule's title/body/labels (at least one required). Body updates still enforce the same combined condition+action+body context-tax bound as creation. The response includes combinedLength and a non-blocking warning once it exceeds the ~600-character soft target.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			title: stringProp,
			body: stringProp,
			labels: { type: "array" } as unknown as { type: string },
			activation: { type: "object", description: "Replacement typed activation config." } as unknown as { type: string },
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => ({ ...input, id: resolveRuleId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);
}
