import { SEED_RELATIONS, SKILL_MAX_BLUEPRINTS, SKILL_MAX_ENUM_VALUES, SKILL_MAX_INPUTS, SKILL_MAX_LINKS } from "../constants.ts";

export type BlueprintArgumentValue = string | number | boolean;
export type BlueprintInputType = "string" | "number" | "boolean";

export interface BlueprintInputDefinition {
	type: BlueprintInputType;
	required?: boolean;
	default?: BlueprintArgumentValue;
	enum?: BlueprintArgumentValue[];
}

export interface DocBlueprint {
	ref: string;
	title: string;
	body?: string;
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
}

export interface RuleBlueprint {
	ref: string;
	title: string;
	body?: string;
	condition?: string;
	action?: string;
	severity?: "block" | "warn" | "info";
	labels?: string[];
	extra?: Record<string, unknown>;
}

export interface TaskBlueprint {
	ref: string;
	title: string;
	body?: string;
	dependsOn?: string[];
	parent?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
}

/**
 * A pipeline step that nests another run inside this one -- the Jenkins "trigger downstream
 * job and wait" / Ansible "include_tasks" primitive. The target named by `targetId` can be
 * either a workflow-definition Playbook or an ordinary steps/trigger-shaped Playbook
 * (workflow-execution.ts resolves which, by the target artifact's own subtype); existence and
 * eligibility are both checked at execution time, not here, since this validator has no store
 * access. `dependsOn`/`parent` place this step in the SAME dependency graph as ordinary task
 * blueprints -- a task can depend on a call ref (meaning: depend on every task the nested run
 * creates), and a call's own `parent` contains the nested run's root tasks under an outer task.
 */
export interface CallBlueprint {
	ref: string;
	title: string;
	targetId: string;
	arguments?: Record<string, unknown>;
	dependsOn?: string[];
	parent?: string;
}

export interface Blueprints {
	docs: DocBlueprint[];
	rules: RuleBlueprint[];
	tasks: TaskBlueprint[];
	skills: CallBlueprint[];
}

export interface BlueprintLink {
	from: string;
	relation: string;
	to: string;
}

export interface BlueprintDefinition {
	version: 1;
	inputs: Record<string, BlueprintInputDefinition>;
	blueprints: Blueprints;
	links: BlueprintLink[];
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*}}/g;
/** Exported so any other caller declaring typed inputs against this same shape (e.g. Playbook arguments) validates and rejects exactly the same way, instead of re-deriving its own type-checking logic. */
export const BLUEPRINT_INPUT_TYPES = new Set<BlueprintInputType>(["string", "number", "boolean"]);
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

/** Exported for reuse by any other typed-argument declaration against this same value shape (e.g. Playbook arguments), rather than re-deriving this exact check elsewhere. */
export function validateArgumentValue(name: string, type: BlueprintInputType, value: unknown): BlueprintArgumentValue {
	if (typeof value !== type || (type === "number" && !Number.isFinite(value))) {
		throw new Error(`argument "${name}" must be a ${type}`);
	}
	return value as BlueprintArgumentValue;
}

function validateInputs(value: unknown): Record<string, BlueprintInputDefinition> {
	const source = record(value ?? {}, "inputs");
	const entries = Object.entries(source);
	if (entries.length > SKILL_MAX_INPUTS) throw new Error(`inputs exceed ${SKILL_MAX_INPUTS}`);
	const result: Record<string, BlueprintInputDefinition> = {};
	for (const [name, raw] of entries) {
		if (RESERVED_KEYS.has(name)) throw new Error(`reserved input name "${name}"`);
		if (!NAME_PATTERN.test(name)) throw new Error(`invalid input name "${name}"`);
		const input = record(raw, `input "${name}"`);
		if (!BLUEPRINT_INPUT_TYPES.has(input.type as BlueprintInputType)) throw new Error(`input "${name}" has unsupported type`);
		const type = input.type as BlueprintInputType;
		if (input.required !== undefined && typeof input.required !== "boolean") {
			throw new Error(`input "${name}" required must be boolean`);
		}
		const normalized: BlueprintInputDefinition = { type };
		if (input.required !== undefined) normalized.required = input.required as boolean;
		if (input.default !== undefined) normalized.default = validateArgumentValue(name, type, input.default);
		if (input.enum !== undefined) {
			const values = array(input.enum, `input "${name}" enum`);
			if (values.length === 0 || values.length > SKILL_MAX_ENUM_VALUES)
				throw new Error(`input "${name}" enum must contain 1-${SKILL_MAX_ENUM_VALUES} values`);
			normalized.enum = values.map((entry) => validateArgumentValue(name, type, entry));
			if (normalized.default !== undefined && !normalized.enum.includes(normalized.default)) {
				throw new Error(`input "${name}" default must be one of its enum values`);
			}
		}
		result[name] = normalized;
	}
	return result;
}

function validateBlueprint<T extends { ref: string; title: string }>(value: unknown, kind: string): T {
	const source = record(value, `${kind} blueprint`);
	const ref = string(source.ref, `${kind} blueprint ref`);
	if (!NAME_PATTERN.test(ref)) throw new Error(`invalid blueprint ref "${ref}"`);
	const title = string(source.title, `${kind} blueprint title`);
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

/** Steps sharing one dependency graph: ordinary tasks and call pipeline steps alike. */
interface DependentStep {
	ref: string;
	dependsOn?: string[];
}

function assertAcyclic(steps: DependentStep[]): void {
	const byRef = new Map(steps.map((step) => [step.ref, step]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (ref: string): void => {
		if (visiting.has(ref)) throw new Error(`step dependency cycle includes "${ref}"`);
		if (visited.has(ref)) return;
		visiting.add(ref);
		for (const dependency of byRef.get(ref)?.dependsOn ?? []) visit(dependency);
		visiting.delete(ref);
		visited.add(ref);
	};
	for (const step of steps) visit(step.ref);
}

function validateCallBlueprint(value: unknown): CallBlueprint {
	const source = record(value, "call blueprint");
	const ref = string(source.ref, "call blueprint ref");
	if (!NAME_PATTERN.test(ref)) throw new Error(`invalid blueprint ref "${ref}"`);
	const title = string(source.title, "call blueprint title");
	const targetId = string(source.targetId ?? source.skillId, "call blueprint targetId");
	return { ...source, ref, title, targetId } as CallBlueprint;
}

export function validateBlueprintDefinition(value: unknown): BlueprintDefinition {
	const source = record(value, "blueprint definition");
	if (source.version !== 1) throw new Error("blueprint definition version must be 1");
	const inputs = validateInputs(source.inputs);
	const rawBlueprints = record(source.blueprints, "blueprints");
	const docs = array(rawBlueprints.docs ?? [], "doc blueprints").map((entry) => validateBlueprint<DocBlueprint>(entry, "doc"));
	const rules = array(rawBlueprints.rules ?? [], "rule blueprints").map((entry) => validateBlueprint<RuleBlueprint>(entry, "rule"));
	const tasks = array(rawBlueprints.tasks ?? [], "task blueprints").map((entry) => validateBlueprint<TaskBlueprint>(entry, "task"));
	const calls = array(rawBlueprints.skills ?? [], "call blueprints").map(validateCallBlueprint);
	const all = [...docs, ...rules, ...tasks, ...calls];
	if (all.length === 0 || all.length > SKILL_MAX_BLUEPRINTS) throw new Error(`blueprints must contain 1-${SKILL_MAX_BLUEPRINTS} artifacts`);
	const refs = new Set<string>();
	for (const blueprint of all) {
		if (refs.has(blueprint.ref)) throw new Error(`duplicate blueprint ref "${blueprint.ref}"`);
		refs.add(blueprint.ref);
	}
	// Tasks and call pipeline steps share one dependency graph: a task may depend on a call ref
	// (meaning: depend on every task that nested run creates), and vice versa.
	const stepRefs = new Set<string>([...tasks.map((task) => task.ref), ...calls.map((call) => call.ref)]);
	for (const task of tasks) {
		if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new Error(`task "${task.ref}" dependsOn must be an array`);
		for (const dependency of task.dependsOn ?? []) {
			if (!stepRefs.has(dependency)) throw new Error(`unknown task dependency ref "${dependency}"`);
		}
		// parent stays task-only: containment under a call step's exploded task SET has no
		// single natural parent, so parent must name an actual task blueprint.
		if (task.parent !== undefined && !tasks.some((candidate) => candidate.ref === task.parent)) {
			throw new Error(`unknown task parent ref "${task.parent}"`);
		}
	}
	for (const call of calls) {
		if (call.dependsOn !== undefined && !Array.isArray(call.dependsOn)) throw new Error(`call "${call.ref}" dependsOn must be an array`);
		for (const dependency of call.dependsOn ?? []) {
			if (!stepRefs.has(dependency)) throw new Error(`unknown call dependency ref "${dependency}"`);
		}
		if (call.parent !== undefined && !tasks.some((candidate) => candidate.ref === call.parent)) {
			throw new Error(`unknown call parent ref "${call.parent}"`);
		}
	}
	assertAcyclic([...tasks, ...calls]);
	for (const name of placeholders(all)) {
		if (!Object.hasOwn(inputs, name)) throw new Error(`unknown input placeholder "${name}"`);
	}
	const links = array(source.links ?? [], "links").map((entry) => {
		const link = record(entry, "link");
		const from = string(link.from, "link from");
		const relation = string(link.relation, "link relation");
		const to = string(link.to, "link to");
		if (!refs.has(from)) throw new Error(`unknown blueprint ref "${from}"`);
		if (!refs.has(to)) throw new Error(`unknown blueprint ref "${to}"`);
		if (!RELATIONS.has(relation)) throw new Error(`unknown link relation "${relation}"`);
		return { from, relation, to };
	});
	if (links.length > SKILL_MAX_LINKS) throw new Error(`links exceed ${SKILL_MAX_LINKS}`);
	return { version: 1, inputs, blueprints: { docs, rules, tasks, skills: calls }, links };
}

export function resolveBlueprintArguments(definition: BlueprintDefinition, value: unknown): Record<string, BlueprintArgumentValue> {
	const source = record(value ?? {}, "arguments");
	for (const name of Object.keys(source)) {
		if (!Object.hasOwn(definition.inputs, name)) throw new Error(`unknown argument "${name}"`);
	}
	const result: Record<string, BlueprintArgumentValue> = {};
	for (const [name, input] of Object.entries(definition.inputs)) {
		const raw = source[name] ?? input.default;
		if (raw === undefined) {
			if (input.required) throw new Error(`missing required argument "${name}"`);
			continue;
		}
		const normalized = validateArgumentValue(name, input.type, raw);
		if (input.enum && !input.enum.includes(normalized)) {
			throw new Error(`argument "${name}" must be one of: ${input.enum.join(", ")}`);
		}
		result[name] = normalized;
	}
	return result;
}
