/**
 * discuss.open/discuss.reply's live:true synchronous human round-trip -- the
 * one piece of discuss's own retired pi.registerTool() the plain
 * request/response Vehicle projection can't express on its own, wired in via
 * vehicle-client-pi's interactiveFollowUps hook (../tools/vehicle-notes-client.ts).
 *
 * The primary invoke() always durably records the round first, exactly like
 * every other Vehicle operation -- this only ever adds an OPTIONAL synchronous
 * prompt on top when ctx.hasUI and the caller actually asked for one. No
 * answer (canceled, no UI, live not requested) falls back to the operation's
 * own default content/details, matching the retired tool's exact fallback
 * behavior.
 */
import type { DiscussionAndRounds } from "@danypops/papyrus";
import { readDiscussionExtra } from "@danypops/papyrus";
import type { PiVehicleInteractiveFollowUp } from "@danypops/vehicle-client-pi";
import { askQuestion } from "./discuss-ask-view.ts";

const LIVE_REPLY_PERMISSIONS = ["discuss:read", "discuss:write"] as const;

export const discussLiveFollowUp: PiVehicleInteractiveFollowUp = async (request, output, client) => {
	const live = (request.input as { live?: unknown } | undefined)?.live === true;
	if (!live || !request.context.hasUI) return undefined;

	const result = output as DiscussionAndRounds;
	const pending = (() => {
		try {
			return readDiscussionExtra(result.discussion.extra);
		} catch {
			return undefined;
		}
	})();
	// The just-recorded round's own content IS the real question -- a generic "Reply to
	// <title>:" wrapper as the primary question, with the real content demoted to
	// "Context:", left a human staring at a labeled-backwards prompt (live-observed on the
	// retired tool). The wrapper is now only a fallback for the degenerate case of empty
	// content; the title becomes a plain orientation subtitle instead.
	const question = result.rounds[0]?.content?.trim() || `Reply to "${result.discussion.title}":`;
	const subtitle = result.discussion.title;
	const answer = await askQuestion(request.context, {
		question,
		subtitle,
		onUpdate: request.onUpdate,
		signal: request.signal,
		...(pending?.pendingOptions && pending.pendingOptions.length > 0 && pending.pendingOptionsMode
			? {
					options: pending.pendingOptions.map((title, index) => ({
						title,
						description: pending.pendingOptionDescriptions?.[index] || undefined,
					})),
					allowMultiple: pending.pendingOptionsMode === "multi",
				}
			: {}),
	});
	if (!answer) return undefined; // canceled, or no UI capable of answering -- default content/details stand

	const answered = (await client.invoke(
		"discuss.reply",
		1,
		{
			id: result.discussion.id,
			actor: "human",
			content: answer.content,
			...(answer.selected ? { selected: answer.selected } : {}),
			source: "discuss-live",
		},
		{
			permissions: LIVE_REPLY_PERMISSIONS,
			principal: { id: "pi-papyrus" },
			signal: request.signal,
		},
	)) as DiscussionAndRounds;
	return {
		content: [{ type: "text", text: `"${answered.discussion.title}": ${answer.content}` }],
		output: answered,
	};
};
