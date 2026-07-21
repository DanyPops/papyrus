/**
 * modules/notes.ts — Notes as the first Papyrus-native registered module
 * (step 5 of the incremental refactor in reducing-papyrus-consumer-change-amplification-with-modules--pvdo,
 * combined with step 1 for a real proof-of-shape rather than an empty abstraction).
 *
 * Notes was chosen first because it owns no bespoke schema (it reuses the generic doc
 * table via NOTE_SUBTYPE) and has exactly six operations — the smallest real module to
 * prove the OperationRegistry shape against before extracting Tasks or Docs.
 *
 * This module does not import another module's infrastructure (src/task-service.ts,
 * src/domain-services.ts, etc.) — only its own src/note-service.ts and the shared
 * OperationInput parsing helpers, matching the "module code does not import another
 * module's infrastructure" constraint.
 */
import type { OperationDefinition } from "../module-registry.ts";
import { Notes, type NoteDisposition } from "../note-service.ts";

const MODULE_ID = "notes";

type OperationInput = Record<string, unknown>;

function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const NOTES_OPERATION_NAMES = [
	"notes.capture", "notes.list", "notes.show", "notes.consume", "notes.promote", "notes.archive",
] as const;

/** Registers every notes.* operation against one Notes instance. Behavior is unchanged from the prior inline handlers in src/service.ts. */
export function notesOperations(notes: Notes): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("notes.capture", (input: OperationInput) => notes.capture({
			body: string(input, "body"), title: optionalString(input, "title"), projectRoot: string(input, "project_root"),
			actor: optionalString(input, "actor"), source: optionalString(input, "source"), sessionId: optionalString(input, "session_id"),
		})),
		define("notes.list", (input: OperationInput) => notes.list({
			projectRoot: string(input, "project_root"), status: optionalString(input, "status") as "draft" | "active" | "archived" | undefined,
			text: optionalString(input, "text"), limit: optionalNumber(input, "limit"),
		})),
		define("notes.show", (input: OperationInput) => notes.show(string(input, "id"), string(input, "project_root"))),
		define("notes.consume", (input: OperationInput) => notes.consume(string(input, "id"), {
			projectRoot: string(input, "project_root"), actor: optionalString(input, "actor"), source: optionalString(input, "source"),
			sessionId: optionalString(input, "session_id"), reason: optionalString(input, "reason"),
		})),
		define("notes.promote", (input: OperationInput) => notes.promote(string(input, "id"), string(input, "target_id"), {
			projectRoot: string(input, "project_root"), actor: optionalString(input, "actor"), source: optionalString(input, "source"),
			sessionId: optionalString(input, "session_id"), reason: optionalString(input, "reason"),
		})),
		define("notes.archive", (input: OperationInput) => notes.archive(string(input, "id"), {
			projectRoot: string(input, "project_root"), disposition: string(input, "disposition") as NoteDisposition,
			actor: optionalString(input, "actor"), source: optionalString(input, "source"), sessionId: optionalString(input, "session_id"),
			reason: optionalString(input, "reason"),
		})),
	];
}
