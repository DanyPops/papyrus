/**
 * Playbook domain composition logic (create/list/show/update/transition/contain/depend/invoke),
 * split out of the former domain-services.ts into its own per-domain file alongside
 * docs/docs-service.ts and rules/rules-service.ts. Shared, kind-agnostic helpers live in
 * ../domain-service-shared.ts. Distinct from playbook-definition.ts/playbook-execution.ts in
 * this same directory, which compile/invoke a Playbook via the shared blueprint engine.
 *
 * Playbooks: a trigger and an ordered list of steps -- authored as prose. But playbooks.invoke
 * (playbook-execution.ts) recycles the shared blueprint materialization engine: it compiles a
 * Playbook into a BlueprintDefinition and mechanically instantiates real Tasks from it.
 * `playbookInvocation` below is the OTHER, older
 * path -- rendered text with no side effects, now exposed as the `preview` action for a human
 * who wants to just read a playbook before invoking it, not the primary way of running one.
 * Like Tasks, a Playbook can be nested or chained with another Playbook: `contains`/`part_of`
 * (containPlaybook/uncontainPlaybook) nests a sub-playbook inside a parent -- both preview and
 * invoke run the nested one's own steps as part of the parent, invoke as real dependsOn-chained
 * Tasks, preview as embedded text. `depends_on` (dependPlaybook/undependPlaybook) chains one
 * playbook before another -- the prerequisite's steps run first, either as real Tasks the
 * dependent's first step depends_on (invoke) or as embedded text rendered first (preview).
 * Composition is bounded in both paths; preview degrades a cycle to a text marker at render
 * time, while invoke's compiler (playbook-definition.ts) treats a cycle as a hard error --
 * real Tasks would otherwise be created in an infinite loop, unlike text rendering.
 */

import type { Artifact } from "../artifact/artifact.ts";
import { requireLocallyOwnedContent } from "../artifact/artifact.ts";
import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { ArtifactScope, ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import {
	ARTIFACT_TITLE_MAX_LENGTH,
	PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH,
	PLAYBOOK_ARGUMENT_MAX_COUNT,
	PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH,
	PLAYBOOK_INVOCATION_MAX_CALL_DEPTH,
	PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS,
	PLAYBOOK_MAX_STEPS,
	SKILL_MAX_ENUM_VALUES,
} from "../constants.ts";
import {
	addArtifactScopeGroup,
	addArtifactScopeProject,
	assertBodyBounds,
	assertLabelsBounds,
	assertTitleBounds,
	assignArtifactProject,
	type ListFilter,
	listScoped,
	removeArtifactScopeGroup,
	removeArtifactScopeProject,
	replaceArtifactScopeGroups,
	replaceArtifactScopeProjects,
	requireKind,
	runTransition,
	setArtifactScopeNone,
	type TransitionTable,
	type UpdateContentInput,
} from "../domain-service-shared.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import { normalizeProjectRoot } from "../project-registry/scope-source.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import {
	BLUEPRINT_INPUT_TYPES,
	type BlueprintArgumentValue,
	type BlueprintInputType,
	validateArgumentValue,
} from "./blueprint-definition.ts";

export interface PlaybookArgument {
	name: string;
	description?: string;
	/** Defaults true: naming an argument at all is a signal it matters, so an author must opt out explicitly to make one optional. */
	required: boolean;
	/** Defaults "string" (unchanged behavior for every argument declared before typed arguments existed). Validated the exact same way a workflow-definition target's own BlueprintInputDefinition is (domain/blueprint-definition.ts), not re-derived here. */
	type: BlueprintInputType;
	enum?: BlueprintArgumentValue[];
	default?: BlueprintArgumentValue;
}

/** Rejects malformed input rather than silently dropping a bad entry -- the same posture creation validation already takes everywhere else. */
function validatePlaybookArguments(value: unknown): PlaybookArgument[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("playbook arguments must be an array");
	if (value.length > PLAYBOOK_ARGUMENT_MAX_COUNT)
		throw new Error(`playbook arguments cannot exceed ${PLAYBOOK_ARGUMENT_MAX_COUNT} entries`);
	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			throw new Error(`argument at index ${index} must be an object`);
		const record = entry as Record<string, unknown>;
		const name = record.name;
		if (typeof name !== "string" || name.trim().length === 0 || name.length > PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH) {
			throw new Error(`argument name must be between 1 and ${PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH} characters`);
		}
		if (seen.has(name)) throw new Error(`argument name "${name}" is declared more than once`);
		seen.add(name);
		const description = record.description;
		if (description !== undefined && (typeof description !== "string" || description.length > PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH)) {
			throw new Error(`argument "${name}" description cannot exceed ${PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH} characters`);
		}
		const required = record.required;
		if (required !== undefined && typeof required !== "boolean") throw new Error(`argument "${name}" required must be a boolean`);
		const type = record.type === undefined ? "string" : record.type;
		if (!BLUEPRINT_INPUT_TYPES.has(type as BlueprintInputType)) throw new Error(`argument "${name}" has unsupported type`);
		const result: PlaybookArgument = { name, required: required !== false, type: type as BlueprintInputType };
		if (description !== undefined) result.description = description as string;
		if (record.default !== undefined) result.default = validateArgumentValue(name, result.type, record.default);
		if (record.enum !== undefined) {
			const values = record.enum;
			if (!Array.isArray(values) || values.length === 0 || values.length > SKILL_MAX_ENUM_VALUES) {
				throw new Error(`argument "${name}" enum must contain 1-${SKILL_MAX_ENUM_VALUES} values`);
			}
			result.enum = values.map((entry_) => validateArgumentValue(name, result.type, entry_));
			if (result.default !== undefined && !result.enum.includes(result.default)) {
				throw new Error(`argument "${name}" default must be one of its enum values`);
			}
		}
		return result;
	});
}

/** A plain string step is an ordinary prose task -- unchanged since Playbooks first existed. A structured step declares one of the other three Blueprint kinds (domain/blueprint-definition.ts): a Doc, a Rule, or a nested pipeline call into another Playbook (or a workflow-definition target). No `ref` field -- refs are compiler-assigned (playbook-definition.ts); a Playbook author never sees them, keeping the common case exactly as prose-simple as a plain string. */
export type PlaybookStep =
	| string
	| { kind: "task"; title?: string; body: string }
	| { kind: "doc"; title: string; body?: string; subtype?: string; labels?: string[] }
	| {
			kind: "rule";
			title: string;
			body?: string;
			condition?: string;
			action?: string;
			severity?: "block" | "warn" | "info";
			labels?: string[];
	  }
	| { kind: "call"; title: string; playbookId: string; arguments?: Record<string, unknown> };

function validateStructuredStep(value: Record<string, unknown>, index: number): PlaybookStep {
	const kind = value.kind;
	const title = value.title;
	if (kind === "task") {
		const body = value.body;
		if (typeof body !== "string" || body.trim().length === 0) throw new Error(`step ${index} (task) requires a non-empty body`);
		return { kind: "task", body, ...(typeof title === "string" && title.length > 0 ? { title } : {}) };
	}
	if (typeof title !== "string" || title.trim().length === 0 || title.length > ARTIFACT_TITLE_MAX_LENGTH) {
		throw new Error(`step ${index} (${String(kind)}) requires a title between 1 and ${ARTIFACT_TITLE_MAX_LENGTH} characters`);
	}
	if (kind === "doc" || kind === "rule") {
		const body = value.body;
		if (body !== undefined && typeof body !== "string") throw new Error(`step ${index} (${kind}) body must be a string`);
		const labels = value.labels;
		if (labels !== undefined && (!Array.isArray(labels) || labels.some((label) => typeof label !== "string"))) {
			throw new Error(`step ${index} (${kind}) labels must be a string array`);
		}
		if (kind === "doc") {
			const subtype = value.subtype;
			if (subtype !== undefined && typeof subtype !== "string") throw new Error(`step ${index} (doc) subtype must be a string`);
			return {
				kind: "doc",
				title,
				...(body !== undefined ? { body: body as string } : {}),
				...(subtype !== undefined ? { subtype: subtype as string } : {}),
				...(labels !== undefined ? { labels: labels as string[] } : {}),
			};
		}
		const condition = value.condition;
		const action = value.action;
		const severity = value.severity;
		if (condition !== undefined && typeof condition !== "string") throw new Error(`step ${index} (rule) condition must be a string`);
		if (action !== undefined && typeof action !== "string") throw new Error(`step ${index} (rule) action must be a string`);
		if (severity !== undefined && severity !== "block" && severity !== "warn" && severity !== "info") {
			throw new Error(`step ${index} (rule) severity must be block, warn, or info`);
		}
		return {
			kind: "rule",
			title,
			...(body !== undefined ? { body: body as string } : {}),
			...(condition !== undefined ? { condition: condition as string } : {}),
			...(action !== undefined ? { action: action as string } : {}),
			...(severity !== undefined ? { severity: severity as "block" | "warn" | "info" } : {}),
			...(labels !== undefined ? { labels: labels as string[] } : {}),
		};
	}
	if (kind === "call") {
		const playbookId = value.playbookId;
		if (typeof playbookId !== "string" || playbookId.trim().length === 0) throw new Error(`step ${index} (call) requires a playbookId`);
		const callArguments = value.arguments;
		if (callArguments !== undefined && (typeof callArguments !== "object" || callArguments === null || Array.isArray(callArguments))) {
			throw new Error(`step ${index} (call) arguments must be an object`);
		}
		return {
			kind: "call",
			title,
			playbookId,
			...(callArguments !== undefined ? { arguments: callArguments as Record<string, unknown> } : {}),
		};
	}
	throw new Error(`step ${index} has unknown kind "${String(kind)}"`);
}

/** A plain string passes through unchanged (the entire authoring surface before this extension); an object is validated against one of the three structured step kinds. Rejects malformed input rather than silently dropping it, matching validatePlaybookArguments' own posture. */
function validatePlaybookSteps(value: unknown): PlaybookStep[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("playbook steps must be an array");
	if (value.length > PLAYBOOK_MAX_STEPS) throw new Error(`playbook steps cannot exceed ${PLAYBOOK_MAX_STEPS} entries`);
	return value.map((entry, index) => {
		if (typeof entry === "string") {
			if (entry.trim().length === 0) throw new Error(`step ${index} must not be empty`);
			return entry;
		}
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			throw new Error(`step ${index} must be a string or a structured step object`);
		return validateStructuredStep(entry as Record<string, unknown>, index);
	});
}

export interface CreatePlaybookInput {
	title: string;
	body?: string;
	trigger?: string;
	steps?: unknown;
	tools?: string[];
	/** Declares named arguments this Playbook needs -- see playbookInvocation for how a missing required one surfaces. */
	arguments?: unknown;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	templateId?: string;
	projectRoot?: string;
	/** Bounded exact registered project references (id/name/alias/root) -- fail-closed unlike projectRoot's auto-register-by-root legacy form. Takes precedence over projectRoot when both are given. */
	projectReferences?: string[];
}

export type PlaybookTransition = "enable" | "disable";
/**
 * Extends the shared {title,body,labels} content-update shape with the two fields that make a
 * Playbook a Playbook -- steps and trigger -- previously settable only at creation. Before this,
 * revising either after creation had no supported path: the only workaround was create-new +
 * supersedes-link + disable-original, purely to fix a typo in one step or generalize a
 * project-specific Playbook for reuse. `steps` accepts the exact same shape playbooks.create
 * does (validated the same way, via validatePlaybookSteps) and REPLACES the Playbook's entire
 * step list when given, matching replace_projects' own "replace the whole thing" semantics
 * rather than a per-step edit -- Playbooks are typically short and hand-authored, so a full
 * replace is simpler to reason about than a step-index-addressed patch. */
export interface UpdatePlaybookInput extends UpdateContentInput {
	trigger?: string;
	steps?: unknown;
}

const PLAYBOOK_TRANSITIONS: TransitionTable<PlaybookTransition, string> = {
	enable: { from: ["deprecated"], to: "active" },
	disable: { from: ["active"], to: "deprecated" },
};

export function createPlaybook(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	input: CreatePlaybookInput,
	context?: ArtifactEventContext,
	registry?: ProjectRegistryStore,
): Artifact {
	if (input.projectReferences !== undefined && input.projectReferences.length > 0 && registry === undefined) {
		throw new Error("projectReferences requires a project registry");
	}
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const declaredArguments = validatePlaybookArguments(input.arguments);
	const declaredSteps = validatePlaybookSteps(input.steps);
	const playbook = artifacts.create(
		{
			kind: "playbook",
			status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
			title: input.title,
			body: input.body,
			subtype: input.subtype,
			labels: input.labels,
			extra: {
				...(input.extra ?? {}),
				...(input.trigger ? { trigger: input.trigger } : {}),
				...(declaredSteps ? { steps: declaredSteps } : {}),
				...(input.tools ? { tools: input.tools } : {}),
				...(declaredArguments ? { arguments: declaredArguments } : {}),
			},
			templateId: input.templateId,
		},
		context,
	);
	if (input.projectReferences !== undefined && input.projectReferences.length > 0) {
		replaceArtifactScopeProjects(scopes, registry!, playbook.id, input.projectReferences);
	} else {
		scopes.assign(playbook.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	}
	return playbook;
}

export function listPlaybooks(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "playbook", filter);
}

export function assignPlaybookProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	id: string,
	projectRoot: string | undefined,
): Artifact {
	return assignArtifactProject(artifacts, scopes, id, "playbook", projectRoot);
}

/**
 * The multi-project scope surface playbooks.assign_project cannot express -- mirrors
 * docs.ts's own docScope/setDocGlobal/addDocProject/removeDocProject/replaceDocProjects (which
 * itself mirrors rules.ts's original). id is resolved through requireKind so these reject the
 * same way against a non-Playbook or unknown id as every other playbooks.* mutation; the
 * project REFERENCE (name/alias/root) is resolved through the shared registry's
 * resolveProjectReference, so an unknown or ambiguous project fails closed with bounded
 * candidates rather than silently creating a new registration.
 */
export function playbookScope(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return scopes.scope(id);
}

export function setPlaybookGlobal(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return scopes.setAll(id, "explicit");
}

/** Fully hides this Playbook -- never applicable, never injected via before_agent_start, regardless of project. */
export function setPlaybookNone(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return setArtifactScopeNone(scopes, id);
}

export function replacePlaybookProjects(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReferences: readonly string[],
): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return replaceArtifactScopeProjects(scopes, registry, id, projectReferences);
}

export function addPlaybookProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return addArtifactScopeProject(scopes, registry, id, projectReference);
}

export function removePlaybookProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return removeArtifactScopeProject(scopes, registry, id, projectReference);
}

/** Scope-group ('nested scope') siblings of replacePlaybookProjects/addPlaybookProject/removePlaybookProject. */
export function replacePlaybookGroups(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReferences: readonly string[],
): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return replaceArtifactScopeGroups(scopes, scopeGroups, id, groupReferences);
}

export function addPlaybookGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return addArtifactScopeGroup(scopes, scopeGroups, id, groupReference);
}

export function removePlaybookGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "playbook");
	return removeArtifactScopeGroup(scopes, scopeGroups, id, groupReference);
}

export function showPlaybook(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "playbook");
	return artifacts.get(id, { tree: true })!;
}

export function updatePlaybook(artifacts: ArtifactStore, id: string, input: UpdatePlaybookInput, context?: ArtifactEventContext): Artifact {
	if (
		input.title === undefined &&
		input.body === undefined &&
		input.labels === undefined &&
		input.trigger === undefined &&
		input.steps === undefined
	) {
		throw new Error("update requires title, body, labels, trigger, or steps");
	}
	assertTitleBounds(input.title);
	assertBodyBounds(input.body);
	assertLabelsBounds(input.labels);
	// Validated the same way create does, BEFORE any write -- an invalid steps array must never
	// partially apply a title/body/labels change alongside a rejected steps change.
	const declaredSteps = validatePlaybookSteps(input.steps);
	const playbook = requireLocallyOwnedContent(requireKind(artifacts, id, "playbook"));
	const hasContentFields = input.title !== undefined || input.body !== undefined || input.labels !== undefined;
	const updated = hasContentFields ? artifacts.updateContent(playbook.id, input, context) : playbook;
	if (!updated) throw new Error(`playbook "${id}" not found`);
	if (declaredSteps === undefined && input.trigger === undefined) return updated;
	const withExtra = artifacts.setExtra(
		updated.id,
		{
			...updated.extra,
			...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
			...(declaredSteps !== undefined ? { steps: declaredSteps } : {}),
		},
		context,
	);
	if (!withExtra) throw new Error(`playbook "${id}" not found`);
	return withExtra;
}

export function transitionPlaybook(
	artifacts: ArtifactStore,
	id: string,
	action: PlaybookTransition,
	context?: ArtifactEventContext,
): Artifact {
	const playbook = requireLocallyOwnedContent(requireKind(artifacts, id, "playbook"));
	return runTransition(artifacts, playbook, "playbook", action, PLAYBOOK_TRANSITIONS, context);
}

/** Idempotent (INSERT OR IGNORE at the storage layer): containing an already-nested child is a no-op, not an error. Both contains/part_of edges are written atomically -- matches tasks.contain's own shape. */
export function containPlaybook(artifacts: ArtifactStore, parentId: string, childId: string, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireKind(artifacts, parentId, "playbook"));
	requireLocallyOwnedContent(requireKind(artifacts, childId, "playbook"));
	if (parentId === childId) throw new Error(`playbook "${parentId}" cannot contain itself`);
	artifacts.link({ from: parentId, relation: "contains", to: childId }, context);
	artifacts.link({ from: childId, relation: "part_of", to: parentId }, context);
	return showPlaybook(artifacts, parentId);
}

/** Idempotent: uncontaining an already-absent nesting is a no-op. Both contains/part_of edges are removed atomically. */
export function uncontainPlaybook(artifacts: ArtifactStore, parentId: string, childId: string, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireKind(artifacts, parentId, "playbook"));
	requireLocallyOwnedContent(requireKind(artifacts, childId, "playbook"));
	artifacts.unlink({ from: parentId, relation: "contains", to: childId }, context);
	artifacts.unlink({ from: childId, relation: "part_of", to: parentId }, context);
	return showPlaybook(artifacts, parentId);
}

/** Idempotent: depending on an already-declared prerequisite is a no-op, not an error. Unlike tasks.depend, this never rejects a cycle at write time -- playbookInvocation degrades a composition cycle to a marker at render time instead, the same posture already established for Skill-calls-Skill and Playbook-calls-Playbook via `contains`. */
export function dependPlaybook(artifacts: ArtifactStore, id: string, dependencyId: string, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireKind(artifacts, id, "playbook"));
	requireLocallyOwnedContent(requireKind(artifacts, dependencyId, "playbook"));
	if (id === dependencyId) throw new Error(`playbook "${id}" cannot depend on itself`);
	artifacts.link({ from: id, relation: "depends_on", to: dependencyId }, context);
	return showPlaybook(artifacts, id);
}

/** Idempotent: undepending an already-absent prerequisite is a no-op. */
export function undependPlaybook(artifacts: ArtifactStore, id: string, dependencyId: string, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireKind(artifacts, id, "playbook"));
	requireLocallyOwnedContent(requireKind(artifacts, dependencyId, "playbook"));
	artifacts.unlink({ from: id, relation: "depends_on", to: dependencyId }, context);
	return showPlaybook(artifacts, id);
}

/** Text rendering for one preview step, covering all four Blueprint kinds -- distinct from playbook-definition.ts's stepTitle (a compiled Task's title), since a preview is read by a human/agent deciding whether to invoke, not turned into a real artifact. */
function stepText(step: PlaybookStep, index: number): string {
	if (typeof step === "string") return `${index + 1}. ${step}`;
	if (step.kind === "task") return `${index + 1}. ${step.title ? `${step.title} -- ` : ""}${step.body}`;
	if (step.kind === "doc") return `${index + 1}. [creates Doc] "${step.title}"${step.subtype ? ` (${step.subtype})` : ""}`;
	if (step.kind === "rule") return `${index + 1}. [creates Rule] "${step.title}"${step.condition ? ` -- when: ${step.condition}` : ""}`;
	return `${index + 1}. [calls playbook] "${step.title}" -> ${step.playbookId}`;
}

function argumentQualifier(argument: PlaybookArgument): string {
	const qualifier = argument.required ? "required" : "optional";
	const type = argument.type === "string" ? "" : `, ${argument.type}`;
	const options = argument.enum ? `, one of: ${argument.enum.join(", ")}` : "";
	return `${qualifier}${type}${options}`;
}

/** Renders trigger/body/arguments/steps/tools into readable guidance -- the flat, non-recursive part of a Playbook's own invocation, shared by the top-level render and by a nested composed call. */
function playbookInvocationBody(playbook: Artifact, provided: Record<string, unknown>): string {
	const trigger = typeof playbook.extra.trigger === "string" ? playbook.extra.trigger : "manual invocation";
	const steps = Array.isArray(playbook.extra.steps) ? (playbook.extra.steps as PlaybookStep[]) : [];
	const tools = Array.isArray(playbook.extra.tools) ? playbook.extra.tools.filter((tool): tool is string => typeof tool === "string") : [];
	const declaredArguments = Array.isArray(playbook.extra.arguments) ? (playbook.extra.arguments as PlaybookArgument[]) : [];
	const argumentLines = declaredArguments.map((argument) => {
		const value = provided[argument.name];
		if (value !== undefined) return `- ${argument.name}: ${String(value)}`;
		return `- ${argument.name} (${argumentQualifier(argument)}${argument.description ? `: ${argument.description}` : ""}) -- not yet provided`;
	});
	const missingRequired = declaredArguments.filter(
		(argument) => argument.required && provided[argument.name] === undefined && argument.default === undefined,
	);
	return [
		`Apply Papyrus playbook "${playbook.title}".`,
		`Trigger: ${trigger}`,
		...(playbook.body ? [`Context: ${playbook.body}`] : []),
		...(argumentLines.length > 0 ? ["Arguments:", ...argumentLines] : []),
		...(missingRequired.length > 0
			? [
					`Missing required argument(s): ${missingRequired.map((argument) => argument.name).join(", ")}. Ask the human for these directly -- the discuss tool with live:true asks synchronously and gets a real answer in this same turn -- before proceeding with the steps below. Do not guess or invent a value.`,
				]
			: []),
		...(steps.length ? ["Steps:", ...steps.map((step, index) => stepText(step, index))] : []),
		...(tools.length ? [`Tools: ${tools.join(", ")}`] : []),
	].join("\n");
}

/**
 * Renders trigger/steps/tools/arguments into readable guidance, plus any real linked artifacts.
 * Two relations compose recursively, each with distinct wording matching Tasks' own semantics:
 * `contains` nests a child playbook -- its full steps render AFTER this playbook's own, as
 * "run as part of this one". `depends_on` chains a prerequisite -- its full steps render BEFORE
 * this playbook's own, as "complete this first". Every other relation (references, relates_to,
 * etc.) still gets the flat one-line "Linked context" pointer, unchanged. Bounded and
 * cycle-safe -- a composition cycle degrades to a marker instead of infinite-looping, the same
 * cycle-safety discipline task dependency graphs already established.
 * `provided` is the caller's already-known argument values (e.g. from the conversation so far);
 * any declared *required* argument missing from it is called out explicitly, directing the agent
 * to discuss (live:true) rather than guess or silently proceed. `visited` and `depth` are
 * recursion-internal; callers should not pass them.
 */
export function playbookInvocation(
	artifacts: ArtifactStore,
	id: string,
	provided: Record<string, unknown> = {},
	visited: Set<string> = new Set(),
	depth = 0,
): string {
	const playbook = requireKind(artifacts, id, "playbook");
	visited.add(id);

	const edges = artifacts
		.relationships({ artifactIds: [id] })
		.filter((edge) => edge.from === id)
		.slice(0, PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS);
	const linkedArtifactLines: string[] = [];
	const nestedSections: string[] = []; // contains -- rendered after this playbook's own body
	const prerequisiteSections: string[] = []; // depends_on -- rendered before this playbook's own body
	for (const edge of edges) {
		const target = artifacts.get(edge.to);
		if (!target) continue; // dangling edge -- defensive, should not happen
		const isComposing = target.kind === "playbook" && (edge.relation === "contains" || edge.relation === "depends_on");
		if (!isComposing) {
			linkedArtifactLines.push(`- ${edge.relation} ${target.kind} "${target.title}"`);
			continue;
		}
		const bucket = edge.relation === "contains" ? nestedSections : prerequisiteSections;
		const role = edge.relation === "contains" ? "nested" : "prerequisite";
		if (visited.has(target.id)) {
			bucket.push(
				`Also linked via ${edge.relation} to ${role} playbook "${target.title}" -- already invoked above in this chain, not repeated.`,
			);
		} else if (depth + 1 > PLAYBOOK_INVOCATION_MAX_CALL_DEPTH) {
			bucket.push(
				`Also linked via ${edge.relation} to ${role} playbook "${target.title}" -- call depth limit reached, invoke it separately.`,
			);
		} else {
			const nested = playbookInvocation(artifacts, target.id, provided, visited, depth + 1);
			bucket.push(
				edge.relation === "contains"
					? `Nested playbook (contains) "${target.title}" -- run as part of this one:\n${nested}`
					: `Prerequisite playbook (depends_on) "${target.title}" -- complete this FIRST, before the steps below:\n${nested}`,
			);
		}
	}

	const sections = [...prerequisiteSections, playbookInvocationBody(playbook, provided), ...nestedSections];
	if (linkedArtifactLines.length > 0) {
		sections.push(["Linked context (query Papyrus for full detail before proceeding):", ...linkedArtifactLines].join("\n"));
	}
	return sections.join("\n\n");
}
