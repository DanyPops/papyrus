import {
	ARTIFACT_BODY_MAX_LENGTH,
	ARTIFACT_LABEL_MAX_COUNT,
	ARTIFACT_LABEL_MAX_LENGTH,
	ARTIFACT_SCOPE_MAX_ARTIFACTS,
	ARTIFACT_TITLE_MAX_LENGTH,
	PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH,
	PLAYBOOK_ARGUMENT_MAX_COUNT,
	PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH,
	PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS,
	RULE_TEXT_HARD_LIMIT_CHARACTERS,
	SKILL_INVOCATION_MAX_CALL_DEPTH,
	SKILL_INVOCATION_MAX_LINKED_ARTIFACTS,
} from "./constants.ts";
import { requireLocallyOwnedContent, type Artifact, type CreateArtifactInput } from "./domain/artifact.ts";
import type { ArtifactEventContext } from "./domain/artifact-event.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";
import { validateSkillDefinition } from "./domain/skill-definition.ts";
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
 * Shared by listDocuments/listRules/listSkills: when filter.projectRoot is given, resolve
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

/** Shared by assignDocumentProject/assignRuleProject/assignSkillProject. */
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

/** Global rules always apply; scoped workflow rules apply only while their run owns active focus. */
export function listInjectableRules(artifacts: ArtifactStore, activeTaskId?: string): Artifact[] {
	return artifacts.query({ kind: "rule", status: "active" }).filter((rule) => {
		const scope = rule.extra["scope"];
		if (scope === undefined) return true;
		if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
		const value = scope as Record<string, unknown>;
		if (value["type"] !== "skill-run" || !Array.isArray(value["taskIds"])) return false;
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

export interface CreateSkillInput {
	title: string;
	body?: string;
	trigger?: string;
	steps?: string[];
	tools?: string[];
	definition?: unknown;
	labels?: string[];
	extra?: Record<string, unknown>;
	projectRoot?: string;
}

export interface CreateArtifactTemplateInput {
	title: string;
	targetKind: string;
	defaults?: Record<string, unknown>;
	required?: string[];
	body?: string;
	labels?: string[];
	projectRoot?: string;
}

export type SkillTransition = "enable" | "disable";

export function createSkill(artifacts: ArtifactStore, scopes: ArtifactScopeStore, input: CreateSkillInput, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	if (input.definition !== undefined && (input.trigger !== undefined || input.steps !== undefined || input.tools !== undefined)) {
		throw new Error("workflow Skill definition cannot be mixed with legacy trigger, steps, or tools");
	}
	const definition = input.definition === undefined ? undefined : validateSkillDefinition(input.definition);
	if (definition?.blueprints.docs.some((document) => document.subtype === NOTE_SUBTYPE)) requireNotesFacade(authority, "skills");
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const skill = artifacts.create({
		kind: "skill",
		status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
		subtype: definition ? "workflow" : undefined,
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			...(input.extra ?? {}),
			...(definition ? { definition } : {}),
			...(input.trigger ? { trigger: input.trigger } : {}),
			...(input.steps ? { steps: input.steps } : {}),
			...(input.tools ? { tools: input.tools } : {}),
		},
	}, context);
	scopes.assign(skill.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	return skill;
}

export function createArtifactTemplate(artifacts: ArtifactStore, scopes: ArtifactScopeStore, input: CreateArtifactTemplateInput, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	if (input.targetKind === "doc" && input.defaults?.["subtype"] === NOTE_SUBTYPE) requireNotesFacade(authority, "skills");
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const template = artifacts.create({
		kind: "skill",
		status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
		subtype: "artifact-template",
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			targetKind: input.targetKind,
			defaults: input.defaults ?? {},
			required: input.required ?? ["title"],
		},
	}, context);
	scopes.assign(template.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	return template;
}

export function instantiateTemplate(artifacts: ArtifactStore, templateId: string, input: CreateArtifactInput, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	if (rejectsNoteTemplate(artifacts, templateId, input.subtype)) requireNotesFacade(authority, "skills");
	return artifacts.create({ ...input, templateId }, context);
}

export function listSkills(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "skill", filter);
}

export function assignSkillProject(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string, projectRoot: string | undefined): Artifact {
	return assignArtifactProject(artifacts, scopes, id, "skill", projectRoot);
}

export function showSkill(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "skill");
	return artifacts.get(id, { tree: true })!;
}

export type UpdateSkillInput = UpdateContentInput;

export function updateSkill(artifacts: ArtifactStore, id: string, input: UpdateSkillInput, context?: ArtifactEventContext): Artifact {
	requireContentUpdateFields(input);
	assertTitleBounds(input.title);
	assertBodyBounds(input.body);
	assertLabelsBounds(input.labels);
	const skill = requireLocallyOwnedContent(requireKind(artifacts, id, "skill"));
	const updated = artifacts.updateContent(skill.id, input, context);
	if (!updated) throw new Error(`skill "${id}" not found`);
	return updated;
}

function skillInvocationBody(skill: Artifact): string {
	if (skill.subtype === "artifact-template") {
		return `Create an artifact using Papyrus template "${skill.title}".\ntemplate_name: ${skill.title}\nAsk for or infer all required template fields, then call the skills domain tool instantiate action.`;
	}
	if (skill.subtype === "workflow") {
		const definition = validateSkillDefinition(skill.extra["definition"]);
		const required = Object.entries(definition.inputs)
			.filter(([, input]) => input.required && input.default === undefined)
			.map(([name]) => name);
		return [
			`Run Papyrus workflow Skill "${skill.title}".`,
			`Required arguments: ${required.length > 0 ? required.join(", ") : "none"}.`,
			"Call the skills domain tool with action=run and arguments after collecting required values.",
		].join("\n");
	}
	const trigger = typeof skill.extra["trigger"] === "string" ? skill.extra["trigger"] : "manual invocation";
	const steps = Array.isArray(skill.extra["steps"]) ? skill.extra["steps"].filter((step): step is string => typeof step === "string") : [];
	const tools = Array.isArray(skill.extra["tools"]) ? skill.extra["tools"].filter((tool): tool is string => typeof tool === "string") : [];
	return [
		`Apply Papyrus skill "${skill.title}".`,
		`Trigger: ${trigger}`,
		...(skill.body ? [`Context: ${skill.body}`] : []),
		...(steps.length ? ["Steps:", ...steps.map((step, index) => `${index + 1}. ${step}`)] : []),
		...(tools.length ? [`Tools: ${tools.join(", ")}`] : []),
	].join("\n");
}

/**
 * Skills are special: invoking one queries Papyrus for the skill's real outgoing graph edges
 * -- not just its own static body/extra fields -- so a Skill linked to existing Tasks, Rules,
 * or Docs surfaces that linked context on invocation. A Skill can also link to and invoke
 * OTHER Skills (any relation whose target is itself a Skill, e.g. the same "triggers" relation
 * workflow execution already uses for skill-to-task edges): invoking the parent recursively
 * composes the linked skill's own invocation. Bounded and cycle-safe -- a skill-calls-skill
 * edge cycle degrades to a marker instead of infinite-looping, matching the cycle-safety
 * discipline established by task dependency graphs and the (since-removed; see Doc
 * "ConversationJournal design record") ConversationJournal domain's own reply chains.
 * `visited` and `depth` are recursion-internal; callers should not pass them.
 */
export function skillInvocation(artifacts: ArtifactStore, id: string, visited: Set<string> = new Set(), depth = 0): string {
	const skill = requireKind(artifacts, id, "skill");
	visited.add(id);
	const sections = [skillInvocationBody(skill)];

	const edges = artifacts.relationships({ artifactIds: [id] }).filter((edge) => edge.from === id).slice(0, SKILL_INVOCATION_MAX_LINKED_ARTIFACTS);
	const linkedArtifactLines: string[] = [];
	const linkedSkillSections: string[] = [];
	for (const edge of edges) {
		const target = artifacts.get(edge.to);
		if (!target) continue; // dangling edge -- defensive, should not happen
		if (target.kind !== "skill") {
			linkedArtifactLines.push(`- ${edge.relation} ${target.kind} "${target.title}"`);
			continue;
		}
		if (visited.has(target.id)) {
			linkedSkillSections.push(`Also linked via ${edge.relation} to skill "${target.title}" -- already invoked above in this chain, not repeated.`);
		} else if (depth + 1 > SKILL_INVOCATION_MAX_CALL_DEPTH) {
			linkedSkillSections.push(`Also linked via ${edge.relation} to skill "${target.title}" -- call depth limit reached, invoke it separately.`);
		} else {
			const nested = skillInvocation(artifacts, target.id, visited, depth + 1);
			linkedSkillSections.push(`Also invoke linked skill (${edge.relation}) "${target.title}":\n${nested}`);
		}
	}
	if (linkedArtifactLines.length > 0) {
		sections.push(["Linked context (query Papyrus for full detail before proceeding):", ...linkedArtifactLines].join("\n"));
	}
	for (const section of linkedSkillSections) sections.push(section);
	return sections.join("\n\n");
}

export function transitionSkill(artifacts: ArtifactStore, id: string, action: SkillTransition, context?: ArtifactEventContext): Artifact {
	const skill = requireLocallyOwnedContent(requireKind(artifacts, id, "skill"));
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (skill.status !== expected) throw new Error(`cannot ${action} skill from ${skill.status}`);
	return artifacts.setStatus(id, target, context)!;
}

/**
 * Playbooks: a trigger and an ordered list of steps an agent reads and follows -- a completely
 * different beast from Skills, not a subtype of one. A Skill (artifact-template or workflow) is
 * mechanically instantiated into other artifacts; a Playbook is never instantiated, it's read
 * and followed, and it never composes other Playbooks the way a Skill can call another Skill.
 */
export interface PlaybookArgument {
	name: string;
	description?: string;
	/** Defaults true: naming an argument at all is a signal it matters, so an author must opt out explicitly to make one optional. */
	required: boolean;
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
		return { name, ...(description !== undefined ? { description: description as string } : {}), required: required !== false };
	});
}

export interface CreatePlaybookInput {
	title: string;
	body?: string;
	trigger?: string;
	steps?: string[];
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
	const playbook = artifacts.create({
		kind: "playbook",
		status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			...(input.extra ?? {}),
			...(input.trigger ? { trigger: input.trigger } : {}),
			...(input.steps ? { steps: input.steps } : {}),
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

/**
 * Renders trigger/steps/tools/arguments into readable guidance, plus any real linked artifacts.
 * No nested playbook-calls-playbook composition -- a Playbook is a flat procedure, not a
 * composable bundle. `provided` is the caller's already-known argument values (e.g. from the
 * conversation so far); any declared *required* argument missing from it is called out
 * explicitly, directing the agent to discuss (live:true) rather than guess or silently proceed.
 */
export function playbookInvocation(artifacts: ArtifactStore, id: string, provided: Record<string, string> = {}): string {
	const playbook = requireKind(artifacts, id, "playbook");
	const trigger = typeof playbook.extra["trigger"] === "string" ? playbook.extra["trigger"] : "manual invocation";
	const steps = Array.isArray(playbook.extra["steps"]) ? playbook.extra["steps"].filter((step): step is string => typeof step === "string") : [];
	const tools = Array.isArray(playbook.extra["tools"]) ? playbook.extra["tools"].filter((tool): tool is string => typeof tool === "string") : [];
	const declaredArguments = Array.isArray(playbook.extra["arguments"]) ? (playbook.extra["arguments"] as PlaybookArgument[]) : [];
	const argumentLines = declaredArguments.map((argument) => {
		const value = provided[argument.name];
		if (value !== undefined) return `- ${argument.name}: ${value}`;
		const qualifier = argument.required ? "required" : "optional";
		return `- ${argument.name} (${qualifier}${argument.description ? `: ${argument.description}` : ""}) -- not yet provided`;
	});
	const missingRequired = declaredArguments.filter((argument) => argument.required && provided[argument.name] === undefined);
	const sections = [[
		`Apply Papyrus playbook "${playbook.title}".`,
		`Trigger: ${trigger}`,
		...(playbook.body ? [`Context: ${playbook.body}`] : []),
		...(argumentLines.length > 0 ? ["Arguments:", ...argumentLines] : []),
		...(missingRequired.length > 0
			? [`Missing required argument(s): ${missingRequired.map((argument) => argument.name).join(", ")}. Ask the human for these directly -- the discuss tool with live:true asks synchronously and gets a real answer in this same turn -- before proceeding with the steps below. Do not guess or invent a value.`]
			: []),
		...(steps.length ? ["Steps:", ...steps.map((step, index) => `${index + 1}. ${step}`)] : []),
		...(tools.length ? [`Tools: ${tools.join(", ")}`] : []),
	].join("\n")];
	const edges = artifacts.relationships({ artifactIds: [id] }).filter((edge) => edge.from === id).slice(0, PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS);
	const linkedLines = edges
		.map((edge) => { const target = artifacts.get(edge.to); return target ? `- ${edge.relation} ${target.kind} "${target.title}"` : undefined; })
		.filter((line): line is string => line !== undefined);
	if (linkedLines.length > 0) sections.push(["Linked context (query Papyrus for full detail before proceeding):", ...linkedLines].join("\n"));
	return sections.join("\n\n");
}
