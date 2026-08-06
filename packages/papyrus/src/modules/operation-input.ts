/**
 * Shared runtime validators for a Vehicle operation's raw `input` object.
 * A Vehicle operation's own JSON-schema `input` field is descriptive metadata
 * only (see handlers/shared.ts's looseObjectSchema) -- never itself enforced
 * at runtime -- so every module's own operation body narrows `unknown` to
 * the real shape it needs through these.
 */
export type OperationInput = Record<string, unknown>;

export function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

export function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

export function optionalStringArray(input: OperationInput, key: string): string[] | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${key} must be an array of strings`);
	return value as string[];
}

export function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

export function optionalBoolean(input: OperationInput, key: string): boolean | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}
