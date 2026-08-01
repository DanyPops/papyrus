import { type Artifact, type DiscussionAndRounds, type DiscussionRound, type OperationName, readDiscussionExtra } from "@danypops/papyrus";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askQuestion } from "./discuss-ask-view.ts";
import { callService } from "./service-client.ts";
import { renderPapyrusToolCall, renderPapyrusToolResult } from "./tool-rendering/index.ts";
import {
	createArtifactDetails,
	createArtifactListDetails,
	createModelContent,
	createPreviewDetails,
} from "./tool-rendering/render-model.ts";

function text(message: string, details: unknown = {}) {
	const modelContent = createModelContent(message);
	return { content: [{ type: "text" as const, text: modelContent.text }], details };
}

/**
 * live:true's synchronous half: reuses the same Discuss-owned ask UI (discuss-ask-view.ts) the
 * /discuss TUI's own "Reply" action uses when the just-created round posed a structured choice,
 * or a plain freeform prompt otherwise -- so "ask" covers both a completely open question and a
 * choice tied to this specific Discussion. Returns undefined on cancel or when no interactive UI
 * is available, never throws -- an unanswered live prompt still leaves the round it already
 * recorded intact.
 */
/**
 * The discuss tool accepts each option as either a bare string (self-evident choices) or
 * {title, description} (a real tradeoff worth spelling out) -- normalizes to the two parallel
 * arrays discuss.open/discuss.reply actually expect (options: string[], option_descriptions:
 * string[], index-aligned, empty string meaning "none for this one"). Mutates params in place.
 */
function normalizeDiscussOptions(params: Record<string, unknown>): void {
	const raw = params.options;
	if (!Array.isArray(raw)) return;
	let anyDescription = false;
	const titles: string[] = [];
	const descriptions: string[] = [];
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
	params.options = titles;
	if (anyDescription) params.option_descriptions = descriptions;
}

async function liveAnswer(
	ctx: ExtensionContext,
	discussion: Artifact,
	latestContent: string | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	signal: AbortSignal | undefined,
): Promise<{ content: string; selected?: string[] } | undefined> {
	if (!ctx.hasUI) return undefined;
	const pending = (() => {
		try {
			return readDiscussionExtra(discussion.extra);
		} catch {
			return undefined;
		}
	})();
	// The just-recorded round's own content IS the real question -- a generic "Reply to <title>:"
	// wrapper as the primary question, with the real content demoted to "Context:", left a human
	// staring at a labeled-backwards prompt (live-observed). The wrapper is now only a fallback for
	// the degenerate case of empty content; the title becomes a plain orientation subtitle instead.
	const question = latestContent?.trim() || `Reply to "${discussion.title}":`;
	const subtitle = discussion.title;
	if (pending?.pendingOptions && pending.pendingOptions.length > 0 && pending.pendingOptionsMode) {
		return askQuestion(ctx, {
			question,
			subtitle,
			options: pending.pendingOptions.map((title, index) => ({
				title,
				description: pending.pendingOptionDescriptions?.[index] || undefined,
			})),
			allowMultiple: pending.pendingOptionsMode === "multi",
			onUpdate,
			signal,
		});
	}
	return askQuestion(ctx, { question, subtitle, onUpdate, signal });
}

/**
 * Every domain tool's primary interfacing point is an artifact's NAME, not its id -- id is a
 * backend implementation detail (a stable key other operations need, and titles aren't
 * guaranteed unique), so it stays out of what the model reads by default. It only resurfaces
 * when genuinely needed to tell two same-titled artifacts apart (artifactLines below), or in a
 * matchArtifactByName disambiguation error, never as a matter of course.
 */
export function artifactLine(artifact: Artifact): string {
	return `[${artifact.status}] ${artifact.title}`;
}

/** Appends " (id)" only for artifacts whose title collides with another in this same result set. */
export function artifactLines(artifacts: Artifact[]): string[] {
	const titleCounts = new Map<string, number>();
	for (const artifact of artifacts) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return artifacts.map((artifact) =>
		titleCounts.get(artifact.title)! > 1 ? `${artifactLine(artifact)} (${artifact.id})` : artifactLine(artifact),
	);
}

/**
 * Exact, case-insensitive, trimmed title match against an already-fetched candidate set. Throws
 * a clear "not found" or "ambiguous -- use id" error rather than guessing at a fuzzy match -- id
 * remains the one truly unambiguous key, so ambiguity is exactly where it's allowed to resurface.
 * Pure and synchronous so it's directly testable without a service round-trip.
 */
export function matchArtifactByName(candidates: Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) throw new Error(`no artifact named "${name}" found in this scope`);
	if (matches.length > 1) {
		throw new Error(
			`${matches.length} artifacts are named "${name}": ${matches.map((artifact) => `${artifact.title} (${artifact.id})`).join(", ")} -- use id to disambiguate`,
		);
	}
	return matches[0]!.id;
}

/**
 * tasks.list is the one list operation that requires `project_root` and separately supports a
 * `scope` ("project" | "graph" | "all") to widen or narrow the search. Every other list operation
 * (docs.list, rules.list, playbooks.list, artifact.query, ...) instead treats an
 * omitted `project_root` as an unscoped/global search (domain-services.ts's listScoped) and has
 * no `scope` concept at all -- so "search everywhere" means something different for each.
 */
const SCOPE_AWARE_LIST_OPERATIONS = new Set<OperationName>(["tasks.list"]);

/** The widened-scope request tried once when a name isn't found under the caller's current scope. */
function widenedRequest(listOperation: OperationName, baseRequest: Record<string, unknown>): Record<string, unknown> {
	return SCOPE_AWARE_LIST_OPERATIONS.has(listOperation) ? { ...baseRequest, scope: "all" } : { ...baseRequest, project_root: undefined };
}

/**
 * Resolves a name to its id via `listOperation` (whichever kind's list call is the right search
 * scope -- tasks.list, docs.list, rules.list, playbooks.list, notes.list, discuss.list, or the
 * kind-agnostic artifact.query for a cross-kind reference like a link target). `baseRequest`
 * should mirror whatever scoping (project_root, etc.) that operation's own "list" action already
 * uses, so resolution never searches a wider or narrower scope than a plain list call would.
 *
 * A two-artifact action (depend/contain/gate/link) routinely names artifacts that live in two
 * different projects, and one call has no way to give two different name fields two different
 * scopes. When the first lookup finds nothing under the caller's current scope, retry exactly
 * once against a global search before giving up -- but never when the caller already pinned an
 * explicit `scope`, so a genuine "not found in the scope I asked for" stays a real error instead
 * of being silently papered over. `notes`, when given, records that a name only resolved after
 * widening, so the caller can surface that a search went wider than the caller's default scope
 * rather than resolving silently.
 */
async function resolveArtifactIdByName(
	listOperation: OperationName,
	baseRequest: Record<string, unknown>,
	name: string,
	notes?: string[],
): Promise<string> {
	const candidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, { ...baseRequest, text: name });
	try {
		return matchArtifactByName(candidates, name);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("no artifact named") || baseRequest.scope !== undefined) throw error;
		const widenedCandidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, {
			...widenedRequest(listOperation, baseRequest),
			text: name,
		});
		const id = matchArtifactByName(widenedCandidates, name);
		notes?.push(`"${name}" was not found in the current project scope; resolved across all projects instead.`);
		return id;
	}
}

/**
 * Resolves every {nameKey -> idKey} pair present and not already satisfied by an explicit id, in
 * place. `notes`, when given, collects a message for each name that only resolved by widening
 * past the caller's own scope (see resolveArtifactIdByName) -- callers that want that surfaced
 * to the model/human pass an array here and append it to their own response text.
 */
export async function resolveNameFields(
	params: Record<string, unknown>,
	fields: ReadonlyArray<{ nameKey: string; idKey: string; listOperation: OperationName; baseRequest: Record<string, unknown> }>,
	notes?: string[],
): Promise<void> {
	for (const { nameKey, idKey, listOperation, baseRequest } of fields) {
		const nameValue = params[nameKey];
		if (typeof nameValue === "string" && nameValue.length > 0 && !params[idKey]) {
			params[idKey] = await resolveArtifactIdByName(listOperation, baseRequest, nameValue, notes);
		}
	}
}

/** Resolves a `namesKey` string array to an `idsKey` id array, only when idsKey isn't already explicitly given. */
async function resolveNameArrayField(
	params: Record<string, unknown>,
	namesKey: string,
	idsKey: string,
	listOperation: OperationName,
	baseRequest: Record<string, unknown>,
	notes?: string[],
): Promise<void> {
	const names = params[namesKey];
	if (Array.isArray(names) && names.length > 0 && !params[idsKey]) {
		params[idsKey] = await Promise.all(names.map((entry) => resolveArtifactIdByName(listOperation, baseRequest, String(entry), notes)));
	}
}

/**
 * Shared "remove"/"restore" dispatch for every domain tool (tasks/docs/rules/playbooks) --
 * artifact.remove/restore are kind-agnostic composition-root operations (see service.ts),
 * not owned by any one domain module, so every domain tool exposes the same two actions
 * over the same two operations rather than reinventing trash semantics four times.
 * Returns null when action is neither, so callers fall through to their own dispatch.
 */
async function _handleArtifactRemoveRestore(action: unknown, params: Record<string, unknown>): Promise<ReturnType<typeof text> | null> {
	// Trashed/restored artifacts stay directly showable, so known identities render by title on
	// either side of the action. An unresolved explicit id stays in structured/error channels;
	// normal model text does not turn that backend key into the artifact's public name.
	const titleOf = async (): Promise<string> => {
		try {
			const artifact = await callService<Record<string, unknown>, Artifact | null>("artifact.show", { id: params.id });
			return artifact ? `"${artifact.title}"` : "unknown artifact";
		} catch {
			return "unknown artifact";
		}
	};
	if (action === "remove") {
		const label = await titleOf();
		const record = await callService<
			Record<string, unknown>,
			{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string }
		>("artifact.remove", params);
		const message = `Trashed ${label}, eligible for purge at ${record.purgeAfter}.`;
		return text(message, createPreviewDetails("artifact.remove", "Trashed", record.artifactId));
	}
	if (action === "restore") {
		const label = await titleOf();
		const outcome = await callService<Record<string, unknown>, { restored: boolean }>("artifact.restore", params);
		const output = outcome.restored ? `Restored ${label}.` : `${label} was not trashed.`;
		return text(output, createPreviewDetails("artifact.restore", "Restored", output));
	}
	if (action === "remove_subtree") {
		const label = await titleOf();
		const outcome = await callService<Record<string, unknown>, { removed: string[]; skipped: string[] }>("artifact.remove_subtree", params);
		const message = `Trashed ${label} and ${outcome.removed.length - 1} contained artifact(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-trashed` : ""}.`;
		return text(message, createPreviewDetails("artifact.remove_subtree", "Trashed subtree", JSON.stringify(outcome, null, 2)));
	}
	return null;
}

// notes.*, rules.*, docs.*, playbooks.*, tasks.*, and the shared artifact.* are
// registered as Vehicles (see ../vehicle-notes-client.ts and @danypops/papyrus's
// src/vehicle/papyrus-vehicle.ts), not pi.registerTool()s in this file.

export function registerDiscussTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "discuss",
		label: "Discuss",
		description:
			"Native Papyrus deliberation with a real lifecycle -- distinct from a one-shot ask: a Discussion persists, takes multiple rounds, and can genuinely block a Task's completion until settled or deferred. ACTIONS: open, reply, defer, resume, settle, block, unblock, show, rounds, list. open starts round 1 and optionally blocks_task_ids immediately. reply is refused once deferred or settled -- resume first. defer is explicitly non-blocking (paused, resumable); settle is terminal and archives the discussion. block/unblock manage the blocking relationship to a task independently of open. A task's completion is refused while any active Discussion blocks it. open/reply can pose a structured choice via options (2-10 entries) + options_mode ('single' mutually exclusive, 'multi' allows several); reply answers a currently pending choice via selected, validated against it. Each option is either a bare string or {title, description}; description is optional for exactly 2 options (a self-evident yes/no) but REQUIRED and non-empty for every option once there are 3 or more -- rejected otherwise. One line: the real pro/con/risk/consequence, never padding that just restates the title. Pass live:true on open or reply to get the human's answer synchronously in this same call, via an interactive prompt (the pending choice's picker if one was posed, otherwise a freeform question) -- covers a completely open question with no artifact (open with no prior discussion) and a question tied to a specific existing artifact (reply, addressed by name) alike. Only takes effect with an interactive UI available; otherwise degrades silently to the normal async round. The live picker docks in the input area itself (falls back to a plain text prompt if unsupported in the current UI mode). PREFER `name` (the discussion's exact title) over `id`, `task_name`/`blocks_task_names` over `task_id`/`blocks_task_ids` -- all are backend implementation details, resolved from name automatically.",
		parameters: Type.Object({
			action: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			blocks_task_ids: Type.Optional(Type.Array(Type.String())),
			blocks_task_names: Type.Optional(Type.Array(Type.String())),
			task_id: Type.Optional(Type.String()),
			task_name: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			settlement: Type.Optional(Type.String()),
			state: Type.Optional(Type.String()),
			after_round: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
			options: Type.Optional(
				Type.Array(Type.Union([Type.String(), Type.Object({ title: Type.String(), description: Type.Optional(Type.String()) })])),
			),
			options_mode: Type.Optional(Type.String()),
			selected: Type.Optional(Type.Array(Type.String())),
			live: Type.Optional(Type.Boolean()),
		}),
		// Blocks other tool calls in the same assistant turn until live:true's human answer comes
		// back, same reasoning as pi-ask-user's own tool: the model must not batch a live ask with
		// bash/edit/write and let those run before the human sees the prompt.
		executionMode: "sequential",
		renderCall(args, theme) {
			return renderPapyrusToolCall("Discuss", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPapyrusToolResult(result, options, theme, context);
		},
		async execute(_id, rawParams, signal, onUpdate, ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				const action = params.action;
				const taskScope = { project_root: ctx.cwd };
				await resolveNameFields(params, [
					{ nameKey: "name", idKey: "id", listOperation: "discuss.list", baseRequest: {} },
					{ nameKey: "task_name", idKey: "task_id", listOperation: "tasks.list", baseRequest: taskScope },
				]);
				await resolveNameArrayField(params, "blocks_task_names", "blocks_task_ids", "tasks.list", taskScope);
				if (action === "open" || action === "reply") {
					normalizeDiscussOptions(params);
					// Matches the tasks/notes tools' own convention: an agent-driven mutation with no
					// explicit human actor still needs a real, non-generic label for the audit trail,
					// not a bare daemon rejection.
					if (typeof params.actor !== "string" || params.actor.length === 0) params.actor = "agent";
					const operation = action === "open" ? "discuss.open" : "discuss.reply";
					const result = await callService<Record<string, unknown>, DiscussionAndRounds>(operation, params);
					const fallback =
						action === "open"
							? text(`Opened discussion ${artifactLine(result.discussion)}`, createArtifactDetails("discuss.open", result.discussion))
							: text(
									`Round ${result.rounds[0]?.roundNumber} added to "${result.discussion.title}"`,
									createArtifactDetails("discuss.reply", result.discussion),
								);
					if (params.live !== true) return fallback;
					const answer = await liveAnswer(ctx, result.discussion, result.rounds[0]?.content, onUpdate, signal);
					if (!answer) return fallback;
					const answered = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.reply", {
						id: result.discussion.id,
						actor: "human",
						content: answer.content,
						...(answer.selected ? { selected: answer.selected } : {}),
						source: "discuss-live",
					});
					return text(`"${answered.discussion.title}": ${answer.content}`, createArtifactDetails("discuss.reply", answered.discussion));
				}
				if (action === "block" || action === "unblock") {
					const operation = action === "block" ? "discuss.block" : "discuss.unblock";
					const [outcome, discussionAndRounds, task] = await Promise.all([
						callService<Record<string, unknown>, { blocked?: boolean; unblocked?: boolean }>(operation, params),
						callService<Record<string, unknown>, DiscussionAndRounds>("discuss.show", { id: params.id }),
						callService<Record<string, unknown>, Artifact>("tasks.show", { id: params.task_id }),
					]);
					const discussion = discussionAndRounds.discussion;
					const message =
						action === "unblock" && !outcome.unblocked
							? "No such blocking relationship."
							: `"${discussion.title}" ${action === "block" ? "now blocks" : "no longer blocks"} "${task.title}"`;
					return text(message, createPreviewDetails(operation, action === "block" ? "Blocked" : "Unblocked", message));
				}
				if (action === "show") {
					const result = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.show", params);
					const rounds = result.rounds.map((round) => `  [round ${round.roundNumber}] ${round.actor}: ${round.content}`).join("\n");
					return text(`${artifactLine(result.discussion)}\n\n${rounds}`, createArtifactDetails("discuss.show", result.discussion));
				}
				if (action === "rounds") {
					const rounds = await callService<Record<string, unknown>, DiscussionRound[]>("discuss.rounds", params);
					const output = rounds.map((round) => `[round ${round.roundNumber}] ${round.actor}: ${round.content}`).join("\n") || "No rounds.";
					return text(output, createPreviewDetails("discuss.rounds", "Discussion rounds", output));
				}
				if (action === "list") {
					const rows = await callService<Record<string, unknown>, Artifact[]>("discuss.list", params);
					return text(
						rows.length ? artifactLines(rows).join("\n") : "No discussions found.",
						createArtifactListDetails("discuss.list", rows),
					);
				}
				const operations = { defer: "discuss.defer", resume: "discuss.resume", settle: "discuss.settle" } as const;
				const operation = operations[action as keyof typeof operations];
				if (!operation) throw new Error(`unknown discuss action: ${action}`);
				const artifact = await callService<Record<string, unknown>, Artifact>(operation, params);
				return text(artifactLine(artifact), createArtifactDetails(operation, artifact));
			} catch (error) {
				throw new Error(`discuss failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});
}

/** Thin orchestrator: each domain's tool is independently navigable/testable via its own registerXTool function. */
// notes, rules, docs, playbooks, and tasks are no longer registered here -- all migrated
// onto Vehicle (registerNotesVehicle in vehicle-notes-client.ts, wired at session_start in
// index.ts), replacing their own pi.registerTool() mega-tools. See @danypops/papyrus's
// src/vehicle/papyrus-vehicle.ts for the server side. discuss remains here -- live:true needs an
// interactive UI round-trip a stateless Vehicle operation can't express.
export function registerDomainTools(pi: ExtensionAPI): void {
	registerDiscussTool(pi);
}
