import { GATE_TIMEOUT_MAX_MS } from "../constants.ts";

export const GATE_TYPES = ["file-exists", "command", "contains", "test"] as const;
export type GateType = (typeof GATE_TYPES)[number];

export interface Gate {
	type: GateType;
	target: string;
	expect?: string;
	/** Overrides GATE_COMMAND_TIMEOUT_MS/GATE_TEST_TIMEOUT_MS for this one "command"/"test" gate, bounded by GATE_TIMEOUT_MAX_MS (see its own doc comment). */
	timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a Gate[] the same way validateChecklist validates a Checklist -- gates previously had
 * no validation at all (create() assigned `input.gates` to extra verbatim), and no way to change
 * them after creation except by re-typing the whole task, silently accepted by "tasks update"
 * (which only ever reads title/body/labels/status) as if it had worked. See Tasks.setGates.
 */
export function validateGates(value: unknown): Gate[] {
	if (!Array.isArray(value)) throw new Error("gates must be an array");
	return value.map((entry, index) => {
		if (!isRecord(entry) || !GATE_TYPES.includes(entry.type as GateType)) {
			throw new Error(`gate at index ${index} requires a valid type (${GATE_TYPES.join(", ")})`);
		}
		if (typeof entry.target !== "string" || entry.target.trim().length === 0) {
			throw new Error(`gate at index ${index} requires a non-empty target`);
		}
		if (entry.expect !== undefined && typeof entry.expect !== "string") {
			throw new Error(`gate at index ${index} expect must be a string`);
		}
		if (
			entry.timeoutMs !== undefined &&
			(!Number.isInteger(entry.timeoutMs) || (entry.timeoutMs as number) < 1_000 || (entry.timeoutMs as number) > GATE_TIMEOUT_MAX_MS)
		) {
			throw new Error(`gate at index ${index} timeoutMs must be an integer between 1000 and ${GATE_TIMEOUT_MAX_MS}`);
		}
		return {
			type: entry.type as GateType,
			target: entry.target,
			...(typeof entry.expect === "string" ? { expect: entry.expect } : {}),
			...(typeof entry.timeoutMs === "number" ? { timeoutMs: entry.timeoutMs } : {}),
		};
	});
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
