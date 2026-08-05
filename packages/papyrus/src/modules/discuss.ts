/**
 * modules/discuss.ts — Discuss as a Papyrus-native registered module. See
 * domain/discussion.ts and discussion-service.ts for the full design.
 */

import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { Discussions } from "../discussion/discussion-service.ts";
import type { OperationDefinition } from "../module-registry.ts";
import { type OperationInput, optionalNumber, optionalString, optionalStringArray } from "./operation-input.ts";

const MODULE_ID = "discuss";

/** Fields whose name alone doesn't say what a valid value looks like -- everything else (title, content, id, settlement) is self-explanatory. */
const REQUIRED_FIELD_HINTS: Record<string, string> = {
	actor: 'a display name for who is posting, e.g. "alice" or "agent"',
};

/** Same contract as the shared string() in ./operation-input.ts, plus a field-specific hint on failure -- discuss's own operations are the one surface where a bare "actor is required" isn't self-explanatory. */
function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${key} is required${REQUIRED_FIELD_HINTS[key] ? ` (${REQUIRED_FIELD_HINTS[key]})` : ""}`);
	return value;
}

const eventContext = (input: OperationInput): ArtifactEventContext => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
});

function taskId(input: OperationInput): string {
	const value = optionalString(input, "task_id") ?? optionalString(input, "taskId");
	if (!value) throw new Error("task_id is required");
	return value;
}

function optionsMode(input: OperationInput): "single" | "multi" | undefined {
	const value = optionalString(input, "options_mode") ?? optionalString(input, "optionsMode");
	if (value === undefined) return undefined;
	if (value !== "single" && value !== "multi") throw new Error('options_mode must be "single" or "multi"');
	return value;
}

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const DISCUSS_OPERATION_NAMES = [
	"discuss.open",
	"discuss.reply",
	"discuss.defer",
	"discuss.resume",
	"discuss.settle",
	"discuss.block",
	"discuss.unblock",
	"discuss.show",
	"discuss.rounds",
	"discuss.list",
] as const;

/** Registers every discuss.* operation against one Discussions instance. */
export function discussOperations(discussions: Discussions): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("discuss.open", (input: OperationInput) =>
			discussions.open(
				{
					title: string(input, "title"),
					actor: string(input, "actor"),
					content: string(input, "content"),
					body: optionalString(input, "body"),
					labels: optionalStringArray(input, "labels"),
					blocksTaskIds: optionalStringArray(input, "blocks_task_ids") ?? optionalStringArray(input, "blocksTaskIds"),
					options: optionalStringArray(input, "options"),
					optionsMode: optionsMode(input),
					optionDescriptions: optionalStringArray(input, "option_descriptions") ?? optionalStringArray(input, "optionDescriptions"),
				},
				eventContext(input),
			),
		),
		define("discuss.reply", (input: OperationInput) =>
			discussions.reply(
				string(input, "id"),
				{
					actor: string(input, "actor"),
					content: string(input, "content"),
					selected: optionalStringArray(input, "selected"),
					options: optionalStringArray(input, "options"),
					optionsMode: optionsMode(input),
					optionDescriptions: optionalStringArray(input, "option_descriptions") ?? optionalStringArray(input, "optionDescriptions"),
				},
				eventContext(input),
			),
		),
		define("discuss.defer", (input: OperationInput) =>
			discussions.defer(string(input, "id"), optionalString(input, "reason"), eventContext(input)),
		),
		define("discuss.resume", (input: OperationInput) => discussions.resume(string(input, "id"), eventContext(input))),
		define("discuss.settle", (input: OperationInput) =>
			discussions.settle(string(input, "id"), string(input, "settlement"), eventContext(input)),
		),
		define("discuss.block", (input: OperationInput) => {
			discussions.block(string(input, "id"), taskId(input), eventContext(input));
			return { blocked: true };
		}),
		define("discuss.unblock", (input: OperationInput) => ({
			unblocked: discussions.unblock(string(input, "id"), taskId(input), eventContext(input)),
		})),
		define("discuss.show", (input: OperationInput) => discussions.show(string(input, "id"))),
		define("discuss.rounds", (input: OperationInput) =>
			discussions.listRounds(
				string(input, "id"),
				optionalNumber(input, "after_round") ?? optionalNumber(input, "afterRound"),
				optionalNumber(input, "limit"),
			),
		),
		define("discuss.list", (input: OperationInput) =>
			discussions.list({ state: optionalString(input, "state"), limit: optionalNumber(input, "limit") }),
		),
	];
}
