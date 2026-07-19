export interface Gate {
	type: "file-exists" | "command" | "contains" | "test";
	target: string;
	expect?: string;
}

export interface GateRunOptions {
	/** Absolute Unix epoch deadline for the full gate sequence. */
	deadlineMs?: number;
}

export interface GateResult {
	gate: Gate;
	passed: boolean;
	output: string;
}
