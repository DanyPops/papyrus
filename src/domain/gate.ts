export interface Gate {
	type: "file-exists" | "command" | "contains" | "test";
	target: string;
	expect?: string;
}

export interface GateRunOptions {
	/** Absolute Unix epoch deadline for the full gate sequence. */
	deadlineMs?: number;
	/**
	 * Working directory for "command"/"test" gates. Without this, a command gate inherits the
	 * Papyrus daemon's own process cwd (its systemd unit's launch directory, e.g. the user's home
	 * directory) rather than the task's project -- a real incident: a `bun test` command gate ran
	 * against the daemon's home directory instead of the task's project, recursively discovering
	 * and attempting to run every test file under every project on the machine, which exhausted
	 * memory and crashed the `bun` process outright (SIGILL/SIGABRT), well past the configured
	 * gate timeout because the timeout only ever terminated the immediate shell, not the process
	 * group it spawned (see executeGateCommand). Task-scoped completion must always pass the
	 * task's project_root here.
	 */
	cwd?: string;
}

export interface GateResult {
	gate: Gate;
	passed: boolean;
	output: string;
}
