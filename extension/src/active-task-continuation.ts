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

const DISPLAYED_TASK_LIMIT = 3;
const TITLE_LIMIT = 120;

function fingerprint(tasks: ActiveTaskMarker[]): string {
	return [...tasks]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((task) => `${task.id}:${task.updated_at}`)
		.join("|");
}

function continuationPrompt(tasks: ActiveTaskMarker[]): string {
	const names = tasks.slice(0, DISPLAYED_TASK_LIMIT).map((task) => `- ${task.id}: ${task.title.slice(0, TITLE_LIMIT)}`);
	return [
		"Continue active Papyrus work now; do not hand off merely because the previous Pi run settled.",
		"Reconcile the active Tasks, choose the next concrete action, use tools, run gates before completion, and continue until done, blocked, or the bounded continuation pauses.",
		"Active tasks:",
		...names,
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

	evaluate(tasks: ActiveTaskMarker[], context: { idle: boolean; pendingMessages: boolean }): ActiveTaskContinuationDecision {
		if (!context.idle) return { action: "wait", reason: "Pi is not settled" };
		if (context.pendingMessages) return { action: "wait", reason: "Pi already has pending messages" };
		if (this.queued) return { action: "wait", reason: "continuation already queued" };
		if (tasks.length === 0) {
			this.resetProgress();
			return { action: "wait", reason: "no active tasks" };
		}

		const currentFingerprint = fingerprint(tasks);
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
			reason: "active tasks remain",
			prompt: continuationPrompt(tasks),
		};
	}

	onAgentStart(): void {
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
