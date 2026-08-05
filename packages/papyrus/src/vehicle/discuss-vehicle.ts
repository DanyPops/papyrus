/**
 * Discuss projected as a real VehicleRegistry: one VehicleOperation per real
 * action, the last of the six domains (notes/rules/docs/skills/playbooks/tasks
 * already done) to leave pi-papyrus's own hand-rolled pi.registerTool().
 *
 * open/reply get a `content` block AND keep their full {discussion, rounds}
 * output shape -- vehicle-client-pi's own interactiveFollowUps hook (see
 * registerDiscussVehicleTools in pi-papyrus) reads `rounds[0].content` off
 * this exact output to drive the optional live human round-trip, the same
 * way the retired tool's own liveAnswer() did.
 *
 * Wraps modules/discuss.ts's operation definitions -- the raw RPC dispatch
 * (service.ts's moduleRegistry) stays registered unchanged for pi-papyrus's
 * own /discuss TUI, which never went through the retired mega-tool.
 */
import { bindVehicleOperation, defineVehicleOperation, type VehicleContentBlock } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { DiscussionAndRounds, Discussions } from "../discussion-service.ts";
import type { Artifact } from "../domain/artifact.ts";
import { DISCUSSION_SUBTYPE, type DiscussionRound } from "../domain/discussion.ts";
import { discussOperations } from "../modules/discuss.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import {
	looseObjectSchema,
	numberProp,
	passthroughOutput,
	resolveArtifactIdWidened,
	stringProp,
	validationError,
} from "./artifact-vehicle-shared.ts";

const OWNER = "discuss";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };
const arrayProp = { type: "array" } as const;
/** Purely a client-side hint (see vehicle-client-pi's interactiveFollowUps) -- never read server-side, but must still be declared or the schema's additionalProperties:false rejects it outright. */
const boolProp = { type: "boolean" } as const;

function artifactLine(artifact: Artifact): string {
	return `[${artifact.status}] ${artifact.title}`;
}

function roundsTranscript(rounds: readonly DiscussionRound[]): string {
	return rounds.map((round) => `  [round ${round.roundNumber}] ${round.actor}: ${round.content}`).join("\n") || "  (no rounds)";
}

/**
 * Resolves a discussion's id from either an explicit id or its exact title.
 * Discussions.list() has no project-scoping concept at all (unlike Tasks),
 * so there is no widened retry to attempt -- one unscoped candidate set is
 * the whole search space already.
 */
function resolveDiscussionId(artifacts: ArtifactStore, discussions: Discussions, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	return resolveArtifactIdWidened(artifacts, name, () => discussions.list({}));
}

/**
 * Resolves a real Task's id from its title, excluding Discussion rows
 * (kind=task, subtype=discussion) from the candidate set -- a Discussion and
 * a Task can otherwise share a title with no way to tell them apart. Unscoped
 * (matches rules.gate's own precedent in rules-vehicle.ts), since neither
 * blocks_task_names nor task_name here carry a project_root to scope by.
 */
function resolveRealTaskId(artifacts: ArtifactStore, id: unknown, name: unknown): string | undefined {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) return undefined;
	return resolveArtifactIdWidened(artifacts, name, () => artifacts.query({ kind: "task", excludeSubtype: DISCUSSION_SUBTYPE, text: name }));
}

function resolveRealTaskIds(artifacts: ArtifactStore, ids: unknown, names: unknown): string[] | undefined {
	if (Array.isArray(ids)) return ids as string[];
	if (!Array.isArray(names) || names.length === 0) return undefined;
	return names.map((entry) => {
		const resolved = resolveRealTaskId(artifacts, undefined, String(entry));
		if (!resolved) throw validationError(`no task named "${entry}" found`);
		return resolved;
	});
}

/**
 * Normalizes `options` from the model-friendly union (a bare string, or
 * {title, description} for a real tradeoff worth spelling out) into the two
 * parallel arrays discussions.open()/reply() actually expect -- ported
 * verbatim from the retired tool's own normalizeDiscussOptions. Mutates
 * input in place.
 */
function normalizeOptions(input: Record<string, unknown>): void {
	const raw = input.options;
	if (!Array.isArray(raw)) return;
	const titles: string[] = [];
	const descriptions: string[] = [];
	let anyDescription = false;
	for (const entry of raw) {
		if (typeof entry === "string") {
			titles.push(entry);
			descriptions.push("");
			continue;
		}
		if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).title === "string") {
			const record = entry as Record<string, unknown>;
			titles.push(record.title as string);
			const description = typeof record.description === "string" ? record.description : "";
			if (description) anyDescription = true;
			descriptions.push(description);
			continue;
		}
		titles.push(String(entry));
		descriptions.push("");
	}
	input.options = titles;
	if (anyDescription) input.option_descriptions = descriptions;
}

/** Matches the retired tool's own convention: an agent-driven open/reply with no explicit human actor still needs a real, non-generic audit-trail label. */
function defaultActorToAgent(input: Record<string, unknown>): void {
	if (typeof input.actor !== "string" || input.actor.length === 0) input.actor = "agent";
}

const optionsUnionSchema = { type: "array" } as const;

export function registerDiscussVehicleOperations(registry: VehicleRegistry, discussions: Discussions, artifacts: ArtifactStore): void {
	const moduleOperations = new Map(discussOperations(discussions).map((op) => [op.name, op]));
	const call = <Output>(name: string, input: Record<string, unknown>): Output => moduleOperations.get(name)!.execute(input) as Output;

	const define = (
		action: string,
		description: string,
		effect: "read" | "local-write",
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
		wrap: (raw: unknown, resolvedInput: Record<string, unknown>) => unknown = (raw) => raw,
	): void => {
		const operation = defineVehicleOperation({
			name: `discuss.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["discuss:read", "discuss:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => {
				const resolvedInput = resolve({ ...(context.input as Record<string, unknown>) });
				const raw = call(`discuss.${action}`, resolvedInput);
				return wrap(raw, resolvedInput);
			}),
		);
	};

	const contentBlock = (text: string): VehicleContentBlock => ({ type: "text", text });

	define(
		"open",
		"Opens a new Discussion and starts round 1. Optionally poses a structured choice via options (2-10 entries) + options_mode ('single' mutually exclusive, 'multi' allows several) -- each option a bare string (self-evident) or {title, description} (a real tradeoff worth spelling out; description REQUIRED once there are 3+ options). Optionally blocks one or more Tasks immediately via blocks_task_ids/blocks_task_names. Pass live:true to get a human's answer synchronously in this same call, via an interactive prompt -- only takes effect with an interactive UI available, otherwise degrades silently to the normal durably-recorded round.",
		"local-write",
		{
			title: stringProp,
			actor: stringProp,
			content: stringProp,
			body: stringProp,
			labels: arrayProp,
			blocks_task_ids: arrayProp,
			blocks_task_names: arrayProp,
			options: optionsUnionSchema,
			options_mode: { type: "string", enum: ["single", "multi"] },
			option_descriptions: arrayProp,
			live: boolProp,
		},
		["title", "content"],
		(input) => {
			normalizeOptions(input);
			defaultActorToAgent(input);
			const blocksTaskIds = resolveRealTaskIds(artifacts, input.blocks_task_ids, input.blocks_task_names);
			return { ...input, ...(blocksTaskIds ? { blocks_task_ids: blocksTaskIds } : {}) };
		},
		(raw) => {
			const result = raw as DiscussionAndRounds;
			return { ...result, content: [contentBlock(`Opened discussion ${artifactLine(result.discussion)}`)] };
		},
	);

	define(
		"reply",
		"Adds a round to an existing Discussion. Refused once deferred or settled -- resume first. Answers a currently pending posed choice via `selected` (validated against it), or poses a new choice via options/options_mode. Prefer `name` over `id`. Pass live:true to get a human's answer synchronously in this same call, via the pending choice's picker if one was posed, otherwise a freeform question -- only takes effect with an interactive UI available, otherwise degrades silently to the normal durably-recorded round.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			actor: stringProp,
			content: stringProp,
			selected: arrayProp,
			options: optionsUnionSchema,
			options_mode: { type: "string", enum: ["single", "multi"] },
			option_descriptions: arrayProp,
			live: boolProp,
		},
		["content"],
		(input) => {
			normalizeOptions(input);
			defaultActorToAgent(input);
			return { ...input, id: resolveDiscussionId(artifacts, discussions, input.id, input.name) };
		},
		(raw) => {
			const result = raw as DiscussionAndRounds;
			return {
				...result,
				content: [contentBlock(`Round ${result.rounds[0]?.roundNumber} added to "${result.discussion.title}"`)],
			};
		},
	);

	define(
		"defer",
		"Pauses a Discussion without settling it -- explicitly non-blocking, resumable later via resume.",
		"local-write",
		{ id: stringProp, name: stringProp, reason: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveDiscussionId(artifacts, discussions, input.id, input.name) }),
		(raw) => {
			const artifact = raw as Artifact;
			return { ...artifact, content: [contentBlock(artifactLine(artifact))] };
		},
	);

	define(
		"resume",
		"Resumes a deferred Discussion back to active.",
		"local-write",
		{ id: stringProp, name: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		[],
		(input) => ({ ...input, id: resolveDiscussionId(artifacts, discussions, input.id, input.name) }),
		(raw) => {
			const artifact = raw as Artifact;
			return { ...artifact, content: [contentBlock(artifactLine(artifact))] };
		},
	);

	define(
		"settle",
		"Settles a Discussion -- terminal, archives it. A settled Discussion can never be replied to or resumed again.",
		"local-write",
		{ id: stringProp, name: stringProp, settlement: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["settlement"],
		(input) => ({ ...input, id: resolveDiscussionId(artifacts, discussions, input.id, input.name) }),
		(raw) => {
			const artifact = raw as Artifact;
			return { ...artifact, content: [contentBlock(artifactLine(artifact))] };
		},
	);

	define(
		"block",
		"Blocks a Task's completion until this Discussion is settled or deferred. Prefer name/task_name over id/task_id.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			task_id: stringProp,
			task_name: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const discussionId = resolveDiscussionId(artifacts, discussions, input.id, input.name);
			const taskId = resolveRealTaskId(artifacts, input.task_id, input.task_name);
			if (!taskId) throw validationError("task_id or task_name is required");
			return { ...input, id: discussionId, task_id: taskId };
		},
		(_raw, resolvedInput) => {
			const discussion = discussions.show(resolvedInput.id as string).discussion;
			const task = artifacts.get(resolvedInput.task_id as string);
			const message = `"${discussion.title}" now blocks "${task?.title ?? resolvedInput.task_id}"`;
			return { blocked: true, content: [contentBlock(message)] };
		},
	);

	define(
		"unblock",
		"Removes a blocking relationship between this Discussion and a Task -- idempotent, a no-op if the edge is already absent. Prefer name/task_name over id/task_id.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			task_id: stringProp,
			task_name: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
		},
		[],
		(input) => {
			const discussionId = resolveDiscussionId(artifacts, discussions, input.id, input.name);
			const taskId = resolveRealTaskId(artifacts, input.task_id, input.task_name);
			if (!taskId) throw validationError("task_id or task_name is required");
			return { ...input, id: discussionId, task_id: taskId };
		},
		(raw, resolvedInput) => {
			const unblocked = (raw as { unblocked: boolean }).unblocked;
			const discussion = discussions.show(resolvedInput.id as string).discussion;
			const task = artifacts.get(resolvedInput.task_id as string);
			const message = unblocked
				? `"${discussion.title}" no longer blocks "${task?.title ?? resolvedInput.task_id}"`
				: "No such blocking relationship.";
			return { unblocked, content: [contentBlock(message)] };
		},
	);

	define(
		"show",
		"Shows a Discussion's full transcript (every round). Prefer name over id.",
		"read",
		{ id: stringProp, name: stringProp },
		[],
		(input) => ({ ...input, id: resolveDiscussionId(artifacts, discussions, input.id, input.name) }),
		(raw) => {
			const result = raw as DiscussionAndRounds;
			return { ...result, content: [contentBlock(`${artifactLine(result.discussion)}\n\n${roundsTranscript(result.rounds)}`)] };
		},
	);

	define(
		"rounds",
		"Lists a Discussion's rounds, optionally after a given round number. Prefer name over id.",
		"read",
		{ id: stringProp, name: stringProp, after_round: numberProp, limit: numberProp },
		[],
		(input) => ({ ...input, id: resolveDiscussionId(artifacts, discussions, input.id, input.name) }),
		(raw) => {
			const rounds = raw as DiscussionRound[];
			return { rounds, content: [contentBlock(roundsTranscript(rounds))] };
		},
	);

	define(
		"list",
		"Lists Discussions, optionally filtered by state (active/deferred/settled).",
		"read",
		{ state: { type: "string", enum: ["active", "deferred", "settled"] }, limit: numberProp },
		[],
		(input) => input,
		(raw) => {
			const rows = raw as Artifact[];
			const text = rows.length ? rows.map((row) => artifactLine(row)).join("\n") : "No discussions found.";
			return { discussions: rows, content: [contentBlock(text)] };
		},
	);
}
