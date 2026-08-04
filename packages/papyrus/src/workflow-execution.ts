import { randomUUID } from "node:crypto";
import {
	SKILL_MAX_RENDERED_BYTES,
	SKILL_RUN_ID_MAX_LENGTH,
	SKILL_WORKFLOW_MAX_NESTING_DEPTH,
	TASK_EXECUTION_MAX_EDGES,
} from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import {
	type BlueprintArgumentValue,
	type BlueprintDefinition,
	type CallBlueprint,
	resolveBlueprintArguments,
	validateBlueprintDefinition,
} from "./domain/blueprint-definition.ts";
import { validateChecklist } from "./domain/checklist.ts";
import type { TaskEventContext } from "./domain/task-event.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";
import { compilePlaybookDefinition, type PlaybookExternalLink } from "./playbook-definition.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import { requireAtomicArtifactStore } from "./ports/atomic-artifact-store.ts";
import type { TaskEventStore } from "./ports/task-event-store.ts";
import type { TaskScopeStore } from "./ports/task-scope-store.ts";
import { projectTaskExecution, TaskExecutionBoundExceededError, type TaskExecutionPlan } from "./task-execution.ts";
import type { TaskGraph, TaskNode, TaskStatus } from "./task-service.ts";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EXACT_PLACEHOLDER_PATTERN = /^{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}$/;
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}/g;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface InstantiateSkillWorkflowInput {
	runId?: string;
	arguments?: Record<string, unknown>;
	/** When set, names one blueprint task ref whose resolved real task id is returned as `entryTaskId` -- e.g. the first-in-reading-order step of a compiled Playbook, so the caller can focus it without recomputing the ref-to-id mapping externally. */
	focusRef?: string;
}

/**
 * Identifies who owns a materialized run for tagging purposes: which artifact gets the
 * `triggers` edges to its root tasks, which extra-bag key records run lineage on each created
 * artifact, and which label prefix scopes them. Defaults used by instantiateSkillWorkflow
 * (ownerId: the target's own id, extraKey: "skillRun", labelPrefix: "skill-run") are unchanged
 * from before this was made pluggable -- a Playbook-compiled run supplies its own (playbook id,
 * "playbookRun", "playbook-run") instead, the only thing that actually differs between the two.
 */
export interface WorkflowLineage {
	ownerId: string;
	extraKey: string;
	labelPrefix: string;
}

export interface WorkflowRunResult {
	skillId: string;
	runId: string;
	arguments: Record<string, BlueprintArgumentValue>;
	created: {
		docs: string[];
		rules: string[];
		tasks: string[];
		/** Nested workflow-definition runs this pipeline triggered as pipeline steps, in execution order. */
		skillRuns: string[];
	};
	/** Real starting points: for a nested call root step, that nested run's own root tasks (recursively), not just "all its tasks". */
	rootTaskIds: string[];
	/** Resolved from input.focusRef when supplied -- the one real task id a caller (e.g. Playbook invocation) should focus, undefined when focusRef was not requested or names an unknown ref. */
	entryTaskId?: string;
	/** Scoped to this definition's own directly-created tasks only -- nested runs' tasks are real, graph-linked, and visible via /tasks graph, but not folded into this projection. */
	execution: TaskExecutionPlan;
}

/**
 * A definition-shaped target: kind=playbook (Skill-the-kind is retired; every remaining
 * definition-holding row -- migrated legacy or freshly constructed -- lives under kind=playbook
 * now) with subtype=workflow, distinguishing it from an ordinary steps/trigger-shaped Playbook.
 */
function requireWorkflowSkill(artifacts: ArtifactStore, skillId: string): { skill: Artifact; definition: BlueprintDefinition } {
	const skill = artifacts.get(skillId);
	if (!skill) throw new Error(`playbook artifact "${skillId}" not found`);
	if (skill.kind !== "playbook" || skill.subtype !== "workflow") {
		throw new Error(`artifact "${skillId}" is not a workflow-definition playbook`);
	}
	if (skill.status !== "active") throw new Error(`cannot run workflow playbook from ${skill.status}`);
	return { skill, definition: validateBlueprintDefinition(skill.extra.definition) };
}

function normalizeRunId(skillId: string, requested: string | undefined): string {
	const runId = requested ?? `${skillId.slice(0, 40)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	if (runId.length > SKILL_RUN_ID_MAX_LENGTH || !RUN_ID_PATTERN.test(runId)) {
		throw new Error(`run id must match ${RUN_ID_PATTERN} and contain at most ${SKILL_RUN_ID_MAX_LENGTH} characters`);
	}
	return runId;
}

function renderValue(value: unknown, arguments_: Record<string, BlueprintArgumentValue>): unknown {
	if (typeof value === "string") {
		const exact = value.match(EXACT_PLACEHOLDER_PATTERN);
		if (exact) {
			const name = exact[1]!;
			if (!(name in arguments_)) throw new Error(`input placeholder "${name}" has no argument value`);
			return arguments_[name]!;
		}
		return value.replace(PLACEHOLDER_PATTERN, (_placeholder, name: string) => {
			if (!(name in arguments_)) throw new Error(`input placeholder "${name}" has no argument value`);
			return String(arguments_[name]!);
		});
	}
	if (Array.isArray(value)) return value.map((entry) => renderValue(entry, arguments_));
	if (typeof value !== "object" || value === null) return value;
	const rendered: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (UNSAFE_KEYS.has(key)) throw new Error(`unsafe blueprint key "${key}"`);
		rendered[key] = renderValue(entry, arguments_);
	}
	return rendered;
}

function renderDefinition(definition: BlueprintDefinition, arguments_: Record<string, BlueprintArgumentValue>): BlueprintDefinition {
	const rendered = renderValue(definition, arguments_) as BlueprintDefinition;
	const bytes = new TextEncoder().encode(JSON.stringify(rendered)).byteLength;
	if (bytes > SKILL_MAX_RENDERED_BYTES) throw new Error(`rendered workflow exceeds ${SKILL_MAX_RENDERED_BYTES} bytes`);
	for (const task of rendered.blueprints.tasks) {
		if (task.extra?.checklist !== undefined) {
			task.extra.checklist = validateChecklist(task.extra.checklist);
		}
	}
	return validateBlueprintDefinition(rendered);
}

function withRunLabel(labels: string[] | undefined, labelPrefix: string, runId: string): string[] {
	return [...new Set([...(labels ?? []), `${labelPrefix}:${runId}`])];
}

function executionGraph(tasks: Artifact[], definition: BlueprintDefinition, ids: Map<string, string>, extraKey: string): TaskGraph {
	const byRef = new Map(definition.blueprints.tasks.map((task) => [task.ref, task]));
	const nodes: TaskNode[] = tasks.map((task) => {
		const ref =
			task.extra[extraKey] && typeof task.extra[extraKey] === "object"
				? ((task.extra[extraKey] as Record<string, unknown>).ref as string)
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

/** projectRoot is optional -- skills.run always supplies one (workflow-definition runs are always project-scoped today), while a Playbook invocation may legitimately be ad hoc/cross-project (e.g. a lab-deploy playbook not tied to any one repo), landing its tasks in the same "unscoped" bucket Tasks.create already supports for a caller that omits projectRoot entirely. */
export type WorkflowRunHistory = { events: TaskEventStore; scopes: TaskScopeStore; projectRoot?: string; context?: TaskEventContext };

/**
 * Public entry point: wraps one complete pipeline run (including every nested sub-pipeline
 * it triggers) in exactly one atomic transaction. The recursive core (runWorkflowSteps) never
 * opens its own atomic wrapper -- SQLite savepoint nesting (inTransaction in db.ts) would
 * tolerate it, but wrapping once here keeps the atomicity story unambiguous: one run call is
 * one all-or-nothing graph mutation, however many nested targets it triggers.
 */
export function instantiateSkillWorkflow(
	artifacts: ArtifactStore,
	skillId: string,
	input: InstantiateSkillWorkflowInput = {},
	history?: WorkflowRunHistory,
): WorkflowRunResult {
	const run = () => runWorkflowSteps(artifacts, skillId, input, history, new Set(), 0);
	if (history) return history.events.atomic(run);
	return requireAtomicArtifactStore(artifacts).atomic(run);
}

/** Reads each created task's own lineage.ref tag back off the store -- resolves a compiled Playbook's blueprint refs back to real task ids after materialization, without threading an extra ref-to-id map out of materializeWorkflowDefinition's own return shape. Shared by top-level Playbook invocation (playbook-execution.ts) and a nested Playbook pipeline-call step alike. */
export function resolveRefToTaskId(artifacts: ArtifactStore, taskIds: string[], extraKey: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const taskId of taskIds) {
		const lineage = artifacts.get(taskId)?.extra[extraKey];
		if (typeof lineage !== "object" || lineage === null || Array.isArray(lineage)) continue;
		const ref = (lineage as Record<string, unknown>).ref;
		if (typeof ref === "string") map.set(ref, taskId);
	}
	return map;
}

/** Applies a compiled Playbook's external links (a Rule that `gates` it, a Doc it `references`, etc.) once its blueprint refs have resolved to real task ids -- shared by top-level Playbook invocation and a nested Playbook pipeline-call step alike. */
export function applyPlaybookExternalLinks(
	artifacts: ArtifactStore,
	externalLinks: PlaybookExternalLink[],
	refToTaskId: Map<string, string>,
): void {
	for (const link of externalLinks) {
		const taskId = refToTaskId.get(link.rootRef);
		if (!taskId) continue; // defensive -- every rootRef the compiler emits is always materialized
		if (link.ownerIsFrom) artifacts.link({ from: taskId, relation: link.relation, to: link.otherArtifactId });
		else artifacts.link({ from: link.otherArtifactId, relation: link.relation, to: taskId });
	}
}

/**
 * The recursive pipeline core. A `skills` blueprint entry's target can be either a
 * workflow-definition Playbook (an already-persisted, versioned JSON blueprint) or an ordinary
 * steps/trigger-shaped Playbook (its steps/composition tree compiled fresh, right here, the
 * same way a top-level Playbook invocation does) -- the Jenkins "downstream job" / Ansible
 * "include_tasks" primitive either way, dispatched purely by the target artifact's own subtype.
 * Nested runs execute BEFORE this level's dependsOn/parent edges are wired, since a step
 * depending on a call ref needs to know every task id that nested run actually produced (not
 * knowable ahead of time -- it depends on the nested target's own definition). `ancestorIds`
 * tracks the current call CHAIN (not a global ever-visited set): sibling calls under the same
 * parent are independent and may legitimately share a called target; only a real cycle back to
 * an ancestor is rejected. This is a SEPARATE cycle/depth check from a Playbook's own
 * contains/depends_on composition tree (playbook-definition.ts's compileNode) -- a cycle
 * threading through BOTH graphs at once (Playbook composition -> a call step -> back into that
 * same Playbook's composition) is not cross-checked between the two, but each graph's own
 * independent depth cap still bounds it; it fails with a nesting-depth error rather than a
 * precise cycle message, not an infinite loop.
 */
function runWorkflowSteps(
	artifacts: ArtifactStore,
	targetId: string,
	input: InstantiateSkillWorkflowInput,
	history: WorkflowRunHistory | undefined,
	ancestorIds: ReadonlySet<string>,
	depth: number,
): WorkflowRunResult {
	if (ancestorIds.has(targetId)) throw new Error(`workflow nesting cycle includes "${targetId}"`);
	if (depth > SKILL_WORKFLOW_MAX_NESTING_DEPTH) throw new Error(`workflow nesting exceeds ${SKILL_WORKFLOW_MAX_NESTING_DEPTH} levels`);
	const nextAncestors = new Set([...ancestorIds, targetId]);
	const target = artifacts.get(targetId);
	// subtype=workflow is the legacy definition-shaped case (raw extra.definition, no
	// extra.steps) -- compilePlaybookDefinition assumes an ordinary steps/trigger-shaped
	// Playbook and must not see it; it falls through to requireWorkflowSkill below instead.
	if (target?.kind === "playbook" && target.subtype !== "workflow") {
		const compiled = compilePlaybookDefinition(artifacts, targetId);
		const result = materializeWorkflowDefinition(
			artifacts,
			{ ownerId: targetId, extraKey: "playbookRun", labelPrefix: "playbook-run" },
			compiled.definition,
			{ ...input, focusRef: compiled.entryRef },
			history,
			nextAncestors,
			depth,
		);
		const refToTaskId = resolveRefToTaskId(artifacts, result.created.tasks, "playbookRun");
		applyPlaybookExternalLinks(artifacts, compiled.externalLinks, refToTaskId);
		return result;
	}
	const { definition } = requireWorkflowSkill(artifacts, targetId);
	return materializeWorkflowDefinition(
		artifacts,
		{ ownerId: targetId, extraKey: "skillRun", labelPrefix: "skill-run" },
		definition,
		input,
		history,
		nextAncestors,
		depth,
	);
}

/**
 * The definition-materialization core, shared by workflow-definition targets
 * (instantiateSkillWorkflow, via runWorkflowSteps above) and Playbook invocation
 * (playbook-execution.ts): given an ALREADY-RESOLVED BlueprintDefinition -- fetched from a
 * persisted workflow-definition artifact for that path, compiled in-memory from a Playbook's
 * steps/trigger/arguments and its contains/depends_on composition tree for the Playbook path --
 * creates every blueprint artifact, wires dependsOn/parent/links, recurses into nested call
 * pipeline steps (a no-op for a Playbook-compiled definition, which never populates
 * blueprints.skills), and tags every created artifact and the run's containing labels via
 * `lineage` rather than a hardcoded "skillRun"/"skill-run" shape -- the only thing that differs
 * between the two callers. `ancestorSkillIds`/`depth` are the same cycle/nesting-depth tracking
 * runWorkflowSteps already enforced before this was extracted; a Playbook caller with no nested
 * calls to recurse into passes an empty set and depth 0 and never revisits this function itself.
 */
export function materializeWorkflowDefinition(
	artifacts: ArtifactStore,
	lineage: WorkflowLineage,
	definition: BlueprintDefinition,
	input: InstantiateSkillWorkflowInput,
	history: WorkflowRunHistory | undefined,
	ancestorSkillIds: ReadonlySet<string>,
	depth: number,
): WorkflowRunResult {
	const { ownerId, extraKey, labelPrefix } = lineage;
	const projectRoot = history?.projectRoot !== undefined ? normalizeProjectRoot(history.projectRoot) : undefined;
	const arguments_ = resolveBlueprintArguments(definition, input.arguments);
	const rendered = renderDefinition(definition, arguments_);
	const runId = normalizeRunId(ownerId, input.runId);
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
	// on a call ref can fan out to more edges than this per-level count captures exactly.
	const relationshipCount =
		rendered.links.length +
		rendered.blueprints.tasks.reduce((count, task) => count + (task.dependsOn?.length ?? 0) + (task.parent ? 2 : 0), 0) +
		rendered.blueprints.skills.reduce((count, call) => count + (call.dependsOn?.length ?? 0) + (call.parent ? 2 : 0), 0) +
		rendered.blueprints.tasks.filter((task) => (task.dependsOn?.length ?? 0) === 0).length +
		rendered.blueprints.skills.filter((call) => (call.dependsOn?.length ?? 0) === 0).length;
	if (relationshipCount > TASK_EXECUTION_MAX_EDGES) {
		throw new TaskExecutionBoundExceededError(`workflow run exceeds ${TASK_EXECUTION_MAX_EDGES} relationships`);
	}

	const docs = rendered.blueprints.docs.map((blueprint) =>
		artifacts.create({
			id: ids.get(blueprint.ref),
			kind: "doc",
			title: blueprint.title,
			body: blueprint.body,
			subtype: blueprint.subtype,
			labels: withRunLabel(blueprint.labels, labelPrefix, runId),
			extra: { ...(blueprint.extra ?? {}), [extraKey]: { id: runId, ownerId, ref: blueprint.ref } },
		}),
	);
	const rules = rendered.blueprints.rules.map((blueprint) =>
		artifacts.create({
			id: ids.get(blueprint.ref),
			kind: "rule",
			title: blueprint.title,
			body: blueprint.body,
			labels: withRunLabel(blueprint.labels, labelPrefix, runId),
			extra: {
				...(blueprint.extra ?? {}),
				...(blueprint.condition ? { condition: blueprint.condition } : {}),
				...(blueprint.action ? { action: blueprint.action } : {}),
				...(blueprint.severity ? { severity: blueprint.severity } : {}),
				[extraKey]: { id: runId, ownerId, ref: blueprint.ref },
				scope: { type: labelPrefix, runId, taskIds },
			},
		}),
	);
	const tasks = rendered.blueprints.tasks.map((blueprint) => {
		const task = artifacts.create({
			id: ids.get(blueprint.ref),
			kind: "task",
			title: blueprint.title,
			body: blueprint.body,
			labels: withRunLabel(blueprint.labels, labelPrefix, runId),
			extra: { ...(blueprint.extra ?? {}), [extraKey]: { id: runId, ownerId, ref: blueprint.ref } },
		});
		if (history) {
			history.scopes.assign(task.id, projectRoot, projectRoot ? "cwd" : "unscoped");
			history.events.append({
				taskId: task.id,
				type: "created",
				actor: history.context?.actor ?? "system",
				source: history.context?.source ?? labelPrefix,
				toStatus: task.status as TaskStatus,
				...(history.context?.sessionId === undefined ? {} : { sessionId: history.context.sessionId }),
				...(history.context?.reason === undefined ? {} : { reason: history.context.reason }),
			});
		}
		return task;
	});

	// Nested pipeline steps run before edge-wiring: dependents need to know what tasks each
	// nested run actually produced. stepTaskIds/stepRootTaskIds map EVERY step ref (task or
	// call) to the task id(s) it resolves to, so dependsOn/parent wiring below treats both
	// kinds of step uniformly.
	const nestedRuns: WorkflowRunResult[] = [];
	const stepTaskIds = new Map<string, string[]>(tasks.map((task, index) => [rendered.blueprints.tasks[index]!.ref, [task.id]]));
	const stepRootTaskIds = new Map<string, string[]>(
		tasks.map((task, index) => [
			rendered.blueprints.tasks[index]!.ref,
			(rendered.blueprints.tasks[index]!.dependsOn?.length ?? 0) === 0 ? [task.id] : [],
		]),
	);
	// A call ref never gets its own real task -- it resolves to whatever the nested run's entry
	// (or, absent a resolvable one, its first root task) actually is. Lets a focusRef chain
	// straight through an arbitrary number of nested calls down to a real task, recursively.
	const stepEntryTaskIds = new Map<string, string>();
	for (const call of rendered.blueprints.skills as CallBlueprint[]) {
		const nested = runWorkflowSteps(
			artifacts,
			call.targetId,
			{ runId: `${runId}-${call.ref}`, arguments: call.arguments },
			history,
			ancestorSkillIds,
			depth + 1,
		);
		nestedRuns.push(nested);
		stepTaskIds.set(call.ref, nested.created.tasks);
		stepRootTaskIds.set(call.ref, nested.rootTaskIds);
		const entry = nested.entryTaskId ?? nested.rootTaskIds[0];
		if (entry !== undefined) stepEntryTaskIds.set(call.ref, entry);
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
	for (const call of rendered.blueprints.skills as CallBlueprint[]) {
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
		...(rendered.blueprints.skills as CallBlueprint[])
			.filter((call) => (call.dependsOn?.length ?? 0) === 0)
			.flatMap((call) => stepRootTaskIds.get(call.ref) ?? []),
	];
	for (const task of rendered.blueprints.tasks) {
		if ((task.dependsOn?.length ?? 0) === 0) artifacts.link({ from: ownerId, relation: "triggers", to: ids.get(task.ref)! });
	}
	for (const call of rendered.blueprints.skills as CallBlueprint[]) {
		if ((call.dependsOn?.length ?? 0) === 0) artifacts.link({ from: ownerId, relation: "triggers", to: call.targetId });
	}

	// A focusRef naming an ordinary task ref resolves directly through ids; one naming a call
	// ref resolves through the nested run it triggered instead (never through ids, which only
	// maps a call ref to a synthetic placeholder that was never actually created).
	const focusTaskId =
		input.focusRef === undefined
			? undefined
			: rendered.blueprints.tasks.some((task) => task.ref === input.focusRef)
				? ids.get(input.focusRef)
				: stepEntryTaskIds.get(input.focusRef);

	return {
		skillId: ownerId,
		runId,
		arguments: arguments_,
		created: {
			docs: [...docs.map(({ id }) => id), ...nestedRuns.flatMap((run) => run.created.docs)],
			rules: [...rules.map(({ id }) => id), ...nestedRuns.flatMap((run) => run.created.rules)],
			tasks: [...tasks.map(({ id }) => id), ...nestedRuns.flatMap((run) => run.created.tasks)],
			skillRuns: [...nestedRuns.map((run) => run.runId), ...nestedRuns.flatMap((run) => run.created.skillRuns)],
		},
		rootTaskIds,
		...(focusTaskId !== undefined ? { entryTaskId: focusTaskId } : {}),
		execution: projectTaskExecution(executionGraph(tasks, rendered, ids, extraKey)),
	};
}
