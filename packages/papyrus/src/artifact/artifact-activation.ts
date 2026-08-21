export const ACTIVATION_MAX_DEPTH = 8;
export const ACTIVATION_MAX_NODES = 64;
export const ACTIVATION_MAX_VALUES = 32;
export const ACTIVATION_VALUE_MAX_LENGTH = 256;

export const ACTIVATION_FIELDS = [
	"project.root",
	"task.status",
	"task.labels",
	"languages",
	"file.extensions",
	"tool.name",
	"operation.name",
	"session.capabilities",
] as const;
export type ActivationField = (typeof ACTIVATION_FIELDS)[number];

export const ACTIVATION_OPERATORS = ["eq", "in", "contains_any", "contains_all", "exists"] as const;
export type ActivationOperator = (typeof ACTIVATION_OPERATORS)[number];
export type InjectionProfile = "full" | "catalog" | "on-demand";

export type ActivationPredicate =
	| { field: ActivationField; operator: ActivationOperator; value: string | string[] | boolean }
	| { all: ActivationPredicate[] }
	| { any: ActivationPredicate[] }
	| { not: ActivationPredicate };

export interface ActivationConfig {
	predicate?: ActivationPredicate;
	priority: number;
	injection: InjectionProfile;
	invalid?: true;
}

export interface ActivationContext {
	projectRoot?: string;
	taskStatus?: string;
	taskLabels?: string[];
	languages?: string[];
	fileExtensions?: string[];
	toolName?: string;
	operationName?: string;
	sessionCapabilities?: string[];
}

export interface ActivationDecision {
	enabled: boolean;
	reason: string;
}

function optionalContextString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : boundedString(value, label);
}

function optionalContextStrings(value: unknown, label: string): string[] | undefined {
	return value === undefined ? undefined : stringValues(value, label);
}

/** Parses caller-supplied activation signals. Project and active-Task fields are supplied server-side and intentionally cannot be spoofed through this object. */
export function activationContextFromInput(value: unknown): ActivationContext {
	if (value === undefined) return {};
	const input = record(value, "activation_context");
	if (
		!Object.keys(input).every((key) =>
			["languages", "file_extensions", "tool_name", "operation_name", "session_capabilities"].includes(key),
		)
	) {
		throw new Error("activation_context contains an unsupported field");
	}
	return {
		languages: optionalContextStrings(input.languages, "activation_context.languages"),
		fileExtensions: optionalContextStrings(input.file_extensions, "activation_context.file_extensions"),
		toolName: optionalContextString(input.tool_name, "activation_context.tool_name"),
		operationName: optionalContextString(input.operation_name, "activation_context.operation_name"),
		sessionCapabilities: optionalContextStrings(input.session_capabilities, "activation_context.session_capabilities"),
	};
}

const fieldSet = new Set<string>(ACTIVATION_FIELDS);
const operatorSet = new Set<string>(ACTIVATION_OPERATORS);
const arrayFields = new Set<ActivationField>(["task.labels", "languages", "file.extensions", "session.capabilities"]);

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > ACTIVATION_VALUE_MAX_LENGTH) {
		throw new Error(`${label} must be a string between 1 and ${ACTIVATION_VALUE_MAX_LENGTH} characters`);
	}
	return value;
}

function stringValues(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > ACTIVATION_MAX_VALUES) {
		throw new Error(`${label} must contain 1-${ACTIVATION_MAX_VALUES} strings`);
	}
	return value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
}

interface ValidationState {
	nodes: number;
}

function validatePredicate(value: unknown, state: ValidationState, depth: number): ActivationPredicate {
	if (depth > ACTIVATION_MAX_DEPTH) throw new Error(`activation predicate depth cannot exceed ${ACTIVATION_MAX_DEPTH}`);
	state.nodes++;
	if (state.nodes > ACTIVATION_MAX_NODES) throw new Error(`activation predicate cannot exceed ${ACTIVATION_MAX_NODES} nodes`);
	const input = record(value, "activation predicate");
	const keys = Object.keys(input);
	if (keys.length === 1 && keys[0] === "all") {
		if (!Array.isArray(input.all) || input.all.length === 0) throw new Error("activation all must be a non-empty array");
		return { all: input.all.map((entry) => validatePredicate(entry, state, depth + 1)) };
	}
	if (keys.length === 1 && keys[0] === "any") {
		if (!Array.isArray(input.any) || input.any.length === 0) throw new Error("activation any must be a non-empty array");
		return { any: input.any.map((entry) => validatePredicate(entry, state, depth + 1)) };
	}
	if (keys.length === 1 && keys[0] === "not") return { not: validatePredicate(input.not, state, depth + 1) };
	if (!keys.every((key) => key === "field" || key === "operator" || key === "value")) {
		throw new Error("activation predicate must be exactly one all/any/not group or one field/operator/value test");
	}
	const field = boundedString(input.field, "activation field");
	if (!fieldSet.has(field)) throw new Error(`unsupported activation field "${field}"`);
	const operator = boundedString(input.operator, "activation operator");
	if (!operatorSet.has(operator)) throw new Error(`unsupported activation operator "${operator}"`);
	const typedField = field as ActivationField;
	const typedOperator = operator as ActivationOperator;
	let typedValue: string | string[] | boolean;
	if (typedOperator === "exists") {
		if (typeof input.value !== "boolean") throw new Error("activation exists value must be a boolean");
		typedValue = input.value;
	} else if (typedOperator === "eq") {
		typedValue = boundedString(input.value, "activation eq value");
	} else {
		typedValue = stringValues(input.value, `activation ${typedOperator} value`);
	}
	if ((typedOperator === "contains_any" || typedOperator === "contains_all") && !arrayFields.has(typedField)) {
		throw new Error(`activation operator ${typedOperator} requires an array-valued field`);
	}
	return { field: typedField, operator: typedOperator, value: typedValue };
}

export function validateActivationConfig(value: unknown, defaultInjection: InjectionProfile = "full"): ActivationConfig {
	const input = record(value, "activation");
	if (!Object.keys(input).every((key) => key === "predicate" || key === "priority" || key === "injection")) {
		throw new Error("activation supports only predicate, priority, and injection");
	}
	const priority = input.priority === undefined ? 0 : input.priority;
	if (!Number.isInteger(priority) || (priority as number) < -1000 || (priority as number) > 1000) {
		throw new Error("activation priority must be an integer between -1000 and 1000");
	}
	const injection = input.injection === undefined ? defaultInjection : input.injection;
	if (injection !== "full" && injection !== "catalog" && injection !== "on-demand") {
		throw new Error("activation injection must be full, catalog, or on-demand");
	}
	return {
		...(input.predicate === undefined ? {} : { predicate: validatePredicate(input.predicate, { nodes: 0 }, 1) }),
		priority: priority as number,
		injection,
	};
}

export function activationConfig(extra: Record<string, unknown>, defaultInjection: InjectionProfile = "full"): ActivationConfig {
	if (extra.activation === undefined) return { priority: 0, injection: defaultInjection };
	try {
		return validateActivationConfig(extra.activation, defaultInjection);
	} catch {
		return { priority: 0, injection: defaultInjection, invalid: true };
	}
}

function contextValue(field: ActivationField, context: ActivationContext): string | string[] | undefined {
	switch (field) {
		case "project.root":
			return context.projectRoot;
		case "task.status":
			return context.taskStatus;
		case "task.labels":
			return context.taskLabels;
		case "languages":
			return context.languages;
		case "file.extensions":
			return context.fileExtensions;
		case "tool.name":
			return context.toolName;
		case "operation.name":
			return context.operationName;
		case "session.capabilities":
			return context.sessionCapabilities;
	}
}

function evaluatePredicate(predicate: ActivationPredicate, context: ActivationContext): ActivationDecision {
	if ("all" in predicate) {
		for (const child of predicate.all) {
			const decision = evaluatePredicate(child, context);
			if (!decision.enabled) return decision;
		}
		return { enabled: true, reason: "enabled" };
	}
	if ("any" in predicate) {
		const decisions = predicate.any.map((child) => evaluatePredicate(child, context));
		if (decisions.some((decision) => decision.enabled)) return { enabled: true, reason: "enabled" };
		return { enabled: false, reason: decisions[0]?.reason ?? "activation any did not match" };
	}
	if ("not" in predicate) {
		const decision = evaluatePredicate(predicate.not, context);
		return decision.enabled ? { enabled: false, reason: "activation not matched" } : { enabled: true, reason: "enabled" };
	}
	const actual = contextValue(predicate.field, context);
	if (predicate.operator === "exists") {
		const exists = actual !== undefined && (!Array.isArray(actual) || actual.length > 0);
		return exists === predicate.value
			? { enabled: true, reason: "enabled" }
			: { enabled: false, reason: `activation ${predicate.field} existence did not match` };
	}
	if (actual === undefined) return { enabled: false, reason: `activation context field ${predicate.field} is unavailable` };
	const actualValues = Array.isArray(actual) ? actual : [actual];
	if (predicate.operator === "eq") {
		return actualValues.includes(predicate.value as string)
			? { enabled: true, reason: "enabled" }
			: { enabled: false, reason: `activation ${predicate.field} did not equal ${predicate.value as string}` };
	}
	const expected = predicate.value as string[];
	const matches =
		predicate.operator === "contains_all"
			? expected.every((entry) => actualValues.includes(entry))
			: expected.some((entry) => actualValues.includes(entry));
	return matches
		? { enabled: true, reason: "enabled" }
		: { enabled: false, reason: `activation ${predicate.field} did not match ${predicate.operator}` };
}

export function evaluateActivation(config: ActivationConfig, context: ActivationContext): ActivationDecision {
	if (config.invalid) return { enabled: false, reason: "invalid activation configuration" };
	if (config.injection === "on-demand") return { enabled: false, reason: "activation injection profile is on-demand" };
	return config.predicate === undefined ? { enabled: true, reason: "enabled" } : evaluatePredicate(config.predicate, context);
}
