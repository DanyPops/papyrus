/**
 * discuss.ts — /discuss interactive panel.
 * Reuses the generic artifact browser (artifact-browser.ts), same as docs.ts/rules.ts/notes.ts:
 * a Discussion is a `task` artifact (subtype "discussion"), so the browser's
 * list/filter/refresh/select-action loop applies unchanged. The one real wrinkle is that
 * Discuss's meaningful lifecycle state (active/deferred/settled) lives in extra.discussion, not
 * the shared status column the browser colors its row glyph by (see
 * artifact-status-presentation.ts's DISCUSSION_STATE_PRESENTATION comment) -- so the real state
 * is surfaced in rowMeta text instead, the same way rules.ts surfaces severity and notes.ts
 * surfaces history count, both also not the row glyph.
 *
 * Creating a new Discussion is left to the agent (discuss_open, Vehicle-projected -- see
 * vehicle-notes-client.ts), matching docs.ts/rules.ts/playbooks.ts precedent -- Notes is the one
 * kind with a human-facing creation command (/note), because Notes exists specifically as a
 * human-authored inbox.
 */

import { type Artifact, type DiscussionAndRounds, readDiscussionExtra } from "@danypops/papyrus";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { showArtifactBrowser } from "./artifact/artifact-browser.ts";
import { DISCUSSION_STATE_PRESENTATION, DOC_STATUS_PRESENTATION } from "./artifact/artifact-status-presentation.ts";
import { askQuestion } from "./discuss-ask-view.ts";
import { discussionRoundCountOf, discussionStateOf, showDiscussionDetailView } from "./discussion-detail-view.ts";
import { callService } from "./service-client.ts";

const SOURCE = "discuss-tui";
const ACTOR = "human";

/** Tasks a human could plausibly want to block on -- excludes terminal ones, since blocking already-finished or canceled work is meaningless. */
export async function openTaskChoices(cwd: string): Promise<Artifact[]> {
	const rows = await callService<Record<string, unknown>, Artifact[]>("tasks.list", { project_root: cwd });
	return rows.filter((task) => task.status !== "done" && task.status !== "canceled");
}

/** Resolves the task ids a Discussion currently has a `blocks` edge to, by title -- so "Unblock" only ever offers tasks actually blocked by this one, never the whole task list. */
export async function blockedTaskChoices(discussionId: string): Promise<Artifact[]> {
	const tree = await callService<Record<string, unknown>, Artifact>("graph.tree", { id: discussionId, depth: 1 });
	const blockedIds = (tree.edges ?? []).filter((edge) => edge.relation === "blocks" && edge.from === discussionId).map((edge) => edge.to);
	const tasks = await Promise.all(
		blockedIds.map((id) => callService<Record<string, unknown>, Artifact | null>("tasks.show", { id }).catch(() => null)),
	);
	return tasks.filter((task): task is Artifact => task !== null);
}

/** Picking a task by title, the same ui.select pattern used for Discuss's own single-choice options -- no ecosystem extension (Pi's own docs/examples, pi-tasks) builds a bespoke fuzzy picker for a plain "choose one named thing" list. */
export async function pickTaskByName(ctx: ExtensionCommandContext, title: string, tasks: Artifact[]): Promise<Artifact | undefined> {
	if (tasks.length === 0) {
		ctx.ui.notify("No open tasks to choose from.", "info");
		return undefined;
	}
	const label = await ctx.ui.select(
		title,
		tasks.map((task) => `${task.title} [${task.status}]`),
	);
	if (!label) return undefined;
	const index = tasks.map((task) => `${task.title} [${task.status}]`).indexOf(label);
	return index === -1 ? undefined : tasks[index];
}

export function discussionRowMeta(discussion: Artifact, theme: Theme): string {
	const state = discussionStateOf(discussion);
	const presentation = DISCUSSION_STATE_PRESENTATION[state];
	const stateText = presentation
		? theme.fg(presentation.color, `${presentation.glyph} ${presentation.label}`)
		: theme.fg("muted", "state unknown");
	const rounds = discussionRoundCountOf(discussion);
	const pending = (() => {
		try {
			return readDiscussionExtra(discussion.extra).pendingOptions;
		} catch {
			return undefined;
		}
	})();
	const pendingText = pending && pending.length > 0 ? theme.fg("accent", ` · awaiting: ${pending.join("/")}`) : "";
	return `${stateText} · ${rounds} round${rounds === 1 ? "" : "s"}${pendingText}`;
}

function discussionActions(discussion: Artifact): string[] {
	const state = discussionStateOf(discussion);
	if (state === "active") return ["Show transcript", "Reply", "Defer", "Settle", "Block a task", "Unblock a task"];
	if (state === "deferred") return ["Show transcript", "Resume", "Settle"];
	return ["Show transcript"]; // settled, or an unrecognized/corrupt state -- read-only either way
}

export async function showDiscussions(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "discussion",
		title: "Discussions",
		listOperation: "discuss.list",
		statusOrder: ["draft", "active", "archived"],
		presentation: DOC_STATUS_PRESENTATION,
		rowMeta: discussionRowMeta,
		actions: discussionActions,
		handleAction: async (choice, discussion, commandCtx) => {
			if (choice === "Show transcript") {
				const result = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.show", { id: discussion.id });
				await showDiscussionDetailView(commandCtx, result.discussion, result.rounds);
				return;
			}
			if (choice === "Reply") {
				const pending = (() => {
					try {
						return readDiscussionExtra(discussion.extra);
					} catch {
						return undefined;
					}
				})();
				// Same fix as the live discuss tool: the most recent round's own content IS the real
				// question -- the title becomes a plain orientation subtitle, not a labeled-backwards
				// "Context:" section under a generic "Reply to <title>:" wrapper.
				const transcript = await callService<Record<string, unknown>, DiscussionAndRounds>("discuss.show", { id: discussion.id });
				const question = transcript.rounds.at(-1)?.content?.trim() || `Reply to "${discussion.title}":`;
				const subtitle = discussion.title;
				const answer =
					pending?.pendingOptions && pending.pendingOptions.length > 0 && pending.pendingOptionsMode
						? await askQuestion(commandCtx, {
								question,
								subtitle,
								options: pending.pendingOptions.map((title, index) => ({
									title,
									description: pending.pendingOptionDescriptions?.[index] || undefined,
								})),
								allowMultiple: pending.pendingOptionsMode === "multi",
							})
						: await askQuestion(commandCtx, { question, subtitle });
				if (!answer) return; // canceled
				await callService("discuss.reply", {
					id: discussion.id,
					actor: ACTOR,
					content: answer.content,
					...(answer.selected ? { selected: answer.selected } : {}),
					source: SOURCE,
				});
				commandCtx.ui.notify(answer.selected ? `Selected: ${answer.selected.join(", ")}` : "Reply added.", "info");
				return;
			}
			if (choice === "Defer") {
				const reason = await commandCtx.ui.input("Defer reason (optional):", "");
				await callService("discuss.defer", { id: discussion.id, ...(reason ? { reason } : {}), actor: ACTOR, source: SOURCE });
				commandCtx.ui.notify("Deferred.", "info");
				return;
			}
			if (choice === "Resume") {
				await callService("discuss.resume", { id: discussion.id, actor: ACTOR, source: SOURCE });
				commandCtx.ui.notify("Resumed.", "info");
				return;
			}
			if (choice === "Settle") {
				const settlement = await commandCtx.ui.input("Settlement:", "");
				if (!settlement) return;
				await callService("discuss.settle", { id: discussion.id, settlement, actor: ACTOR, source: SOURCE });
				commandCtx.ui.notify("Settled.", "info");
				return;
			}
			if (choice === "Block a task") {
				const target = await pickTaskByName(commandCtx, "Block which task?", await openTaskChoices(commandCtx.cwd));
				if (!target) return;
				await callService("discuss.block", { id: discussion.id, task_id: target.id, actor: ACTOR, source: SOURCE });
				commandCtx.ui.notify(`"${discussion.title}" now blocks "${target.title}"`, "info");
				return;
			}
			if (choice === "Unblock a task") {
				const blocked = await blockedTaskChoices(discussion.id);
				if (blocked.length === 0) {
					commandCtx.ui.notify("This discussion isn't blocking any task.", "info");
					return;
				}
				const target = await pickTaskByName(commandCtx, "Unblock which task?", blocked);
				if (!target) return;
				const result = await callService<Record<string, unknown>, { unblocked: boolean }>("discuss.unblock", {
					id: discussion.id,
					task_id: target.id,
					actor: ACTOR,
					source: SOURCE,
				});
				commandCtx.ui.notify(
					result.unblocked ? `"${discussion.title}" no longer blocks "${target.title}"` : "No such blocking relationship.",
					"info",
				);
			}
		},
	});
}
