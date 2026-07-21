export interface ActiveTaskMarker {
	id: string;
	title: string;
	updated_at: string;
}

export interface ActiveTaskContinuationOptions {
	maxTurns: number;
	maxUnchangedTurns: number;
}

export interface ActiveTaskContinuationState {
	queued: boolean;
	consecutiveTurns: number;
	unchangedTurns: number;
	pausedReason?: string;
}

export interface ActiveTaskContinuationDecision {
	action: "continue" | "wait" | "pause";
	reason: string;
	prompt?: string;
}

const TITLE_LIMIT = 120;
const AUTOMATIC_PAUSE_PREFIX = "automatic continuation paused:";

export function automaticPauseReason(reason: string): string {
	return `${AUTOMATIC_PAUSE_PREFIX} ${reason}`;
}

export function shouldResumeFocusOnHumanInput(status: string, pauseReason?: string): boolean {
	return status === "paused" && pauseReason?.startsWith(AUTOMATIC_PAUSE_PREFIX) === true;
}

function fingerprint(task: ActiveTaskMarker): string {
	return `${task.id}:${task.updated_at}`;
}

function continuationPrompt(task: ActiveTaskMarker): string {
	return [
		"Continue the active Papyrus Task now; do not hand off merely because the previous Pi run settled.",
		"Reconcile its lifecycle, take the next concrete action, use tools, submit it for review when implementation effort is ready, and run gates plus checklist review before completion.",
		"Do not shrink the task's scope to whatever fits in this turn, and do not treat a status update or summary as a substitute for doing the work or as proof of completion.",
		"If something blocks progress, do not reject or pause on the first obstacle -- only after it genuinely recurs, and only when the task truly cannot proceed without external input.",
		`Active task: ${task.id}: ${task.title.slice(0, TITLE_LIMIT)}`,
	].join("\n");
}

export class ActiveTaskContinuation {
	private queued = false;
	private consecutiveTurns = 0;
	private unchangedTurns = 0;
	private lastFingerprint: string | undefined;
	private pausedReason: string | undefined;

	constructor(private readonly options: ActiveTaskContinuationOptions) {
		if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) throw new Error("maxTurns must be a positive integer");
		if (!Number.isInteger(options.maxUnchangedTurns) || options.maxUnchangedTurns < 1) {
			throw new Error("maxUnchangedTurns must be a positive integer");
		}
	}

	evaluate(task: ActiveTaskMarker | null, context: { idle: boolean; pendingMessages: boolean }): ActiveTaskContinuationDecision {
		if (!context.idle) return { action: "wait", reason: "Pi is not settled" };
		if (context.pendingMessages) return { action: "wait", reason: "Pi already has pending messages" };
		if (this.queued) return { action: "wait", reason: "continuation already queued" };
		if (!task) {
			this.resetProgress();
			return { action: "wait", reason: "no active task" };
		}

		const currentFingerprint = fingerprint(task);
		if (currentFingerprint !== this.lastFingerprint) {
			this.lastFingerprint = currentFingerprint;
			this.unchangedTurns = 0;
			this.pausedReason = undefined;
		} else {
			this.unchangedTurns += 1;
		}

		if (this.consecutiveTurns >= this.options.maxTurns) {
			return this.pause(`automatic turn limit reached (${this.options.maxTurns})`);
		}
		if (this.unchangedTurns >= this.options.maxUnchangedTurns) {
			return this.pause(`no task progress after ${this.options.maxUnchangedTurns} automatic turns`);
		}

		this.queued = true;
		this.consecutiveTurns += 1;
		return {
			action: "continue",
			reason: "an active task remains",
			prompt: continuationPrompt(task),
		};
	}

	onAgentStart(): void {
		this.queued = false;
	}

	onCompaction(): void {
		this.queued = false;
	}

	onHumanInput(): void {
		this.resetProgress();
	}

	status(): ActiveTaskContinuationState {
		return {
			queued: this.queued,
			consecutiveTurns: this.consecutiveTurns,
			unchangedTurns: this.unchangedTurns,
			...(this.pausedReason ? { pausedReason: this.pausedReason } : {}),
		};
	}

	private pause(reason: string): ActiveTaskContinuationDecision {
		this.pausedReason = reason;
		return { action: "pause", reason };
	}

	private resetProgress(): void {
		this.queued = false;
		this.consecutiveTurns = 0;
		this.unchangedTurns = 0;
		this.lastFingerprint = undefined;
		this.pausedReason = undefined;
	}
}
