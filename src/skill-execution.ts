import { randomUUID } from "node:crypto";
import { SKILL_MAX_RENDERED_BYTES, SKILL_RUN_ID_MAX_LENGTH, SKILL_WORKFLOW_MAX_NESTING_DEPTH, TASK_EXECUTION_MAX_EDGES } from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import { validateChecklist } from "./domain/checklist.ts";
import {
	resolveSkillArguments,
	validateSkillDefinition,
	type SkillArgumentValue,
	type SkillCallBlueprint,
	type SkillDefinition,
} from "./domain/skill-definition.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { TaskEventContext } from "./domain/task-event.ts";
import type { TaskEventStore } from "./ports/task-event-store.ts";
import type { TaskScopeStore } from "./ports/task-scope-store.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";
import { requireAtomicArtifactStore } from "./ports/atomic-artifact-store.ts";
import { projectTaskExecution, type TaskExecutionPlan } from "./task-execution.ts";
import type { TaskGraph, TaskNode, TaskStatus } from "./task-service.ts";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EXACT_PLACEHOLDER_PATTERN = /^{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}$/;
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}/g;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface InstantiateSkillWorkflowInput {
	runId?: string;
	arguments?: Record<string, unknown>;
}

export interface SkillWorkflowRunResult {
	skillId: string;
	runId: string;
	arguments: Record<string, SkillArgumentValue>;
	created: {
		docs: string[];
		rules: string[];
		tasks: string[];
		/** Nested workflow Skill runs this pipeline triggered as pipeline steps, in execution order. */
		skillRuns: string[];
	};
	/** Real starting points: for a nested skill-call root step, that nested run's own root tasks (recursively), not just "all its tasks". */
	rootTaskIds: string[];
	/** Scoped to this definition's own directly-created tasks only -- nested runs' tasks are real, graph-linked, and visible via /tasks graph, but not folded into this projection. */
	execution: TaskExecutionPlan;
}

function requireWorkflowSkill(artifacts: ArtifactStore, skillId: string): { skill: Artifact; definition: SkillDefinition } {
	const skill = artifacts.get(skillId);
	if (!skill) throw new Error(`skill artifact "${skillId}" not found`);
	if (skill.kind !== "skill" || skill.subtype !== "workflow") {
		throw new Error(`artifact "${skillId}" is not a workflow Skill`);
	}
	if (skill.status !== "active") throw new Error(`cannot run workflow Skill from ${skill.status}`);
	return { skill, definition: validateSkillDefinition(skill.extra["definition"]) };
}

function normalizeRunId(skillId: string, requested: string | undefined): string {
	const runId = requested ?? `${skillId.slice(0, 40)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	if (runId.length > SKILL_RUN_ID_MAX_LENGTH || !RUN_ID_PATTERN.test(runId)) {
		throw new Error(`skill run id must match ${RUN_ID_PATTERN} and contain at most ${SKILL_RUN_ID_MAX_LENGTH} characters`);
	}
	return runId;
}

function renderValue(value: unknown, arguments_: Record<string, SkillArgumentValue>): unknown {
	if (typeof value === "string") {
		const exact = value.match(EXACT_PLACEHOLDER_PATTERN);
		if (exact) {
			const name = exact[1]!;
			if (!(name in arguments_)) throw new Error(`skill input placeholder "${name}" has no argument value`);
			return arguments_[name]!;
		}
		return value.replace(PLACEHOLDER_PATTERN, (_placeholder, name: string) => {
			if (!(name in arguments_)) throw new Error(`skill input placeholder "${name}" has no argument value`);
			return String(arguments_[name]!);
		});
	}
	if (Array.isArray(value)) return value.map((entry) => renderValue(entry, arguments_));
	if (typeof value !== "object" || value === null) return value;
	const rendered: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (UNSAFE_KEYS.has(key)) throw new Error(`unsafe skill blueprint key "${key}"`);
		rendered[key] = renderValue(entry, arguments_);
	}
	return rendered;
}

function renderDefinition(definition: SkillDefinition, arguments_: Record<string, SkillArgumentValue>): SkillDefinition {
	const rendered = renderValue(definition, arguments_) as SkillDefinition;
	const bytes = new TextEncoder().encode(JSON.stringify(rendered)).byteLength;
	if (bytes > SKILL_MAX_RENDERED_BYTES) throw new Error(`rendered skill workflow exceeds ${SKILL_MAX_RENDERED_BYTES} bytes`);
	for (const task of rendered.blueprints.tasks) {
		if (task.extra?.["checklist"] !== undefined) {
			task.extra["checklist"] = validateChecklist(task.extra["checklist"]);
		}
	}
	return validateSkillDefinition(rendered);
}

function withRunLabel(labels: string[] | undefined, runId: string): string[] {
	return [...new Set([...(labels ?? []), `skill-run:${runId}`])];
}

function executionGraph(tasks: Artifact[], definition: SkillDefinition, ids: Map<string, string>): TaskGraph {
	const byRef = new Map(definition.blueprints.tasks.map((task) => [task.ref, task]));
	const nodes: TaskNode[] = tasks.map((task) => {
		const ref = task.extra["skillRun"] && typeof task.extra["skillRun"] === "object"
			? (task.extra["skillRun"] as Record<string, unknown>)["ref"] as string
			: "";
		const blueprint = byRef.get(ref)!;
		return {
			task,
			active: false,
			parentIds: blueprint.parent ? [ids.get(blueprint.parent)!] : [],
			childIds: definition.blueprints.tasks.filter((candidate) => candidate.parent === ref).map((candidate) => ids.get(candidate.ref)!),
			dependencyIds: (blueprint.dependsOn ?? []).map((dependency) => ids.get(dependency)!),
		};
	});
	return { nodes, rootIds: nodes.filter((node) => node.parentIds.length === 0).map((node) => node.task.id) };
}

type SkillWorkflowHistory = { events: TaskEventStore; scopes: TaskScopeStore; projectRoot: string; context?: TaskEventContext };

/**
 * Public entry point: wraps one complete pipeline run (including every nested sub-pipeline
 * it triggers) in exactly one atomic transaction. The recursive core (runWorkflowSteps) never
 * opens its own atomic wrapper -- SQLite savepoint nesting (inTransaction in db.ts) would
 * tolerate it, but wrapping once here keeps the atomicity story unambiguous: one skills.run
 * call is one all-or-nothing graph mutation, however many nested skills it triggers.
 */
export function instantiateSkillWorkflow(
	artifacts: ArtifactStore,
	skillId: string,
	input: InstantiateSkillWorkflowInput = {},
	history?: SkillWorkflowHistory,
): SkillWorkflowRunResult {
	const run = () => runWorkflowSteps(artifacts, skillId, input, history, new Set(), 0);
	if (history) return history.events.atomic(run);
	return requireAtomicArtifactStore(artifacts).atomic(run);
}

/**
 * The recursive pipeline core. A workflow Skill's `skills` blueprint entries are pipeline
 * steps that trigger another workflow Skill's own run -- the Jenkins "downstream job" /
 * Ansible "include_tasks" primitive. Nested runs execute BEFORE this level's dependsOn/parent
 * edges are wired, since a step depending on a skill-call ref needs to know every task id
 * that nested run actually produced (not knowable ahead of time -- it depends on the nested
 * skill's own definition). `ancestorSkillIds` tracks the current call CHAIN (not a global
 * ever-visited set): sibling skill-calls under the same parent are independent and may
 * legitimately share a called skill; only a real cycle back to an ancestor is rejected.
 */
function runWorkflowSteps(
	artifacts: ArtifactStore,
	skillId: string,
	input: InstantiateSkillWorkflowInput,
	history: SkillWorkflowHistory | undefined,
	ancestorSkillIds: ReadonlySet<string>,
	depth: number,
): SkillWorkflowRunResult {
	if (ancestorSkillIds.has(skillId)) throw new Error(`skill workflow nesting cycle includes "${skillId}"`);
	if (depth > SKILL_WORKFLOW_MAX_NESTING_DEPTH) throw new Error(`skill workflow nesting exceeds ${SKILL_WORKFLOW_MAX_NESTING_DEPTH} levels`);
	const nextAncestors = new Set([...ancestorSkillIds, skillId]);

	const { definition } = requireWorkflowSkill(artifacts, skillId);
	const projectRoot = history ? normalizeProjectRoot(history.projectRoot) : undefined;
	const arguments_ = resolveSkillArguments(definition, input.arguments);
	const rendered = renderDefinition(definition, arguments_);
	const runId = normalizeRunId(skillId, input.runId);
	const refs = [
		...rendered.blueprints.docs.map(({ ref }) => ref),
		...rendered.blueprints.rules.map(({ ref }) => ref),
		...rendered.blueprints.tasks.map(({ ref }) => ref),
		...rendered.blueprints.skills.map(({ ref }) => ref),
	];
	const ids = new Map(refs.map((ref) => [ref, `${runId}-${ref}`]));
	const taskIds = rendered.blueprints.tasks.map(({ ref }) => ids.get(ref)!);
	// A bound at THIS level's own blueprint size; nested runs are independently bounded the same
	// way at their own level, and nesting depth is separately capped -- so total blast radius
	// across a whole pipeline stays bounded on both dimensions even though a step's dependency
	// on a skill-call ref can fan out to more edges than this per-level count captures exactly.
	const relationshipCount = rendered.links.length
		+ rendered.blueprints.tasks.reduce((count, task) => count + (task.dependsOn?.length ?? 0) + (task.parent ? 2 : 0), 0)
		+ rendered.blueprints.skills.reduce((count, call) => count + (call.dependsOn?.length ?? 0) + (call.parent ? 2 : 0), 0)
		+ rendered.blueprints.tasks.filter((task) => (task.dependsOn?.length ?? 0) === 0).length
		+ rendered.blueprints.skills.filter((call) => (call.dependsOn?.length ?? 0) === 0).length;
	if (relationshipCount > TASK_EXECUTION_MAX_EDGES) {
		throw new Error(`skill workflow run exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
	}

	const docs = rendered.blueprints.docs.map((blueprint) => artifacts.create({
		id: ids.get(blueprint.ref),
		kind: "doc",
		title: blueprint.title,
		body: blueprint.body,
		subtype: blueprint.subtype,
		labels: withRunLabel(blueprint.labels, runId),
		extra: { ...(blueprint.extra ?? {}), skillRun: { id: runId, skillId, ref: blueprint.ref } },
	}));
	const rules = rendered.blueprints.rules.map((blueprint) => artifacts.create({
		id: ids.get(blueprint.ref),
		kind: "rule",
		title: blueprint.title,
		body: blueprint.body,
		labels: withRunLabel(blueprint.labels, runId),
		extra: {
			...(blueprint.extra ?? {}),
			...(blueprint.condition ? { condition: blueprint.condition } : {}),
			...(blueprint.action ? { action: blueprint.action } : {}),
			...(blueprint.severity ? { severity: blueprint.severity } : {}),
			skillRun: { id: runId, skillId, ref: blueprint.ref },
			scope: { type: "skill-run", runId, taskIds },
		},
	}));
	const tasks = rendered.blueprints.tasks.map((blueprint) => {
		const task = artifacts.create({
			id: ids.get(blueprint.ref),
			kind: "task",
			title: blueprint.title,
			body: blueprint.body,
			labels: withRunLabel(blueprint.labels, runId),
			extra: { ...(blueprint.extra ?? {}), skillRun: { id: runId, skillId, ref: blueprint.ref } },
		});
		if (history) {
			history.scopes.assign(task.id, projectRoot, "cwd");
			history.events.append({
				taskId: task.id,
				type: "created",
				actor: history.context?.actor ?? "system",
				source: history.context?.source ?? "skill-run",
				toStatus: task.status as TaskStatus,
				...(history.context?.sessionId === undefined ? {} : { sessionId: history.context.sessionId }),
				...(history.context?.reason === undefined ? {} : { reason: history.context.reason }),
			});
		}
		return task;
	});

	// Nested pipeline steps run before edge-wiring: dependents need to know what tasks each
	// nested run actually produced. stepTaskIds/stepRootTaskIds map EVERY step ref (task or
	// skill-call) to the task id(s) it resolves to, so dependsOn/parent wiring below treats
	// both kinds of step uniformly.
	const nestedRuns: SkillWorkflowRunResult[] = [];
	const stepTaskIds = new Map<string, string[]>(tasks.map((task, index) => [rendered.blueprints.tasks[index]!.ref, [task.id]]));
	const stepRootTaskIds = new Map<string, string[]>(
		tasks.map((task, index) => [rendered.blueprints.tasks[index]!.ref, (rendered.blueprints.tasks[index]!.dependsOn?.length ?? 0) === 0 ? [task.id] : []]),
	);
	for (const call of rendered.blueprints.skills as SkillCallBlueprint[]) {
		const nested = runWorkflowSteps(
			artifacts,
			call.skillId,
			{ runId: `${runId}-${call.ref}`, arguments: call.arguments },
			history,
			nextAncestors,
			depth + 1,
		);
		nestedRuns.push(nested);
		stepTaskIds.set(call.ref, nested.created.tasks);
		stepRootTaskIds.set(call.ref, nested.rootTaskIds);
	}

	for (const blueprint of rendered.blueprints.tasks) {
		const id = ids.get(blueprint.ref)!;
		for (const dependency of blueprint.dependsOn ?? []) {
			for (const dependencyId of stepTaskIds.get(dependency) ?? []) artifacts.link({ from: id, relation: "depends_on", to: dependencyId });
		}
		if (blueprint.parent) {
			const parentId = ids.get(blueprint.parent)!;
			artifacts.link({ from: parentId, relation: "contains", to: id });
			artifacts.link({ from: id, relation: "part_of", to: parentId });
		}
	}
	for (const call of rendered.blueprints.skills as SkillCallBlueprint[]) {
		const stepTaskIdsForCall = stepTaskIds.get(call.ref) ?? [];
		for (const dependency of call.dependsOn ?? []) {
			for (const dependencyId of stepTaskIds.get(dependency) ?? []) {
				for (const taskId of stepTaskIdsForCall) artifacts.link({ from: taskId, relation: "depends_on", to: dependencyId });
			}
		}
		if (call.parent) {
			const parentId = ids.get(call.parent)!;
			for (const rootTaskId of stepRootTaskIds.get(call.ref) ?? []) {
				artifacts.link({ from: parentId, relation: "contains", to: rootTaskId });
				artifacts.link({ from: rootTaskId, relation: "part_of", to: parentId });
			}
		}
	}
	for (const link of rendered.links) {
		const fromIds = stepTaskIds.get(link.from) ?? [ids.get(link.from)!];
		const toIds = stepTaskIds.get(link.to) ?? [ids.get(link.to)!];
		for (const from of fromIds) for (const to of toIds) artifacts.link({ from, relation: link.relation, to });
	}

	const rootTaskIds = [
		...rendered.blueprints.tasks.filter((task) => (task.dependsOn?.length ?? 0) === 0).map((task) => ids.get(task.ref)!),
		...(rendered.blueprints.skills as SkillCallBlueprint[])
			.filter((call) => (call.dependsOn?.length ?? 0) === 0)
			.flatMap((call) => stepRootTaskIds.get(call.ref) ?? []),
	];
	for (const task of rendered.blueprints.tasks) {
		if ((task.dependsOn?.length ?? 0) === 0) artifacts.link({ from: skillId, relation: "triggers", to: ids.get(task.ref)! });
	}
	for (const call of rendered.blueprints.skills as SkillCallBlueprint[]) {
		if ((call.dependsOn?.length ?? 0) === 0) artifacts.link({ from: skillId, relation: "triggers", to: call.skillId });
	}

	return {
		skillId,
		runId,
		arguments: arguments_,
		created: {
			docs: [...docs.map(({ id }) => id), ...nestedRuns.flatMap((run) => run.created.docs)],
			rules: [...rules.map(({ id }) => id), ...nestedRuns.flatMap((run) => run.created.rules)],
			tasks: [...tasks.map(({ id }) => id), ...nestedRuns.flatMap((run) => run.created.tasks)],
			skillRuns: [...nestedRuns.map((run) => run.runId), ...nestedRuns.flatMap((run) => run.created.skillRuns)],
		},
		rootTaskIds,
		execution: projectTaskExecution(executionGraph(tasks, rendered, ids)),
	};
}
