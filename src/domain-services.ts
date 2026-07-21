import {
	ARTIFACT_SCOPE_MAX_ARTIFACTS,
	RULE_TEXT_HARD_LIMIT_CHARACTERS,
	SKILL_INVOCATION_MAX_CALL_DEPTH,
	SKILL_INVOCATION_MAX_LINKED_ARTIFACTS,
} from "./constants.ts";
import type { Artifact, CreateArtifactInput } from "./domain/artifact.ts";
import type { ArtifactEventContext } from "./domain/artifact-event.ts";
import { normalizeProjectRoot } from "./domain/task-scope.ts";
import { validateSkillDefinition } from "./domain/skill-definition.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { ArtifactScopeStore } from "./ports/artifact-scope-store.ts";
import { NOTE_SUBTYPE } from "./note-service.ts";
import type { AuthorityRegistry } from "./authority-registry.ts";

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

function requireMutableDocument(document: Artifact, authority: AuthorityRegistry): Artifact {
	authority.requireArtifactAllowed(document.kind, document.subtype, "status", "docs");
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
	const document = requireMutableDocument(requireDocument(artifacts, id), authority);
	const transition = DOCUMENT_TRANSITIONS[action];
	if (!transition.from.includes(document.status)) throw new Error(`cannot ${action} document from ${document.status}`);
	return artifacts.setStatus(id, transition.to, context)!;
}

export function linkDocument(artifacts: ArtifactStore, id: string, relation: DocumentRelation, targetId: string, authority: AuthorityRegistry, context?: ArtifactEventContext): Artifact {
	requireMutableDocument(requireDocument(artifacts, id), authority);
	const target = artifacts.get(targetId);
	if (!target) throw new Error(`target artifact "${targetId}" not found`);
	requireMutableDocument(target, authority);
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
	const rule = requireKind(artifacts, id, "rule");
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (rule.status !== expected) throw new Error(`cannot ${action} rule from ${rule.status}`);
	return artifacts.setStatus(id, target, context)!;
}

export function gateTaskWithRule(artifacts: ArtifactStore, ruleId: string, taskId: string, context?: ArtifactEventContext): Artifact {
	requireKind(artifacts, ruleId, "rule");
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

function skillInvocationBody(skill: Artifact): string {
	if (skill.subtype === "artifact-template") {
		return `Create an artifact using Papyrus template "${skill.title}".\ntemplate_id: ${skill.id}\nAsk for or infer all required template fields, then call the skills domain tool instantiate action.`;
	}
	if (skill.subtype === "workflow") {
		const definition = validateSkillDefinition(skill.extra["definition"]);
		const required = Object.entries(definition.inputs)
			.filter(([, input]) => input.required && input.default === undefined)
			.map(([name]) => name);
		return [
			`Run Papyrus workflow Skill "${skill.title}" (${skill.id}).`,
			`Required arguments: ${required.length > 0 ? required.join(", ") : "none"}.`,
			"Call the skills domain tool with action=run and arguments after collecting required values.",
		].join("\n");
	}
	const trigger = typeof skill.extra["trigger"] === "string" ? skill.extra["trigger"] : "manual invocation";
	const steps = Array.isArray(skill.extra["steps"]) ? skill.extra["steps"].filter((step): step is string => typeof step === "string") : [];
	const tools = Array.isArray(skill.extra["tools"]) ? skill.extra["tools"].filter((tool): tool is string => typeof tool === "string") : [];
	return [
		`Apply Papyrus skill "${skill.title}" (${skill.id}).`,
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
 * discipline already established for ConversationJournal reply chains and task dependency
 * graphs. `visited` and `depth` are recursion-internal; callers should not pass them.
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
			linkedArtifactLines.push(`- ${edge.relation} ${target.kind} "${target.title}" (${target.id})`);
			continue;
		}
		if (visited.has(target.id)) {
			linkedSkillSections.push(`Also linked via ${edge.relation} to skill "${target.title}" (${target.id}) -- already invoked above in this chain, not repeated.`);
		} else if (depth + 1 > SKILL_INVOCATION_MAX_CALL_DEPTH) {
			linkedSkillSections.push(`Also linked via ${edge.relation} to skill "${target.title}" (${target.id}) -- call depth limit reached, invoke it separately.`);
		} else {
			const nested = skillInvocation(artifacts, target.id, visited, depth + 1);
			linkedSkillSections.push(`Also invoke linked skill (${edge.relation}) "${target.title}" (${target.id}):\n${nested}`);
		}
	}
	if (linkedArtifactLines.length > 0) {
		sections.push(["Linked context (query Papyrus for full detail before proceeding):", ...linkedArtifactLines].join("\n"));
	}
	for (const section of linkedSkillSections) sections.push(section);
	return sections.join("\n\n");
}

export function transitionSkill(artifacts: ArtifactStore, id: string, action: SkillTransition, context?: ArtifactEventContext): Artifact {
	const skill = requireKind(artifacts, id, "skill");
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (skill.status !== expected) throw new Error(`cannot ${action} skill from ${skill.status}`);
	return artifacts.setStatus(id, target, context)!;
}
