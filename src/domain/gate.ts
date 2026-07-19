export interface Gate {
	type: "file-exists" | "command" | "contains" | "test";
	target: string;
	expect?: string;
}

export interface GateResult {
	gate: Gate;
	passed: boolean;
	output: string;
}
