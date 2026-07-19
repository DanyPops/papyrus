import type { Artifact, CreateArtifactInput } from "./domain/artifact.ts";
import { validateSkillDefinition } from "./domain/skill-definition.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";

export interface ListFilter {
	status?: string;
	text?: string;
	limit?: number;
}

function requireKind(artifacts: ArtifactStore, id: string, kind: string): Artifact {
	const artifact = artifacts.get(id);
	if (!artifact) throw new Error(`${kind} artifact "${id}" not found`);
	if (artifact.kind !== kind) throw new Error(`artifact "${id}" is not a ${kind}`);
	return artifact;
}

export interface CreateDocumentInput {
	title: string;
	body?: string;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	templateId?: string;
}

export type DocumentTransition = "activate" | "archive" | "reopen";
export type DocumentRelation = "references" | "documents" | "supersedes" | "relates_to" | "contains" | "part_of";

const DOCUMENT_TRANSITIONS: Record<DocumentTransition, { from: string[]; to: string }> = {
	activate: { from: ["draft"], to: "active" },
	archive: { from: ["draft", "active"], to: "archived" },
	reopen: { from: ["archived"], to: "draft" },
};

export function createDocument(artifacts: ArtifactStore, input: CreateDocumentInput): Artifact {
	return artifacts.create({
		kind: "doc",
		title: input.title,
		body: input.body,
		subtype: input.subtype,
		labels: input.labels,
		extra: input.extra,
		templateId: input.templateId,
	});
}

export function listDocuments(artifacts: ArtifactStore, filter: ListFilter): Artifact[] {
	return artifacts.query({ kind: "doc", ...filter });
}

export function showDocument(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "doc");
	return artifacts.get(id, { tree: true })!;
}

export function transitionDocument(artifacts: ArtifactStore, id: string, action: DocumentTransition): Artifact {
	const document = requireKind(artifacts, id, "doc");
	const transition = DOCUMENT_TRANSITIONS[action];
	if (!transition.from.includes(document.status)) throw new Error(`cannot ${action} document from ${document.status}`);
	return artifacts.setStatus(id, transition.to)!;
}

export function linkDocument(artifacts: ArtifactStore, id: string, relation: DocumentRelation, targetId: string): Artifact {
	requireKind(artifacts, id, "doc");
	if (!artifacts.get(targetId)) throw new Error(`target artifact "${targetId}" not found`);
	artifacts.link({ from: id, relation, to: targetId });
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
}

export type RuleTransition = "enable" | "disable";

export function createRule(artifacts: ArtifactStore, input: CreateRuleInput): Artifact {
	return artifacts.create({
		kind: "rule",
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			...(input.extra ?? {}),
			...(input.condition ? { condition: input.condition } : {}),
			...(input.action ? { action: input.action } : {}),
			severity: input.severity ?? "info",
		},
	});
}

export function listRules(artifacts: ArtifactStore, filter: ListFilter): Artifact[] {
	return artifacts.query({ kind: "rule", ...filter });
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

export function transitionRule(artifacts: ArtifactStore, id: string, action: RuleTransition): Artifact {
	const rule = requireKind(artifacts, id, "rule");
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (rule.status !== expected) throw new Error(`cannot ${action} rule from ${rule.status}`);
	return artifacts.setStatus(id, target)!;
}

export function gateTaskWithRule(artifacts: ArtifactStore, ruleId: string, taskId: string): Artifact {
	requireKind(artifacts, ruleId, "rule");
	requireKind(artifacts, taskId, "task");
	artifacts.link({ from: ruleId, relation: "gates", to: taskId });
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
}

export interface CreateArtifactTemplateInput {
	title: string;
	targetKind: string;
	defaults?: Record<string, unknown>;
	required?: string[];
	body?: string;
	labels?: string[];
}

export type SkillTransition = "enable" | "disable";

export function createSkill(artifacts: ArtifactStore, input: CreateSkillInput): Artifact {
	if (input.definition !== undefined && (input.trigger !== undefined || input.steps !== undefined || input.tools !== undefined)) {
		throw new Error("workflow Skill definition cannot be mixed with legacy trigger, steps, or tools");
	}
	const definition = input.definition === undefined ? undefined : validateSkillDefinition(input.definition);
	return artifacts.create({
		kind: "skill",
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
	});
}

export function createArtifactTemplate(artifacts: ArtifactStore, input: CreateArtifactTemplateInput): Artifact {
	return artifacts.create({
		kind: "skill",
		subtype: "artifact-template",
		title: input.title,
		body: input.body,
		labels: input.labels,
		extra: {
			targetKind: input.targetKind,
			defaults: input.defaults ?? {},
			required: input.required ?? ["title"],
		},
	});
}

export function instantiateTemplate(artifacts: ArtifactStore, templateId: string, input: CreateArtifactInput): Artifact {
	return artifacts.create({ ...input, templateId });
}

export function listSkills(artifacts: ArtifactStore, filter: ListFilter): Artifact[] {
	return artifacts.query({ kind: "skill", ...filter });
}

export function showSkill(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "skill");
	return artifacts.get(id, { tree: true })!;
}

export function skillInvocation(artifacts: ArtifactStore, id: string): string {
	const skill = requireKind(artifacts, id, "skill");
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

export function transitionSkill(artifacts: ArtifactStore, id: string, action: SkillTransition): Artifact {
	const skill = requireKind(artifacts, id, "skill");
	const expected = action === "enable" ? "deprecated" : "active";
	const target = action === "enable" ? "active" : "deprecated";
	if (skill.status !== expected) throw new Error(`cannot ${action} skill from ${skill.status}`);
	return artifacts.setStatus(id, target)!;
}
