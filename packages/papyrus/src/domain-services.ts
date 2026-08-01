import {
	ARTIFACT_BODY_MAX_LENGTH,
	ARTIFACT_LABEL_MAX_COUNT,
	ARTIFACT_LABEL_MAX_LENGTH,
	ARTIFACT_SCOPE_MAX_ARTIFACTS,
	ARTIFACT_TITLE_MAX_LENGTH,
	PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH,
	PLAYBOOK_ARGUMENT_MAX_COUNT,
	PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH,
	PLAYBOOK_INVOCATION_MAX_CALL_DEPTH,
	PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS,
	PLAYBOOK_MAX_STEPS,
	RULE_TEXT_HARD_LIMIT_CHARACTERS,
	SKILL_MAX_ENUM_VALUES,
} from "./constants.ts";
import { requireLocallyOwnedContent, type Artifact, type CreateArtifactInput } from "./domain/artifact.ts";
import type { ArtifactEventContext } from "./domain/artifact-event.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";
import {
	SKILL_INPUT_TYPES,
	validateArgumentValue,
	type SkillArgumentValue,
	type SkillInputType,
} from "./domain/skill-definition.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { ArtifactScopeStore } from "./ports/artifact-scope-store.ts";
import { NOTE_SUBTYPE } from "./note-service.ts";
import { type ArtifactAction, type AuthorityRegistry } from "./authority-registry.ts";

export interface UpdateContentInput {
	title?: string;
	body?: string;
	labels?: string[];
}

function requireContentUpdateFields(input: UpdateContentInput): void {
	if (input.title === undefined && input.body === undefined && input.labels === undefined) {
		throw new Error("update requires title, body, or labels");
	}
}

function assertTitleBounds(title: string | undefined): void {
	if (title !== undefined && (title.trim().length === 0 || title.length > ARTIFACT_TITLE_MAX_LENGTH)) {
		throw new Error(`title must be between 1 and ${ARTIFACT_TITLE_MAX_LENGTH} characters`);
	}
}

function assertBodyBounds(body: string | undefined): void {
	if (body !== undefined && body.length > ARTIFACT_BODY_MAX_LENGTH) throw new Error(`body cannot exceed ${ARTIFACT_BODY_MAX_LENGTH} characters`);
}

function assertLabelsBounds(labels: string[] | undefined): void {
	if (labels === undefined) return;
	if (labels.length > ARTIFACT_LABEL_MAX_COUNT) throw new Error(`labels cannot exceed ${ARTIFACT_LABEL_MAX_COUNT} entries`);
	if (labels.some((label) => label.length === 0 || label.length > ARTIFACT_LABEL_MAX_LENGTH)) {
		throw new Error(`each label must be between 1 and ${ARTIFACT_LABEL_MAX_LENGTH} characters`);
	}
}

export interface ListFilter {
	status?: string;
	text?: string;
	limit?: number;
	/** When supplied, results are limited to artifacts scoped to this project (or the unscoped bucket, for an empty string is not accepted -- use assignArtifactProject's own validation). */
	projectRoot?: string;
}

/**
 * Shared by listDocuments/listRules/listPlaybooks: when filter.projectRoot is given, resolve
 * via ArtifactScopeStore first and post-filter by kind/status/text (mirrors Tasks.list's
 * established scoped-listing shape); otherwise fall back to the existing unscoped query
 * path unchanged, so every caller that predates project scoping keeps working exactly as
 * before.
 */
function listScoped(artifacts: ArtifactStore, scopes: ArtifactScopeStore, kind: string, filter: ListFilter, excludeSubtype?: string): Artifact[] {
	if (filter.projectRoot === undefined) return artifacts.query({ kind, excludeSubtype, status: filter.status, text: filter.text, limit: filter.limit });
	const limit = filter.limit ?? ARTIFACT_SCOPE_MAX_ARTIFACTS;
	if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_SCOPE_MAX_ARTIFACTS) {
		throw new Error(`list limit must be between 1 and ${ARTIFACT_SCOPE_MAX_ARTIFACTS}`);
	}
	const projectRoot = normalizeProjectRoot(filter.projectRoot);
	const ids = scopes.ids(projectRoot, ARTIFACT_SCOPE_MAX_ARTIFACTS);
	const text = filter.text?.toLowerCase();
	return ids
		.map((id) => artifacts.get(id))
		.filter((artifact): artifact is Artifact => artifact?.kind === kind && artifact.subtype !== excludeSubtype)
		.filter((artifact) => filter.status === undefined || artifact.status === filter.status)
		.filter((artifact) => text === undefined || artifact.title.toLowerCase().includes(text) || artifact.body.toLowerCase().includes(text))
		.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
		.slice(0, limit);
}

/** Shared by assignDocumentProject/assignRuleProject/assignPlaybookProject. */
function assignArtifactProject(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string, kind: string, projectRoot: string | undefined): Artifact {
	requireKind(artifacts, id, kind);
	scopes.assign(id, projectRoot === undefined ? undefined : normalizeProjectRoot(projectRoot), projectRoot === undefined ? "unscoped" : "explicit");
	return artifacts.get(id)!;
}

function requireKind(artifacts: ArtifactStore, id: string, kind: string): Artifact {
	const artifact = artifacts.get(id);
	if (!artifact) throw new Error(`${kind} artifact "${id}" not found`);
	if (artifact.kind !== kind) throw new Error(`artifact "${id}" is not a ${kind}`);
	return artifact;
}

function rejectsNoteTemplate(artifacts: ArtifactStore, templateId: string | undefined, subtype: string | undefined): boolean {
	if (subtype === NOTE_SUBTYPE) return true;
	if (!templateId) return false;
	const template = artifacts.get(templateId);
	const defaults = template?.extra["defaults"];
	return typeof defaults === "object" && defaults !== null && !Array.isArray(defaults)
		&& (defaults as Record<string, unknown>)["subtype"] === NOTE_SUBTYPE;
}

/** caller never owns NOTE_SUBTYPE, so requireArtifactAllowed always throws — the trailing throw only satisfies TypeScript's control-flow analysis for a `never`-returning function. */
function requireNotesFacade(authority: AuthorityRegistry, caller: string): never {
	authority.requireArtifactAllowed("doc", NOTE_SUBTYPE, "create", caller);
	throw new Error("note creation requires notes.capture");
}

function templateSubtype(artifacts: ArtifactStore, templateId: string | undefined): string | undefined {
	if (!templateId) return undefined;
	const defaults = artifacts.get(templateId)?.extra["defaults"];
	if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return undefined;
	const subtype = (defaults as Record<string, unknown>)["subtype"];
	return typeof subtype === "string" ? subtype : undefined;
}

// No default action: linkDocument's own bug (both target and source checks silently defaulting to
// "status" here) was exactly what let a plain reference edge to a Task trip the tasks.* lifecycle
// guard, which is scoped to actual status changes only. Every call site now names its real action.
function requireMutableDocument(document: Artifact, authority: AuthorityRegistry, action: ArtifactAction): Artifact {
	authority.requireArtifactAllowed(document.kind, document.subtype, action, "docs");
	return document;
}

export interface CreateDocumentInput {
	title: string;
	body?: string;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	templateId?: string;
	/** Optional at creation, unlike Tasks -- omitting it leaves the Doc in the unscoped bucket, matching today's default behavior for every existing caller. */
	projectRoot?: string;
}

export type UpdateDocumentInput = UpdateContentInput;

export type DocumentTransition = "activate" | "archive" | "reopen";
export type DocumentRelation = "references" | "documents" | "supersedes" | "relates_to" | "contains" | "part_of";

const DOCUMENT_TRANSITIONS: Record<DocumentTransition, { from: string[]; to: string }> = {
	activate: { from: ["draft"], to: "active" },
	archive: { from: ["draft", "active"], to: "archived" },
	reopen: { from: ["archived"], to: "draft" },
};

export function createDocument(artifacts: ArtifactStore, scopes: ArtifactScopeStore, input: CreateDocumentInput, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	if (rejectsNoteTemplate(artifacts, input.templateId, input.subtype)) requireNotesFacade(authority, "docs");
	authority.requireArtifactAllowed("doc", input.subtype ?? templateSubtype(artifacts, input.templateId), "create", "docs");
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const document = artifacts.create({
		kind: "doc",
		// Explicit, not defaultStatusFor's "first status row by rowid" fallback -- the same
		// heuristic that made Task creation non-deterministic on a migrated database. Every
		// creation path that has no caller-supplied initial status must set one explicitly.
		status: "draft",
		title: input.title,
		body: input.body,
		subtype: input.subtype,
		labels: input.labels,
		extra: input.extra,
		templateId: input.templateId,
	}, context);
	scopes.assign(document.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	return document;
}

export function listDocuments(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "doc", filter, NOTE_SUBTYPE);
}

export function assignDocumentProject(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string, projectRoot: string | undefined): Artifact {
	requireDocument(artifacts, id); // rejects Notes -- project reassignment for notes goes through notes.* like everything else about them
	scopes.assign(id, projectRoot === undefined ? undefined : normalizeProjectRoot(projectRoot), projectRoot === undefined ? "unscoped" : "explicit");
	return artifacts.get(id)!;
}

function requireDocument(artifacts: ArtifactStore, id: string): Artifact {
	const document = requireKind(artifacts, id, "doc");
	if (document.subtype === NOTE_SUBTYPE) throw new Error("note access requires a notes.* operation");
	return document;
}

export function showDocument(artifacts: ArtifactStore, id: string): Artifact {
	requireDocument(artifacts, id);
	return artifacts.get(id, { tree: true })!;
}

export function transitionDocument(artifacts: ArtifactStore, id: string, action: DocumentTransition, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	const document = requireLocallyOwnedContent(requireMutableDocument(requireDocument(artifacts, id), authority, "status"));
	const transition = DOCUMENT_TRANSITIONS[action];
	if (!transition.from.includes(document.status)) throw new Error(`cannot ${action} document from ${document.status}`);
	return artifacts.setStatus(id, transition.to, context)!;
}

/**
 * Docs are immutable-by-convention only in the sense that no path existed to change them --
 * this is that path. A read-only external projection (see requireLocallyOwnedContent) still
 * refuses, on purpose: rewriting it here would silently fork from whatever system actually
 * owns it (e.g. web-spider's ingested pages), with nothing to ever reconcile the two again.
 */
export function updateDocument(artifacts: ArtifactStore, id: string, input: UpdateDocumentInput, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	requireContentUpdateFields(input);
	assertTitleBounds(input.title);
	assertBodyBounds(input.body);
	assertLabelsBounds(input.labels);
	const document = requireLocallyOwnedContent(requireMutableDocument(requireDocument(artifacts, id), authority, "update"));
	const updated = artifacts.updateContent(id, input, context);
	if (!updated) throw new Error(`document "${id}" not found`);
	return updated;
}

export function linkDocument(artifacts: ArtifactStore, id: string, relation: DocumentRelation, targetId: string, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireMutableDocument(requireDocument(artifacts, id), authority, "link"));
	const target = artifacts.get(targetId);
	if (!target) throw new Error(`target artifact "${targetId}" not found`);
	requireLocallyOwnedContent(requireMutableDocument(target, authority, "link"));
	artifacts.link({ from: id, relation, to: targetId }, context);
	return showDocument(artifacts, id);
}

export interface CreateRuleInput {
	title: string;
	body?: string;
	condition?: string;
	action?: string;
	severity?: "block" | "warn" | "info";
	labels?: string[];
	extra?: Record<string, unknown>;
	projectRoot?: string;
}

export type RuleTransition = "enable" | "disable";

/**
 * A Rule's condition+action+body is injected into every relevant turn for the rule's entire
 * lifetime -- a permanent tax on every future turn's context budget, not a one-time cost.
 * Rejects (rather than silently truncating or merely warning) once a rule is unambiguously
 * bloated, since a silently-truncated rule would inject different text than what its author
 * reviewed, and a warning nobody reads is not a bound. See RULE_TEXT_HARD_LIMIT_CHARACTERS's
 * own comment in constants.ts for the research this threshold is grounded in.
 */
function assertRuleTextWithinBounds(condition: string | undefined, action: string | undefined, body: string | undefined): void {
	const combined = (condition ?? "").length + (action ?? "").length + (body ?? "").length;
	if (combined > RULE_TEXT_HARD_LIMIT_CHARACTERS) {
		throw new Error(
			`rule condition+action+body is ${combined} characters, exceeding the ${RULE_TEXT_HARD_LIMIT_CHARACTERS}-character bound. ` +
				"A Rule is injected into every relevant turn for its entire lifetime -- this is a permanent context-budget tax, not a one-time cost. " +
				"Split it: keep a short Rule (the condition and the invariant itself), and move the full reasoning, examples, and research into a linked Doc.",
		);
	}
}

export function createRule(artifacts: ArtifactStore, scopes: ArtifactScopeStore, input: CreateRuleInput, context?: ArtifactEventContext): Artifact {
	assertRuleTextWithinBounds(input.condition, input.action, input.body);
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const rule = artifacts.create({
		kind: "rule",
		status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			...(input.extra ?? {}),
			...(input.condition ? { condition: input.condition } : {}),
			...(input.action ? { action: input.action } : {}),
			severity: input.severity ?? "info",
		},
	}, context);
	scopes.assign(rule.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	return rule;
}

export function listRules(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "rule", filter);
}

export function assignRuleProject(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string, projectRoot: string | undefined): Artifact {
	return assignArtifactProject(artifacts, scopes, id, "rule", projectRoot);
}

/**
 * Global rules always apply; scoped workflow-run rules apply only while their run owns active
 * focus. Both a workflow Skill's own run scope ("skill-run", written by workflow-execution.ts's
 * runWorkflowSteps for a top-level Skill target) and a Playbook's own run scope ("playbook-run",
 * same call for a Playbook target) are recognized -- confirmed live that only "skill-run" was
 * ever checked here, silently breaking Playbook-run-scoped rule injection since Playbook gained
 * its own doc/rule structured steps.
 */
export function listInjectableRules(artifacts: ArtifactStore, activeTaskId?: string): Artifact[] {
	return artifacts.query({ kind: "rule", status: "active" }).filter((rule) => {
		const scope = rule.extra["scope"];
		if (scope === undefined) return true;
		if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
		const value = scope as Record<string, unknown>;
		if ((value["type"] !== "skill-run" && value["type"] !== "playbook-run") || !Array.isArray(value["taskIds"])) return false;
		return activeTaskId !== undefined && value["taskIds"].some((id) => id === activeTaskId);
	});
}

export function showRule(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "rule");
	return artifacts.get(id, { tree: true })!;
}

export function previewRule(artifacts: ArtifactStore, id: string): string {
	const rule = requireKind(artifacts, id, "rule");
	const condition = typeof rule.extra["condition"] === "string" ? ` (when: ${rule.extra["condition"]})` : "";
	const action = rule.body || (typeof rule.extra["action"] === "string" ? rule.extra["action"] : "");
	return `• ${rule.title}${condition}\n  ${action}`;
}

export function transitionRule(artifacts: ArtifactStore, id: string, action: RuleTransition, context?: ArtifactEventContext): Artifact {
	const rule = requireLocallyOwnedContent(requireKind(artifacts, id, "rule"));
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (rule.status !== expected) throw new Error(`cannot ${action} rule from ${rule.status}`);
	return artifacts.setStatus(id, target, context)!;
}

export type UpdateRuleInput = UpdateContentInput;

/** A Rule's body update stays under the same combined condition+action+body ceiling as creation -- a permanent per-turn injection cost doesn't get looser just because it's an edit, not a create. */
export function updateRule(artifacts: ArtifactStore, id: string, input: UpdateRuleInput, context?: ArtifactEventContext): Artifact {
	requireContentUpdateFields(input);
	assertTitleBounds(input.title);
	assertLabelsBounds(input.labels);
	const rule = requireLocallyOwnedContent(requireKind(artifacts, id, "rule"));
	if (input.body !== undefined) {
		const condition = typeof rule.extra["condition"] === "string" ? rule.extra["condition"] : undefined;
		const action = typeof rule.extra["action"] === "string" ? rule.extra["action"] : undefined;
		assertRuleTextWithinBounds(condition, action, input.body);
	}
	const updated = artifacts.updateContent(id, input, context);
	if (!updated) throw new Error(`rule "${id}" not found`);
	return updated;
}

export function gateTaskWithRule(artifacts: ArtifactStore, ruleId: string, taskId: string, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireKind(artifacts, ruleId, "rule"));
	requireKind(artifacts, taskId, "task");
	artifacts.link({ from: ruleId, relation: "gates", to: taskId }, context);
	return showRule(artifacts, ruleId);
}

/**
 * Playbooks: a trigger and an ordered list of steps -- authored as prose, a completely
 * different beast from Skills at that level. But playbooks.invoke (playbook-execution.ts)
 * recycles the exact same materialization engine workflow Skills use: it compiles a Playbook
 * into a SkillDefinition and mechanically instantiates real Tasks from it, same as a Skill's
 * own artifact-template/workflow blueprint. `playbookInvocation` below is the OTHER, older
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
export interface PlaybookArgument {
	name: string;
	description?: string;
	/** Defaults true: naming an argument at all is a signal it matters, so an author must opt out explicitly to make one optional. */
	required: boolean;
	/** Defaults "string" (unchanged behavior for every argument declared before typed arguments existed). Validated the exact same way a workflow Skill's own SkillInputDefinition is (domain/skill-definition.ts), not re-derived here. */
	type: SkillInputType;
	enum?: SkillArgumentValue[];
	default?: SkillArgumentValue;
}

/** Rejects malformed input rather than silently dropping a bad entry -- the same posture creation validation already takes everywhere else. */
function validatePlaybookArguments(value: unknown): PlaybookArgument[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("playbook arguments must be an array");
	if (value.length > PLAYBOOK_ARGUMENT_MAX_COUNT) throw new Error(`playbook arguments cannot exceed ${PLAYBOOK_ARGUMENT_MAX_COUNT} entries`);
	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`argument at index ${index} must be an object`);
		const record = entry as Record<string, unknown>;
		const name = record["name"];
		if (typeof name !== "string" || name.trim().length === 0 || name.length > PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH) {
			throw new Error(`argument name must be between 1 and ${PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH} characters`);
		}
		if (seen.has(name)) throw new Error(`argument name "${name}" is declared more than once`);
		seen.add(name);
		const description = record["description"];
		if (description !== undefined && (typeof description !== "string" || description.length > PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH)) {
			throw new Error(`argument "${name}" description cannot exceed ${PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH} characters`);
		}
		const required = record["required"];
		if (required !== undefined && typeof required !== "boolean") throw new Error(`argument "${name}" required must be a boolean`);
		const type = record["type"] === undefined ? "string" : record["type"];
		if (!SKILL_INPUT_TYPES.has(type as SkillInputType)) throw new Error(`argument "${name}" has unsupported type`);
		const result: PlaybookArgument = { name, required: required !== false, type: type as SkillInputType };
		if (description !== undefined) result.description = description as string;
		if (record["default"] !== undefined) result.default = validateArgumentValue(name, result.type, record["default"]);
		if (record["enum"] !== undefined) {
			const values = record["enum"];
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

/** A plain string step is an ordinary prose task -- unchanged since Playbooks first existed. A structured step declares one of the other three Blueprint kinds a workflow Skill can already produce (domain/skill-definition.ts): a Doc, a Rule, or a nested pipeline call into another Playbook (or, until Skill retires, a workflow Skill). No `ref` field -- refs are compiler-assigned (playbook-definition.ts); a Playbook author never sees them, keeping the common case exactly as prose-simple as a plain string. */
export type PlaybookStep =
	| string
	| { kind: "task"; title?: string; body: string }
	| { kind: "doc"; title: string; body?: string; subtype?: string; labels?: string[] }
	| { kind: "rule"; title: string; body?: string; condition?: string; action?: string; severity?: "block" | "warn" | "info"; labels?: string[] }
	| { kind: "call"; title: string; playbookId: string; arguments?: Record<string, unknown> };

function validateStructuredStep(value: Record<string, unknown>, index: number): PlaybookStep {
	const kind = value["kind"];
	const title = value["title"];
	if (kind === "task") {
		const body = value["body"];
		if (typeof body !== "string" || body.trim().length === 0) throw new Error(`step ${index} (task) requires a non-empty body`);
		return { kind: "task", body, ...(typeof title === "string" && title.length > 0 ? { title } : {}) };
	}
	if (typeof title !== "string" || title.trim().length === 0 || title.length > ARTIFACT_TITLE_MAX_LENGTH) {
		throw new Error(`step ${index} (${String(kind)}) requires a title between 1 and ${ARTIFACT_TITLE_MAX_LENGTH} characters`);
	}
	if (kind === "doc" || kind === "rule") {
		const body = value["body"];
		if (body !== undefined && typeof body !== "string") throw new Error(`step ${index} (${kind}) body must be a string`);
		const labels = value["labels"];
		if (labels !== undefined && (!Array.isArray(labels) || labels.some((label) => typeof label !== "string"))) {
			throw new Error(`step ${index} (${kind}) labels must be a string array`);
		}
		if (kind === "doc") {
			const subtype = value["subtype"];
			if (subtype !== undefined && typeof subtype !== "string") throw new Error(`step ${index} (doc) subtype must be a string`);
			return { kind: "doc", title, ...(body !== undefined ? { body: body as string } : {}), ...(subtype !== undefined ? { subtype: subtype as string } : {}), ...(labels !== undefined ? { labels: labels as string[] } : {}) };
		}
		const condition = value["condition"];
		const action = value["action"];
		const severity = value["severity"];
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
		const playbookId = value["playbookId"];
		if (typeof playbookId !== "string" || playbookId.trim().length === 0) throw new Error(`step ${index} (call) requires a playbookId`);
		const callArguments = value["arguments"];
		if (callArguments !== undefined && (typeof callArguments !== "object" || callArguments === null || Array.isArray(callArguments))) {
			throw new Error(`step ${index} (call) arguments must be an object`);
		}
		return { kind: "call", title, playbookId, ...(callArguments !== undefined ? { arguments: callArguments as Record<string, unknown> } : {}) };
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
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`step ${index} must be a string or a structured step object`);
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
	labels?: string[];
	extra?: Record<string, unknown>;
	projectRoot?: string;
}

export type PlaybookTransition = "enable" | "disable";
export type UpdatePlaybookInput = UpdateContentInput;

export function createPlaybook(artifacts: ArtifactStore, scopes: ArtifactScopeStore, input: CreatePlaybookInput, context?: ArtifactEventContext): Artifact {
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const declaredArguments = validatePlaybookArguments(input.arguments);
	const declaredSteps = validatePlaybookSteps(input.steps);
	const playbook = artifacts.create({
		kind: "playbook",
		status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			...(input.extra ?? {}),
			...(input.trigger ? { trigger: input.trigger } : {}),
			...(declaredSteps ? { steps: declaredSteps } : {}),
			...(input.tools ? { tools: input.tools } : {}),
			...(declaredArguments ? { arguments: declaredArguments } : {}),
		},
	}, context);
	scopes.assign(playbook.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	return playbook;
}

export function listPlaybooks(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "playbook", filter);
}

export function assignPlaybookProject(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string, projectRoot: string | undefined): Artifact {
	return assignArtifactProject(artifacts, scopes, id, "playbook", projectRoot);
}

export function showPlaybook(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "playbook");
	return artifacts.get(id, { tree: true })!;
}

export function updatePlaybook(artifacts: ArtifactStore, id: string, input: UpdatePlaybookInput, context?: ArtifactEventContext): Artifact {
	requireContentUpdateFields(input);
	assertTitleBounds(input.title);
	assertBodyBounds(input.body);
	assertLabelsBounds(input.labels);
	const playbook = requireLocallyOwnedContent(requireKind(artifacts, id, "playbook"));
	const updated = artifacts.updateContent(playbook.id, input, context);
	if (!updated) throw new Error(`playbook "${id}" not found`);
	return updated;
}

export function transitionPlaybook(artifacts: ArtifactStore, id: string, action: PlaybookTransition, context?: ArtifactEventContext): Artifact {
	const playbook = requireLocallyOwnedContent(requireKind(artifacts, id, "playbook"));
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (playbook.status !== expected) throw new Error(`cannot ${action} playbook from ${playbook.status}`);
	return artifacts.setStatus(id, target, context)!;
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
	const trigger = typeof playbook.extra["trigger"] === "string" ? playbook.extra["trigger"] : "manual invocation";
	const steps = Array.isArray(playbook.extra["steps"]) ? (playbook.extra["steps"] as PlaybookStep[]) : [];
	const tools = Array.isArray(playbook.extra["tools"]) ? playbook.extra["tools"].filter((tool): tool is string => typeof tool === "string") : [];
	const declaredArguments = Array.isArray(playbook.extra["arguments"]) ? (playbook.extra["arguments"] as PlaybookArgument[]) : [];
	const argumentLines = declaredArguments.map((argument) => {
		const value = provided[argument.name];
		if (value !== undefined) return `- ${argument.name}: ${String(value)}`;
		return `- ${argument.name} (${argumentQualifier(argument)}${argument.description ? `: ${argument.description}` : ""}) -- not yet provided`;
	});
	const missingRequired = declaredArguments.filter((argument) => argument.required && provided[argument.name] === undefined && argument.default === undefined);
	return [
		`Apply Papyrus playbook "${playbook.title}".`,
		`Trigger: ${trigger}`,
		...(playbook.body ? [`Context: ${playbook.body}`] : []),
		...(argumentLines.length > 0 ? ["Arguments:", ...argumentLines] : []),
		...(missingRequired.length > 0
			? [`Missing required argument(s): ${missingRequired.map((argument) => argument.name).join(", ")}. Ask the human for these directly -- the discuss tool with live:true asks synchronously and gets a real answer in this same turn -- before proceeding with the steps below. Do not guess or invent a value.`]
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
export function playbookInvocation(artifacts: ArtifactStore, id: string, provided: Record<string, unknown> = {}, visited: Set<string> = new Set(), depth = 0): string {
	const playbook = requireKind(artifacts, id, "playbook");
	visited.add(id);

	const edges = artifacts.relationships({ artifactIds: [id] }).filter((edge) => edge.from === id).slice(0, PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS);
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
			bucket.push(`Also linked via ${edge.relation} to ${role} playbook "${target.title}" -- already invoked above in this chain, not repeated.`);
		} else if (depth + 1 > PLAYBOOK_INVOCATION_MAX_CALL_DEPTH) {
			bucket.push(`Also linked via ${edge.relation} to ${role} playbook "${target.title}" -- call depth limit reached, invoke it separately.`);
		} else {
			const nested = playbookInvocation(artifacts, target.id, provided, visited, depth + 1);
			bucket.push(edge.relation === "contains"
				? `Nested playbook (contains) "${target.title}" -- run as part of this one:\n${nested}`
				: `Prerequisite playbook (depends_on) "${target.title}" -- complete this FIRST, before the steps below:\n${nested}`);
		}
	}

	const sections = [...prerequisiteSections, playbookInvocationBody(playbook, provided), ...nestedSections];
	if (linkedArtifactLines.length > 0) {
		sections.push(["Linked context (query Papyrus for full detail before proceeding):", ...linkedArtifactLines].join("\n"));
	}
	return sections.join("\n\n");
}
