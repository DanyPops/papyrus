/**
 * playbook-definition.ts — compiles a Playbook's own steps/trigger/tools/arguments, plus its
 * `contains` (nested) and `depends_on` (prerequisite) composition tree, into an in-memory
 * SkillDefinition. This is the "recycle Papyrus Skills -> Playbooks" half of the redesign:
 * rather than a second graph-materialization engine, a Playbook becomes prose that compiles
 * down to the exact blueprint shape workflow Skills already use, then hands off to
 * workflow-execution.ts's shared materializeWorkflowDefinition for the actual Task creation.
 *
 * One task blueprint per playbook-node root (a container, never itself gated) plus one per
 * step (chained by sequential dependsOn); `contains`-linked playbooks nest their own root
 * under the parent root and continue the parent's own step chain ("run as part of this one",
 * after the parent's own steps); `depends_on`-linked playbooks compile as independent
 * subtrees whose tails gate this node's first step ("complete this FIRST"). No SkillCallBlueprint
 * indirection is used -- everything is inlined into one flat definition, since a Playbook's
 * composition tree is fully known and owned at compile time, unlike a workflow Skill's nested
 * pipeline step (which references another SKILL by id, resolved and executed independently).
 */
import {
	PLAYBOOK_INVOCATION_MAX_CALL_DEPTH,
	PLAYBOOK_INVOCATION_MAX_CREATED_TASKS,
	PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS,
} from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import type { SkillDefinition, SkillInputDefinition, SkillTaskBlueprint } from "./domain/skill-definition.ts";
import { validateSkillDefinition } from "./domain/skill-definition.ts";
import type { PlaybookArgument } from "./domain-services.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";

/** A non-composing edge touching a playbook node, to be mirrored onto that node's generated root task once real task ids exist -- e.g. a Rule `gates` this playbook, or this playbook `references`/`documents` a Doc. Direction is preserved exactly: `from`/`to` name whichever side is NOT the playbook, and `ownerIsFrom` says which side the playbook (now the generated root task) occupies. */
export interface PlaybookExternalLink {
	rootRef: string;
	relation: string;
	otherArtifactId: string;
	/** true: playbook (root task) is the edge's `from`; false: playbook (root task) is the edge's `to`. */
	ownerIsFrom: boolean;
}

export interface CompiledPlaybook {
	definition: SkillDefinition;
	/** The very first real leaf task in the whole tree's reading order -- what a caller should focus once materialized. */
	entryRef: string;
	externalLinks: PlaybookExternalLink[];
}

/** Trashed but not yet purged: artifacts.get() still returns it (trash is separate, orthogonal metadata -- "still directly showable"), so a stale composition edge left behind by remove/uncontain would otherwise resolve straight through and get compiled in. query() excludes trashed artifacts by default; use that instead of get() for every existence check a compiler makes. */
function nonTrashedPlaybookIds(artifacts: ArtifactStore, ids: string[]): Set<string> {
	if (ids.length === 0) return new Set();
	return new Set(artifacts.query({ ids, kind: "playbook" }).map((artifact) => artifact.id));
}

function requirePlaybook(artifacts: ArtifactStore, id: string): Artifact {
	const playbook = artifacts.get(id);
	if (!playbook) throw new Error(`playbook artifact "${id}" not found`);
	if (playbook.kind !== "playbook") throw new Error(`artifact "${id}" is not a playbook`);
	if (!nonTrashedPlaybookIds(artifacts, [id]).has(id)) throw new Error(`playbook artifact "${id}" is trashed`);
	return playbook;
}

function stepsOf(playbook: Artifact): string[] {
	return Array.isArray(playbook.extra["steps"]) ? playbook.extra["steps"].filter((step): step is string => typeof step === "string") : [];
}

function toolsOf(playbook: Artifact): string[] {
	return Array.isArray(playbook.extra["tools"]) ? playbook.extra["tools"].filter((tool): tool is string => typeof tool === "string") : [];
}

function argumentsOf(playbook: Artifact): PlaybookArgument[] {
	return Array.isArray(playbook.extra["arguments"]) ? (playbook.extra["arguments"] as PlaybookArgument[]) : [];
}

/** The generated container task's own body -- purpose and context only. Steps are separate child tasks, so they are not re-listed here (that was the old text-dump shape). */
function rootTaskBody(playbook: Artifact): string {
	const trigger = typeof playbook.extra["trigger"] === "string" ? playbook.extra["trigger"] : "manual invocation";
	const tools = toolsOf(playbook);
	return [
		`Playbook "${playbook.title}".`,
		`Trigger: ${trigger}`,
		...(playbook.body ? [`Context: ${playbook.body}`] : []),
		...(tools.length > 0 ? [`Tools: ${tools.join(", ")}`] : []),
		"This task contains its steps as child tasks -- work through them in order as each becomes focused.",
	].join("\n");
}

function stepTitle(step: string): string {
	const firstLine = step.split("\n")[0]!.trim();
	return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

interface CompileContext {
	tasks: SkillTaskBlueprint[];
	inputs: Record<string, SkillInputDefinition>;
	externalLinks: PlaybookExternalLink[];
	refCounter: { n: number };
}

interface CompileNodeResult {
	rootRef: string;
	/** First real leaf in this subtree's own reading order -- rootRef itself when the node has neither steps nor nested children. */
	headRef: string;
	/** Last real leaf in this subtree's own reading order -- what an enclosing "nested-after" continuation or successor prerequisite gate should depend on. */
	tailRef: string;
}

function mergeArgument(inputs: Record<string, SkillInputDefinition>, argument: PlaybookArgument): void {
	const existing = inputs[argument.name];
	inputs[argument.name] = { type: "string", required: (existing?.required ?? false) || argument.required };
}

function compileNode(
	artifacts: ArtifactStore,
	playbookId: string,
	ctx: CompileContext,
	ancestorIds: ReadonlySet<string>,
	depth: number,
	parentRef: string | undefined,
	incomingPrecedingRefs: string[],
): CompileNodeResult {
	if (ancestorIds.has(playbookId)) throw new Error(`playbook composition cycle includes "${playbookId}"`);
	if (depth > PLAYBOOK_INVOCATION_MAX_CALL_DEPTH) throw new Error(`playbook composition exceeds ${PLAYBOOK_INVOCATION_MAX_CALL_DEPTH} levels`);
	const nextAncestors = new Set([...ancestorIds, playbookId]);

	const playbook = requirePlaybook(artifacts, playbookId);
	for (const argument of argumentsOf(playbook)) mergeArgument(ctx.inputs, argument);

	const rootRef = `pb${ctx.refCounter.n++}`;
	const rootBlueprint: SkillTaskBlueprint = { ref: rootRef, title: playbook.title, body: rootTaskBody(playbook), ...(parentRef ? { parent: parentRef } : {}) };
	ctx.tasks.push(rootBlueprint);
	if (ctx.tasks.length > PLAYBOOK_INVOCATION_MAX_CREATED_TASKS) throw new Error(`playbook invocation exceeds ${PLAYBOOK_INVOCATION_MAX_CREATED_TASKS} tasks`);

	const edges = artifacts.relationships({ artifactIds: [playbookId] }).slice(0, PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS);
	const composablePlaybookIds = nonTrashedPlaybookIds(artifacts, edges.filter((edge) => edge.from === playbookId).map((edge) => edge.to));
	const prerequisiteIds = edges.filter((edge) => edge.from === playbookId && edge.relation === "depends_on").map((edge) => edge.to)
		.filter((id) => composablePlaybookIds.has(id));
	const nestedIds = edges.filter((edge) => edge.from === playbookId && edge.relation === "contains").map((edge) => edge.to)
		.filter((id) => composablePlaybookIds.has(id));
	for (const edge of edges) {
		const isComposingFrom = edge.from === playbookId && (edge.relation === "contains" || edge.relation === "depends_on") && composablePlaybookIds.has(edge.to);
		if (isComposingFrom) continue;
		if (edge.from === playbookId) ctx.externalLinks.push({ rootRef, relation: edge.relation, otherArtifactId: edge.to, ownerIsFrom: true });
		else if (edge.to === playbookId) ctx.externalLinks.push({ rootRef, relation: edge.relation, otherArtifactId: edge.from, ownerIsFrom: false });
	}

	const prerequisiteTailRefs: string[] = [];
	let headRef: string | undefined;
	for (const prerequisiteId of prerequisiteIds) {
		const result = compileNode(artifacts, prerequisiteId, ctx, nextAncestors, depth + 1, undefined, []);
		prerequisiteTailRefs.push(result.tailRef);
		if (headRef === undefined) headRef = result.headRef;
	}

	let cursorPrecedingRefs = [...incomingPrecedingRefs, ...prerequisiteTailRefs];
	let tailRef = rootRef;
	for (const [index, step] of stepsOf(playbook).entries()) {
		const stepRef = `${rootRef}-s${index}`;
		ctx.tasks.push({ ref: stepRef, title: stepTitle(step), body: step, parent: rootRef, dependsOn: cursorPrecedingRefs });
		if (ctx.tasks.length > PLAYBOOK_INVOCATION_MAX_CREATED_TASKS) throw new Error(`playbook invocation exceeds ${PLAYBOOK_INVOCATION_MAX_CREATED_TASKS} tasks`);
		if (headRef === undefined) headRef = stepRef;
		cursorPrecedingRefs = [stepRef];
		tailRef = stepRef;
	}

	for (const nestedId of nestedIds) {
		const result = compileNode(artifacts, nestedId, ctx, nextAncestors, depth + 1, rootRef, cursorPrecedingRefs);
		if (headRef === undefined) headRef = result.headRef;
		cursorPrecedingRefs = [result.tailRef];
		tailRef = result.tailRef;
	}

	if (tailRef === rootRef && cursorPrecedingRefs.length > 0) rootBlueprint.dependsOn = cursorPrecedingRefs;
	return { rootRef, headRef: headRef ?? rootRef, tailRef };
}

/** Pure and read-only: creates no artifacts. Cycle/depth-bounded exactly like playbookInvocation's own traversal, but a composition cycle here is a hard error (real Tasks would be created, unlike a text render degrading to a marker). */
export function compilePlaybookDefinition(artifacts: ArtifactStore, playbookId: string): CompiledPlaybook {
	const ctx: CompileContext = { tasks: [], inputs: {}, externalLinks: [], refCounter: { n: 0 } };
	const { headRef } = compileNode(artifacts, playbookId, ctx, new Set(), 0, undefined, []);
	const definition = validateSkillDefinition({
		version: 1,
		inputs: ctx.inputs,
		blueprints: { docs: [], rules: [], tasks: ctx.tasks, skills: [] },
		links: [],
	});
	return { definition, entryRef: headRef, externalLinks: ctx.externalLinks };
}
