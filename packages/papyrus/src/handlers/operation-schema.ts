/**
 * Generic, domain-agnostic operation-input schema DSL, split out of handlers/shared.ts as part of
 * a SOLID-audit-driven decomposition (see Doc "Modularity playbook: building-block-shaped
 * TypeScript modules for papyrus/pi-papyrus" and the "handlers/shared.ts split" child of "Epic:
 * Modularize papyrus/pi-papyrus god-files into building-block modules"). Nothing here references
 * a specific Papyrus domain (tasks/docs/rules/...) -- a real candidate to eventually become its
 * own building block other Vehicle-backed daemons could reuse directly.
 */
import {
	defineVehicleSchema,
	type JsonSchema,
	VehicleError,
	type VehicleSchemaCodec,
	type VehicleSchemaIssue,
} from "@danypops/vehicle-core";

export interface OperationSchemaNode {
	readonly type?: string | readonly string[];
	readonly enum?: readonly unknown[];
	readonly properties?: Readonly<Record<string, OperationSchemaNode>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | OperationSchemaNode;
	/** A key not in `properties` is validated against the first pattern here whose RegExp matches it, instead of falling through to `additionalProperties` -- e.g. a free-form string-keyed map (tasks.create's checklist) uses `{"^.*$": entrySchema}` so a client-side JSON-Schema validator that reports `additionalProperties`-as-schema violations only as a generic top-level "must not have additional properties" (TypeBox's own real, confirmed behavior -- see vehicle-shell.ts's formatSchemaChildren for the matching tools_man rendering) instead descends into the real nested violation, matching an array's `items` precision. */
	readonly patternProperties?: Readonly<Record<string, OperationSchemaNode>>;
	readonly items?: OperationSchemaNode;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly description?: string;
	readonly [key: string]: unknown;
}

function schemaIssue(path: readonly (string | number)[], message: string): VehicleSchemaIssue[] {
	return [{ path, message }];
}

function matchesSchemaType(value: unknown, type: string): boolean {
	if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
	if (type === "array") return Array.isArray(value);
	if (type === "string") return typeof value === "string";
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "integer") return typeof value === "number" && Number.isInteger(value);
	if (type === "boolean") return typeof value === "boolean";
	return true;
}

function validateSchemaValue(value: unknown, schema: OperationSchemaNode, path: readonly (string | number)[]): VehicleSchemaIssue[] {
	const label = path.length === 0 ? "input" : String(path.at(-1));
	const declaredTypes = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
	const type = declaredTypes.find((candidate) => matchesSchemaType(value, candidate));
	if (declaredTypes.length > 0 && type === undefined) {
		const accepted = declaredTypes.map((candidate) =>
			candidate === "integer" ? "an integer" : `${candidate === "object" ? "an" : "a"} ${candidate}`,
		);
		return schemaIssue(path, `${label} must be ${accepted.join(" or ")}`);
	}
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return schemaIssue(path, `${label} must be an object`);
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				const acceptedShape = schema.description ? `; ${schema.description}` : "";
				return schemaIssue([...path, key], `${key} is required${acceptedShape}`);
			}
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (!(key in record)) continue;
			const issues = validateSchemaValue(record[key], child, [...path, key]);
			if (issues.length > 0) return issues;
		}
		for (const key of Object.keys(record)) {
			if (key in (schema.properties ?? {})) continue;
			const patternMatch = Object.entries(schema.patternProperties ?? {}).find(([pattern]) => new RegExp(pattern).test(key));
			if (patternMatch) {
				const issues = validateSchemaValue(record[key], patternMatch[1], [...path, key]);
				if (issues.length > 0) return issues;
				continue;
			}
			if (schema.additionalProperties === false) return schemaIssue([...path, key], `${key} is not allowed`);
			if (typeof schema.additionalProperties === "object") {
				const issues = validateSchemaValue(record[key], schema.additionalProperties, [...path, key]);
				if (issues.length > 0) return issues;
			}
		}
	} else if (type === "array") {
		const entries = value as unknown[];
		if (schema.minItems !== undefined && entries.length < schema.minItems) {
			return schemaIssue(path, `${label} must contain at least ${schema.minItems} item(s)`);
		}
		if (schema.maxItems !== undefined && entries.length > schema.maxItems) {
			return schemaIssue(path, `${label} cannot contain more than ${schema.maxItems} item(s)`);
		}
		if (schema.items) {
			for (const [index, entry] of entries.entries()) {
				const issues = validateSchemaValue(entry, schema.items, [...path, index]);
				if (issues.length > 0) return issues;
			}
		}
	} else if (type === "string") {
		const text = value as string;
		if (schema.minLength !== undefined && text.length < schema.minLength) {
			return schemaIssue(path, `${label} must contain at least ${schema.minLength} character(s)`);
		}
		if (schema.maxLength !== undefined && text.length > schema.maxLength) {
			return schemaIssue(path, `${label} cannot exceed ${schema.maxLength} character(s)`);
		}
	} else if (type === "number" || type === "integer") {
		const number = value as number;
		if (schema.minimum !== undefined && number < schema.minimum) {
			return schemaIssue(path, `${label} must be at least ${schema.minimum}`);
		}
		if (schema.maximum !== undefined && number > schema.maximum) {
			return schemaIssue(path, `${label} cannot exceed ${schema.maximum}`);
		}
	}
	if (schema.enum && !schema.enum.includes(value)) {
		return schemaIssue(path, `${label} must be one of ${schema.enum.join(", ")}`);
	}
	return [];
}

/** VehicleRegistry executes this codec before resolving or dispatching an operation. Keep the
 * recursive runtime checks aligned with the same JSON Schema clients and tools_man receive. */
export function looseObjectSchema(
	properties: Readonly<Record<string, OperationSchemaNode>>,
	required: readonly string[] = [],
): VehicleSchemaCodec<Record<string, unknown>> {
	const schema = { type: "object", properties, required: [...required], additionalProperties: false } as const;
	return defineVehicleSchema<Record<string, unknown>>({
		jsonSchema: schema as unknown as JsonSchema,
		safeParse(value) {
			const issues = validateSchemaValue(value, schema, []);
			return issues.length > 0 ? { success: false, issues } : { success: true, value: value as Record<string, unknown> };
		},
	});
}

export const passthroughOutput: VehicleSchemaCodec<unknown> = defineVehicleSchema<unknown>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value }),
});

export const stringProp = { type: "string" } as const;
export const numberProp = { type: "number" } as const;
export const booleanProp = { type: "boolean" } as const;

/**
 * A plain `throw new Error(...)` inside any resolve()/execute() step here is caught by
 * vehicle-registry.ts's generic dispatch and re-wrapped as VehicleError("handler-failed",
 * `${key} handler failed`, {category: "internal"}) -- built to catch a genuine crash, but
 * it can't distinguish that from an ordinary, expected validation/lookup failure, so it
 * discards the original message and category either way. Every guard clause and name
 * resolution below must throw a VehicleError directly so it passes through that dispatch
 * unchanged (vehicle-registry.ts only rewraps errors that are NOT already a VehicleError).
 */
export function validationError(message: string): VehicleError {
	return new VehicleError("validation-failed", message, { category: "validation" });
}
