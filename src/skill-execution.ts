import { randomUUID } from "node:crypto";
import { SKILL_MAX_RENDERED_BYTES, SKILL_RUN_ID_MAX_LENGTH, TASK_EXECUTION_MAX_EDGES } from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import { validateChecklist } from "./domain/checklist.ts";
import {
	resolveSkillArguments,
	validateSkillDefinition,
	type SkillArgumentValue,
	type SkillDefinition,
} from "./domain/skill-definition.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import { requireAtomicArtifactStore } from "./ports/atomic-artifact-store.ts";
import { projectTaskExecution, type TaskExecutionPlan } from "./task-execution.ts";
import type { TaskGraph, TaskNode } from "./task-service.ts";

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
	};
	rootTaskIds: string[];
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

export function instantiateSkillWorkflow(
	artifacts: ArtifactStore,
	skillId: string,
	input: InstantiateSkillWorkflowInput = {},
): SkillWorkflowRunResult {
	const { definition } = requireWorkflowSkill(artifacts, skillId);
	const arguments_ = resolveSkillArguments(definition, input.arguments);
	const rendered = renderDefinition(definition, arguments_);
	const runId = normalizeRunId(skillId, input.runId);
	const refs = [
		...rendered.blueprints.docs.map(({ ref }) => ref),
		...rendered.blueprints.rules.map(({ ref }) => ref),
		...rendered.blueprints.tasks.map(({ ref }) => ref),
	];
	const ids = new Map(refs.map((ref) => [ref, `${runId}-${ref}`]));
	const taskIds = rendered.blueprints.tasks.map(({ ref }) => ids.get(ref)!);
	const rootTaskIds = rendered.blueprints.tasks
		.filter((task) => (task.dependsOn?.length ?? 0) === 0)
		.map((task) => ids.get(task.ref)!);
	const relationshipCount = rendered.links.length
		+ rendered.blueprints.tasks.reduce((count, task) => count + (task.dependsOn?.length ?? 0) + (task.parent ? 2 : 0), 0)
		+ rootTaskIds.length;
	if (relationshipCount > TASK_EXECUTION_MAX_EDGES) {
		throw new Error(`skill workflow run exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
	}

	const atomic = requireAtomicArtifactStore(artifacts);
	return atomic.atomic(() => {
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
		const tasks = rendered.blueprints.tasks.map((blueprint) => artifacts.create({
			id: ids.get(blueprint.ref),
			kind: "task",
			title: blueprint.title,
			body: blueprint.body,
			labels: withRunLabel(blueprint.labels, runId),
			extra: { ...(blueprint.extra ?? {}), skillRun: { id: runId, skillId, ref: blueprint.ref } },
		}));

		for (const blueprint of rendered.blueprints.tasks) {
			const id = ids.get(blueprint.ref)!;
			for (const dependency of blueprint.dependsOn ?? []) {
				artifacts.link({ from: id, relation: "depends_on", to: ids.get(dependency)! });
			}
			if (blueprint.parent) {
				const parentId = ids.get(blueprint.parent)!;
				artifacts.link({ from: parentId, relation: "contains", to: id });
				artifacts.link({ from: id, relation: "part_of", to: parentId });
			}
		}
		for (const link of rendered.links) {
			artifacts.link({ from: ids.get(link.from)!, relation: link.relation, to: ids.get(link.to)! });
		}
		for (const rootTaskId of rootTaskIds) artifacts.link({ from: skillId, relation: "triggers", to: rootTaskId });

		return {
			skillId,
			runId,
			arguments: arguments_,
			created: {
				docs: docs.map(({ id }) => id),
				rules: rules.map(({ id }) => id),
				tasks: tasks.map(({ id }) => id),
			},
			rootTaskIds,
			execution: projectTaskExecution(executionGraph(tasks, rendered, ids)),
		};
	});
}
