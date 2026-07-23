/**
 * discuss.ts — /discuss interactive panel.
 * Reuses the generic artifact browser (artifact-browser.ts), same as docs.ts/rules.ts/notes.ts:
 * a Discussion is a `doc` artifact, so the browser's list/filter/refresh/select-action loop
 * applies unchanged. The one real wrinkle is that Discuss's meaningful lifecycle state
 * (active/deferred/settled) lives in extra.discussion, not the shared doc status column the
 * browser colors its row glyph by (see artifact-status-presentation.ts's DISCUSSION_STATE_PRESENTATION
 * comment) -- so the real state is surfaced in rowMeta text instead, the same way rules.ts
 * surfaces severity and notes.ts surfaces history count, both also not the row glyph.
 *
 * Creating a new Discussion is left to the agent (the discuss tool), matching docs.ts/rules.ts/
 * skills.ts precedent -- Notes is the one kind with a human-facing creation command (/note),
 * because Notes exists specifically as a human-authored inbox.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { DiscussionAndRounds } from "../../src/discussion-service.ts";
import { showArtifactBrowser } from "./artifact-browser.ts";
import { DISCUSSION_STATE_PRESENTATION, DOC_STATUS_PRESENTATION } from "./artifact-status-presentation.ts";
import { discussionRoundCountOf, discussionStateOf, showDiscussionDetailView } from "./discussion-detail-view.ts";
import { callService } from "./service-client.ts";

const SOURCE = "discuss-tui";
const ACTOR = "human";

export function discussionRowMeta(discussion: Artifact, theme: Theme): string {
	const state = discussionStateOf(discussion);
	const presentation = DISCUSSION_STATE_PRESENTATION[state];
	const stateText = presentation ? theme.fg(presentation.color, `${presentation.glyph} ${presentation.label}`) : theme.fg("muted", "state unknown");
	const rounds = discussionRoundCountOf(discussion);
	return `${stateText} · ${rounds} round${rounds === 1 ? "" : "s"}`;
}

function discussionActions(discussion: Artifact): string[] {
	const state = discussionStateOf(discussion);
	if (state === "active") return ["Show transcript", "Reply", "Defer", "Settle", "Block a task", "Unblock a task"];
	if (state === "deferred") return ["Show transcript", "Resume", "Settle"];
	return ["Show transcript"]; // settled, or an unrecognized/corrupt state -- read-only either way
}

export async function showDiscussions(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "doc",
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
				const content = await commandCtx.ui.input("Reply:", "");
				if (!content) return;
				await callService("discuss.reply", { id: discussion.id, actor: ACTOR, content, source: SOURCE });
				commandCtx.ui.notify("Round added.", "info");
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
				const taskId = await commandCtx.ui.input("Task artifact id to block:", "");
				if (!taskId) return;
				await callService("discuss.block", { id: discussion.id, task_id: taskId, actor: ACTOR, source: SOURCE });
				commandCtx.ui.notify(`${discussion.id} now blocks ${taskId}`, "info");
				return;
			}
			if (choice === "Unblock a task") {
				const taskId = await commandCtx.ui.input("Task artifact id to unblock:", "");
				if (!taskId) return;
				const result = await callService<Record<string, unknown>, { unblocked: boolean }>("discuss.unblock", { id: discussion.id, task_id: taskId, actor: ACTOR, source: SOURCE });
				commandCtx.ui.notify(result.unblocked ? `${discussion.id} no longer blocks ${taskId}` : "No such blocking relationship.", "info");
			}
		},
	});
}
