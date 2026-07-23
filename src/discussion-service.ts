/**
 * Discuss: application service composing the Discussion Doc (via ArtifactStore) with its
 * append-only rounds (via DiscussionRoundStore). See domain/discussion.ts for the full
 * design rationale.
 */
import { DISCUSSION_LIST_DEFAULT_LIMIT, DISCUSSION_LIST_MAX_LIMIT, DISCUSSION_MAX_ROUNDS } from "./constants.ts";
import {
	DISCUSSION_SUBTYPE,
	isDiscussionArtifact,
	readDiscussionExtra,
	validateDeferReason,
	validateDiscussionActor,
	validateDiscussionContent,
	validateSettlement,
	type DiscussionExtra,
	type DiscussionRound,
} from "./domain/discussion.ts";
import type { Artifact } from "./domain/artifact.ts";
import type { ArtifactEventContext } from "./domain/artifact-event.ts";
import type { AtomicArtifactStore } from "./ports/atomic-artifact-store.ts";
import type { DiscussionRoundStore } from "./ports/discussion-round-store.ts";

export class DiscussionError extends Error {}

export interface OpenDiscussionInput {
	title: string;
	actor: string;
	content: string;
	body?: string;
	labels?: string[];
	blocksTaskIds?: string[];
}

export interface DiscussionAndRounds {
	discussion: Artifact;
	rounds: DiscussionRound[];
}

function requireDiscussion(artifact: Artifact | null, id: string): Artifact {
	if (!artifact) throw new DiscussionError(`discussion "${id}" not found`);
	if (!isDiscussionArtifact(artifact)) throw new DiscussionError(`artifact "${id}" is not a Discussion`);
	return artifact;
}

export class Discussions {
	constructor(
		private readonly artifacts: AtomicArtifactStore,
		private readonly rounds: DiscussionRoundStore,
	) {}

	private extra(discussion: Artifact): DiscussionExtra {
		return readDiscussionExtra(discussion.extra);
	}

	open(input: OpenDiscussionInput, context?: ArtifactEventContext): DiscussionAndRounds {
		const actor = validateDiscussionActor(input.actor);
		const content = validateDiscussionContent(input.content);
		return this.artifacts.atomic(() => {
			const discussion = this.artifacts.create({
				kind: "doc",
				subtype: DISCUSSION_SUBTYPE,
				title: input.title,
				body: input.body ?? "",
				status: "active",
				labels: input.labels,
				extra: { discussion: { state: "active", roundCount: 1 } },
			}, context);
			const round = this.rounds.append({ discussionId: discussion.id, roundNumber: 1, actor, content }, new Date().toISOString());
			for (const taskId of input.blocksTaskIds ?? []) this.block(discussion.id, taskId, context);
			return { discussion: this.artifacts.get(discussion.id)!, rounds: [round] };
		});
	}

	reply(discussionId: string, actor: string, content: string, context?: ArtifactEventContext): DiscussionAndRounds {
		const validActor = validateDiscussionActor(actor);
		const validContent = validateDiscussionContent(content);
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state !== "active") throw new DiscussionError(`discussion "${discussionId}" is ${state.state}; resume it before replying`);
			if (state.roundCount >= DISCUSSION_MAX_ROUNDS) throw new DiscussionError(`discussion "${discussionId}" has reached its ${DISCUSSION_MAX_ROUNDS}-round limit; settle or defer it`);
			const nextRound = state.roundCount + 1;
			const round = this.rounds.append({ discussionId, roundNumber: nextRound, actor: validActor, content: validContent }, new Date().toISOString());
			const updated = this.artifacts.setExtra(discussionId, { ...discussion.extra, discussion: { ...state, roundCount: nextRound } }, context)!;
			return { discussion: updated, rounds: [round] };
		});
	}

	defer(discussionId: string, reason?: string, context?: ArtifactEventContext): Artifact {
		const validReason = reason === undefined ? undefined : validateDeferReason(reason);
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state !== "active") throw new DiscussionError(`discussion "${discussionId}" is ${state.state}; only an active Discussion can be deferred`);
			return this.artifacts.setExtra(discussionId, {
				...discussion.extra,
				discussion: { ...state, state: "deferred", ...(validReason === undefined ? {} : { deferredReason: validReason }) },
			}, context)!;
		});
	}

	resume(discussionId: string, context?: ArtifactEventContext): Artifact {
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state !== "deferred") throw new DiscussionError(`discussion "${discussionId}" is ${state.state}; only a deferred Discussion can be resumed`);
			const { deferredReason: _deferredReason, ...rest } = state;
			return this.artifacts.setExtra(discussionId, { ...discussion.extra, discussion: { ...rest, state: "active" } }, context)!;
		});
	}

	settle(discussionId: string, settlement: string, context?: ArtifactEventContext): Artifact {
		const validSettlement = validateSettlement(settlement);
		return this.artifacts.atomic(() => {
			const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
			const state = this.extra(discussion);
			if (state.state === "settled") throw new DiscussionError(`discussion "${discussionId}" is already settled`);
			const updated = this.artifacts.setExtra(discussionId, {
				...discussion.extra,
				discussion: { ...state, state: "settled", settlement: validSettlement, settledAt: new Date().toISOString() },
			}, context)!;
			return this.artifacts.setStatus(discussionId, "archived", context) ?? updated;
		});
	}

	/** Links an existing active Discussion to a Task it blocks; refuses a non-task target or an already-settled Discussion. */
	block(discussionId: string, taskId: string, context?: ArtifactEventContext): void {
		const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
		if (this.extra(discussion).state === "settled") throw new DiscussionError(`discussion "${discussionId}" is settled; it can no longer block anything`);
		const task = this.artifacts.get(taskId);
		if (!task) throw new DiscussionError(`task "${taskId}" not found`);
		if (task.kind !== "task") throw new DiscussionError(`artifact "${taskId}" is not a task`);
		this.artifacts.link({ from: discussionId, relation: "blocks", to: taskId }, context);
	}

	/** Idempotent: unblocking an already-absent relationship is a no-op. */
	unblock(discussionId: string, taskId: string, context?: ArtifactEventContext): boolean {
		return this.artifacts.unlink({ from: discussionId, relation: "blocks", to: taskId }, context);
	}

	show(discussionId: string): DiscussionAndRounds {
		const discussion = requireDiscussion(this.artifacts.get(discussionId), discussionId);
		return { discussion, rounds: this.rounds.list({ discussionId }) };
	}

	listRounds(discussionId: string, afterRound?: number, limit?: number): DiscussionRound[] {
		requireDiscussion(this.artifacts.get(discussionId), discussionId);
		return this.rounds.list({ discussionId, afterRound, limit });
	}

	list(filter: { state?: string; limit?: number } = {}): Artifact[] {
		// DISCUSSION_LIST_MAX_LIMIT/DEFAULT_LIMIT exist specifically so an unqualified discuss.list
		// (limit omitted) can never fall through to queryArtifacts' own unbounded default -- the same
		// class of gap notes.ts's noteListInput comment documents fixing for Notes.
		const limit = Math.min(DISCUSSION_LIST_MAX_LIMIT, Math.max(1, Math.floor(filter.limit ?? DISCUSSION_LIST_DEFAULT_LIMIT)));
		const rows = this.artifacts.query({ kind: "doc", subtype: DISCUSSION_SUBTYPE, limit });
		if (!filter.state) return rows;
		return rows.filter((row) => {
			try { return this.extra(row).state === filter.state; } catch { return false; }
		});
	}
}
