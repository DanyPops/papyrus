import { SEED_RELATIONS } from "../constants.ts";

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

export interface SkillBlueprints {
	docs: SkillDocBlueprint[];
	rules: SkillRuleBlueprint[];
	tasks: SkillTaskBlueprint[];
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

const MAX_INPUTS = 32;
const MAX_ENUM_VALUES = 32;
const MAX_BLUEPRINTS = 100;
const MAX_LINKS = 500;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}/g;
const INPUT_TYPES = new Set<SkillInputType>(["string", "number", "boolean"]);
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
	if (entries.length > MAX_INPUTS) throw new Error(`skill inputs exceed ${MAX_INPUTS}`);
	const result: Record<string, SkillInputDefinition> = {};
	for (const [name, raw] of entries) {
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
			if (values.length === 0 || values.length > MAX_ENUM_VALUES) throw new Error(`skill input "${name}" enum must contain 1-${MAX_ENUM_VALUES} values`);
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

function assertAcyclic(tasks: SkillTaskBlueprint[]): void {
	const byRef = new Map(tasks.map((task) => [task.ref, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (ref: string): void => {
		if (visiting.has(ref)) throw new Error(`skill task dependency cycle includes "${ref}"`);
		if (visited.has(ref)) return;
		visiting.add(ref);
		for (const dependency of byRef.get(ref)?.dependsOn ?? []) visit(dependency);
		visiting.delete(ref);
		visited.add(ref);
	};
	for (const task of tasks) visit(task.ref);
}

export function validateSkillDefinition(value: unknown): SkillDefinition {
	const source = record(value, "skill definition");
	if (source["version"] !== 1) throw new Error("skill definition version must be 1");
	const inputs = validateInputs(source["inputs"]);
	const rawBlueprints = record(source["blueprints"], "skill blueprints");
	const docs = array(rawBlueprints["docs"] ?? [], "skill doc blueprints").map((entry) => validateBlueprint<SkillDocBlueprint>(entry, "doc"));
	const rules = array(rawBlueprints["rules"] ?? [], "skill rule blueprints").map((entry) => validateBlueprint<SkillRuleBlueprint>(entry, "rule"));
	const tasks = array(rawBlueprints["tasks"] ?? [], "skill task blueprints").map((entry) => validateBlueprint<SkillTaskBlueprint>(entry, "task"));
	const all = [...docs, ...rules, ...tasks];
	if (all.length === 0 || all.length > MAX_BLUEPRINTS) throw new Error(`skill blueprints must contain 1-${MAX_BLUEPRINTS} artifacts`);
	const refs = new Set<string>();
	for (const blueprint of all) {
		if (refs.has(blueprint.ref)) throw new Error(`duplicate skill blueprint ref "${blueprint.ref}"`);
		refs.add(blueprint.ref);
	}
	for (const task of tasks) {
		if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new Error(`skill task "${task.ref}" dependsOn must be an array`);
		for (const dependency of task.dependsOn ?? []) {
			if (!tasks.some((candidate) => candidate.ref === dependency)) throw new Error(`unknown skill task dependency ref "${dependency}"`);
		}
		if (task.parent !== undefined && !tasks.some((candidate) => candidate.ref === task.parent)) {
			throw new Error(`unknown skill task parent ref "${task.parent}"`);
		}
	}
	assertAcyclic(tasks);
	for (const name of placeholders(all)) {
		if (!(name in inputs)) throw new Error(`unknown skill input placeholder "${name}"`);
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
	if (links.length > MAX_LINKS) throw new Error(`skill links exceed ${MAX_LINKS}`);
	return { version: 1, inputs, blueprints: { docs, rules, tasks }, links };
}

export function resolveSkillArguments(definition: SkillDefinition, value: unknown): Record<string, SkillArgumentValue> {
	const source = record(value ?? {}, "skill arguments");
	for (const name of Object.keys(source)) {
		if (!(name in definition.inputs)) throw new Error(`unknown skill argument "${name}"`);
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
