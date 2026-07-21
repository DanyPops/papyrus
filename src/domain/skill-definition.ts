import {
	SEED_RELATIONS,
	SKILL_MAX_BLUEPRINTS,
	SKILL_MAX_ENUM_VALUES,
	SKILL_MAX_INPUTS,
	SKILL_MAX_LINKS,
} from "../constants.ts";

export type SkillArgumentValue = string | number | boolean;
export type SkillInputType = "string" | "number" | "boolean";

export interface SkillInputDefinition {
	type: SkillInputType;
	required?: boolean;
	default?: SkillArgumentValue;
	enum?: SkillArgumentValue[];
}

export interface SkillDocBlueprint {
	ref: string;
	title: string;
	body?: string;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
}

export interface SkillRuleBlueprint {
	ref: string;
	title: string;
	body?: string;
	condition?: string;
	action?: string;
	severity?: "block" | "warn" | "info";
	labels?: string[];
	extra?: Record<string, unknown>;
}

export interface SkillTaskBlueprint {
	ref: string;
	title: string;
	body?: string;
	dependsOn?: string[];
	parent?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
}

/**
 * A pipeline step that nests another workflow Skill's run inside this one -- the Jenkins
 * "trigger downstream job and wait" / Ansible "include_tasks" primitive. `skillId` is late-
 * bound: existence and workflow-subtype are checked at execution time (skill-execution.ts),
 * not here, since this validator has no store access. `dependsOn`/`parent` place this step in
 * the SAME dependency graph as ordinary task blueprints -- a task can depend on a skill-call
 * ref (meaning: depend on every task the nested run creates), and a skill-call's own `parent`
 * contains the nested run's root tasks under an outer task.
 */
export interface SkillCallBlueprint {
	ref: string;
	title: string;
	skillId: string;
	arguments?: Record<string, unknown>;
	dependsOn?: string[];
	parent?: string;
}

export interface SkillBlueprints {
	docs: SkillDocBlueprint[];
	rules: SkillRuleBlueprint[];
	tasks: SkillTaskBlueprint[];
	skills: SkillCallBlueprint[];
}

export interface SkillBlueprintLink {
	from: string;
	relation: string;
	to: string;
}

export interface SkillDefinition {
	version: 1;
	inputs: Record<string, SkillInputDefinition>;
	blueprints: SkillBlueprints;
	links: SkillBlueprintLink[];
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}/g;
const INPUT_TYPES = new Set<SkillInputType>(["string", "number", "boolean"]);
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RELATIONS = new Set<string>(SEED_RELATIONS);

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function validateArgumentValue(name: string, type: SkillInputType, value: unknown): SkillArgumentValue {
	if (typeof value !== type || (type === "number" && !Number.isFinite(value))) {
		throw new Error(`skill argument "${name}" must be a ${type}`);
	}
	return value as SkillArgumentValue;
}

function validateInputs(value: unknown): Record<string, SkillInputDefinition> {
	const source = record(value ?? {}, "skill inputs");
	const entries = Object.entries(source);
	if (entries.length > SKILL_MAX_INPUTS) throw new Error(`skill inputs exceed ${SKILL_MAX_INPUTS}`);
	const result: Record<string, SkillInputDefinition> = {};
	for (const [name, raw] of entries) {
		if (RESERVED_KEYS.has(name)) throw new Error(`reserved skill input name "${name}"`);
		if (!NAME_PATTERN.test(name)) throw new Error(`invalid skill input name "${name}"`);
		const input = record(raw, `skill input "${name}"`);
		if (!INPUT_TYPES.has(input["type"] as SkillInputType)) throw new Error(`skill input "${name}" has unsupported type`);
		const type = input["type"] as SkillInputType;
		if (input["required"] !== undefined && typeof input["required"] !== "boolean") {
			throw new Error(`skill input "${name}" required must be boolean`);
		}
		const normalized: SkillInputDefinition = { type };
		if (input["required"] !== undefined) normalized.required = input["required"] as boolean;
		if (input["default"] !== undefined) normalized.default = validateArgumentValue(name, type, input["default"]);
		if (input["enum"] !== undefined) {
			const values = array(input["enum"], `skill input "${name}" enum`);
			if (values.length === 0 || values.length > SKILL_MAX_ENUM_VALUES) throw new Error(`skill input "${name}" enum must contain 1-${SKILL_MAX_ENUM_VALUES} values`);
			normalized.enum = values.map((entry) => validateArgumentValue(name, type, entry));
			if (normalized.default !== undefined && !normalized.enum.includes(normalized.default)) {
				throw new Error(`skill input "${name}" default must be one of its enum values`);
			}
		}
		result[name] = normalized;
	}
	return result;
}

function validateBlueprint<T extends { ref: string; title: string }>(value: unknown, kind: string): T {
	const source = record(value, `skill ${kind} blueprint`);
	const ref = string(source["ref"], `skill ${kind} blueprint ref`);
	if (!NAME_PATTERN.test(ref)) throw new Error(`invalid skill blueprint ref "${ref}"`);
	const title = string(source["title"], `skill ${kind} blueprint title`);
	return { ...source, ref, title } as T;
}

function placeholders(value: unknown, result: Set<string> = new Set()): Set<string> {
	if (typeof value === "string") {
		for (const match of value.matchAll(PLACEHOLDER_PATTERN)) result.add(match[1]!);
	} else if (Array.isArray(value)) {
		for (const entry of value) placeholders(entry, result);
	} else if (typeof value === "object" && value !== null) {
		for (const entry of Object.values(value)) placeholders(entry, result);
	}
	return result;
}

/** Steps sharing one dependency graph: ordinary tasks and skill-call pipeline steps alike. */
interface DependentStep {
	ref: string;
	dependsOn?: string[];
}

function assertAcyclic(steps: DependentStep[]): void {
	const byRef = new Map(steps.map((step) => [step.ref, step]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (ref: string): void => {
		if (visiting.has(ref)) throw new Error(`skill step dependency cycle includes "${ref}"`);
		if (visited.has(ref)) return;
		visiting.add(ref);
		for (const dependency of byRef.get(ref)?.dependsOn ?? []) visit(dependency);
		visiting.delete(ref);
		visited.add(ref);
	};
	for (const step of steps) visit(step.ref);
}

function validateSkillCallBlueprint(value: unknown): SkillCallBlueprint {
	const source = record(value, "skill call blueprint");
	const ref = string(source["ref"], "skill call blueprint ref");
	if (!NAME_PATTERN.test(ref)) throw new Error(`invalid skill blueprint ref "${ref}"`);
	const title = string(source["title"], "skill call blueprint title");
	const skillId = string(source["skillId"], "skill call blueprint skillId");
	return { ...source, ref, title, skillId } as SkillCallBlueprint;
}

export function validateSkillDefinition(value: unknown): SkillDefinition {
	const source = record(value, "skill definition");
	if (source["version"] !== 1) throw new Error("skill definition version must be 1");
	const inputs = validateInputs(source["inputs"]);
	const rawBlueprints = record(source["blueprints"], "skill blueprints");
	const docs = array(rawBlueprints["docs"] ?? [], "skill doc blueprints").map((entry) => validateBlueprint<SkillDocBlueprint>(entry, "doc"));
	const rules = array(rawBlueprints["rules"] ?? [], "skill rule blueprints").map((entry) => validateBlueprint<SkillRuleBlueprint>(entry, "rule"));
	const tasks = array(rawBlueprints["tasks"] ?? [], "skill task blueprints").map((entry) => validateBlueprint<SkillTaskBlueprint>(entry, "task"));
	const skillCalls = array(rawBlueprints["skills"] ?? [], "skill call blueprints").map(validateSkillCallBlueprint);
	const all = [...docs, ...rules, ...tasks, ...skillCalls];
	if (all.length === 0 || all.length > SKILL_MAX_BLUEPRINTS) throw new Error(`skill blueprints must contain 1-${SKILL_MAX_BLUEPRINTS} artifacts`);
	const refs = new Set<string>();
	for (const blueprint of all) {
		if (refs.has(blueprint.ref)) throw new Error(`duplicate skill blueprint ref "${blueprint.ref}"`);
		refs.add(blueprint.ref);
	}
	// Tasks and skill-call pipeline steps share one dependency graph: a task may depend on a
	// skill-call ref (meaning: depend on every task that nested run creates), and vice versa.
	const stepRefs = new Set<string>([...tasks.map((task) => task.ref), ...skillCalls.map((call) => call.ref)]);
	for (const task of tasks) {
		if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new Error(`skill task "${task.ref}" dependsOn must be an array`);
		for (const dependency of task.dependsOn ?? []) {
			if (!stepRefs.has(dependency)) throw new Error(`unknown skill task dependency ref "${dependency}"`);
		}
		// parent stays task-only: containment under a skill-call step's exploded task SET has no
		// single natural parent, so parent must name an actual task blueprint.
		if (task.parent !== undefined && !tasks.some((candidate) => candidate.ref === task.parent)) {
			throw new Error(`unknown skill task parent ref "${task.parent}"`);
		}
	}
	for (const call of skillCalls) {
		if (call.dependsOn !== undefined && !Array.isArray(call.dependsOn)) throw new Error(`skill call "${call.ref}" dependsOn must be an array`);
		for (const dependency of call.dependsOn ?? []) {
			if (!stepRefs.has(dependency)) throw new Error(`unknown skill call dependency ref "${dependency}"`);
		}
		if (call.parent !== undefined && !tasks.some((candidate) => candidate.ref === call.parent)) {
			throw new Error(`unknown skill call parent ref "${call.parent}"`);
		}
	}
	assertAcyclic([...tasks, ...skillCalls]);
	for (const name of placeholders(all)) {
		if (!Object.hasOwn(inputs, name)) throw new Error(`unknown skill input placeholder "${name}"`);
	}
	const links = array(source["links"] ?? [], "skill links").map((entry) => {
		const link = record(entry, "skill link");
		const from = string(link["from"], "skill link from");
		const relation = string(link["relation"], "skill link relation");
		const to = string(link["to"], "skill link to");
		if (!refs.has(from)) throw new Error(`unknown skill blueprint ref "${from}"`);
		if (!refs.has(to)) throw new Error(`unknown skill blueprint ref "${to}"`);
		if (!RELATIONS.has(relation)) throw new Error(`unknown skill link relation "${relation}"`);
		return { from, relation, to };
	});
	if (links.length > SKILL_MAX_LINKS) throw new Error(`skill links exceed ${SKILL_MAX_LINKS}`);
	return { version: 1, inputs, blueprints: { docs, rules, tasks, skills: skillCalls }, links };
}

export function resolveSkillArguments(definition: SkillDefinition, value: unknown): Record<string, SkillArgumentValue> {
	const source = record(value ?? {}, "skill arguments");
	for (const name of Object.keys(source)) {
		if (!Object.hasOwn(definition.inputs, name)) throw new Error(`unknown skill argument "${name}"`);
	}
	const result: Record<string, SkillArgumentValue> = {};
	for (const [name, input] of Object.entries(definition.inputs)) {
		const raw = source[name] ?? input.default;
		if (raw === undefined) {
			if (input.required) throw new Error(`missing required skill argument "${name}"`);
			continue;
		}
		const normalized = validateArgumentValue(name, input.type, raw);
		if (input.enum && !input.enum.includes(normalized)) {
			throw new Error(`skill argument "${name}" must be one of: ${input.enum.join(", ")}`);
		}
		result[name] = normalized;
	}
	return result;
}
