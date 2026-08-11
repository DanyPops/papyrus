/**
 * Gate-execution engine, split out of ops.ts (the artifact-CRUD file) as part of a SOLID-audit-
 * driven decomposition (see Doc "Modularity playbook: building-block-shaped TypeScript modules
 * for papyrus/pi-papyrus" and the "gate-execution engine" child of "Epic: Modularize papyrus/
 * pi-papyrus god-files into building-block modules"). This logic was already unified in a prior
 * refactor (sync/async outcome evaluation shared via evaluateProcessGateResult/spawnErrorGateResult)
 * but still lived inside the artifact-CRUD file until now.
 *
 * Only `runGates`/`runGatesAsync` are real public API -- verified via find_references before this
 * move, not assumed from a grep hit count: the only two real importers were
 * stores/sqlite-gate-runner.ts and test/ops.test.ts (every other `runGates`-named hit in the
 * codebase is Tasks.runGates, a same-named but distinct method that calls into this module only
 * indirectly, through the GateRunner port). Both were updated to import from this file directly;
 * no barrel re-export needed.
 *
 * Depends on ops.ts's own `getArtifact` (still the right owner of that read -- it's real
 * artifact-CRUD, not gate-execution's own concern) -- a one-directional dependency, since ops.ts
 * no longer needs to import anything back from here.
 */
import { createRequire } from "node:module";
import {
	GATE_COMMAND_TIMEOUT_MS,
	GATE_FILE_MAX_BYTES,
	GATE_MAX_BUFFER_BYTES,
	GATE_OUTPUT_LIMIT,
	GATE_TEST_TIMEOUT_MS,
} from "../constants.ts";
import type { Db } from "../db.ts";
import { getArtifact } from "../ops.ts";
import type { Gate, GateResult, GateRunOptions } from "./gate.ts";

const require_ = createRequire(import.meta.url);

function readBoundedGateFile(path: string): string {
	const { readFileSync, statSync } = require_("node:fs");
	if (statSync(path).size > GATE_FILE_MAX_BYTES) throw new Error(`file exceeds ${GATE_FILE_MAX_BYTES} bytes`);
	return readFileSync(path, "utf-8") as string;
}

/**
 * Shared by the sync and async process-gate runners so "test" is never a second, independently
 * maintained copy of "command"'s own command-template selection.
 *
 * "test" runs `gate.target` verbatim, exactly like "command" -- the only real difference is a
 * more generous default timeout (GATE_TEST_TIMEOUT_MS vs GATE_COMMAND_TIMEOUT_MS), since a test
 * suite routinely runs longer than an arbitrary command. It previously wrapped target in
 * `npx vitest run ${target} --reporter=dot`, silently wrong for every real consumer in this
 * ecosystem (all Bun-native, none use vitest): a target that was itself a full command (e.g.
 * `bun test path/to.test.ts`, exactly what every existing gate/checklist example here has always
 * shown) got parsed by vitest as three separate positional args, triggering vitest's own broad
 * discovery across the whole repo instead of running the intended command at all -- a real
 * incident (task ab1463e2) that produced an unrelated multi-suite vitest failure cascade instead
 * of the actual target ever running.
 */
function processGateCommand(gate: Gate): { command: string; timeout: number } {
	if (gate.type === "test") return { command: gate.target, timeout: gate.timeoutMs ?? GATE_TEST_TIMEOUT_MS };
	return { command: gate.target, timeout: gate.timeoutMs ?? GATE_COMMAND_TIMEOUT_MS };
}

/**
 * Keeps the LAST GATE_OUTPUT_LIMIT characters, not the first -- a real command's own meaningful
 * pass/fail summary is its last lines, not its first (setup/banner noise). See GATE_OUTPUT_LIMIT's
 * own doc comment (constants.ts) for the real incident this fixes.
 */
function gateOutputTail(text: string): string {
	return text.length > GATE_OUTPUT_LIMIT ? text.slice(-GATE_OUTPUT_LIMIT) : text;
}

/**
 * The one place "did this process gate pass, and what should its display output say" is decided,
 * shared by the sync (runProcessGateSync) and async (executeGateCommand's caller) process-gate
 * runners -- previously two hand-copied inline checks that already had to be fixed twice, by
 * hand, more than once (gate.expect seeing stderr too; GATE_OUTPUT_LIMIT's truncation direction).
 * `matchable` must be the FULL captured output (bounded only by GATE_MAX_BUFFER_BYTES / Node's own
 * spawnSync maxBuffer, never GATE_OUTPUT_LIMIT), so gate.expect always sees the whole run, never
 * the truncated display copy `output` becomes.
 */
function evaluateProcessGateResult(gate: Gate, code: number | null, matchable: string): { passed: boolean; output: string } {
	const exitedZero = code === 0;
	return {
		passed: exitedZero && (gate.expect ? matchable.includes(gate.expect) : true),
		output: gateOutputTail(matchable) || (exitedZero ? "ok" : `command exited with code ${code}`),
	};
}

/** The other shared branch: a literal spawn-level failure (command not found, spawnSync's own maxBuffer exceeded, etc.) -- distinct from a process that ran and exited non-zero, which evaluateProcessGateResult above handles. Identical treatment on both the sync and async paths: the raw error message, tail-truncated like any other gate output. */
function spawnErrorGateResult(gate: Gate, error: Error): GateResult {
	return { gate, passed: false, output: gateOutputTail(error.message) };
}

function runProcessGateSync(gate: Gate, cwd?: string): GateResult {
	const { spawnSync } = require_("node:child_process");
	const { command, timeout } = processGateCommand(gate);
	const result = spawnSync(command, { shell: true, encoding: "utf-8", timeout, ...(cwd ? { cwd } : {}) });
	if (result.error) return spawnErrorGateResult(gate, result.error);
	const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return { gate, ...evaluateProcessGateResult(gate, result.status, combined) };
}

/**
 * Runs one gate command with two invariants a prior implementation lacked (a real incident; see
 * GateRunOptions.cwd's doc comment):
 *   1. `cwd` is always explicit, never inherited from the daemon's own process cwd.
 *   2. The whole process group is killed on timeout, not just the immediate shell. `exec()`'s own
 *      `timeout` option only signals the process it directly spawned (the shell running
 *      `command`); a shell's own child (e.g. `bun` under `sh -c "bun test"`) is not in general
 *      killed by that signal and can be reparented and keep running -- and consuming memory --
 *      indefinitely after Papyrus considers the gate "timed out". Spawning detached (its own
 *      process group) and killing the negated pid on our own timer reaches the whole tree.
 */
function executeGateCommand(gate: Gate, command: string, timeout: number, cwd?: string): Promise<GateResult> {
	// `spawn(..., { shell: true, detached: true })` instead of the `exec()` convenience wrapper:
	// `detached` (needed to make the shell the leader of its own process group, so the negated pid
	// below reaches every descendant, not just the shell) is not part of Node's `exec()`/
	// `ExecOptions` type at all -- `spawn`'s options support it directly and correctly.
	const { spawn } = require_("node:child_process") as typeof import("node:child_process");
	return new Promise((resolve) => {
		let settled = false;
		let buffered = "";
		let truncated = false;
		const child = spawn(command, { shell: true, detached: true, ...(cwd ? { cwd } : {}) });

		const append = (chunk: Buffer): void => {
			if (truncated) return;
			buffered += chunk.toString("utf8");
			if (buffered.length > GATE_MAX_BUFFER_BYTES) {
				buffered = buffered.slice(0, GATE_MAX_BUFFER_BYTES);
				truncated = true;
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const finish = (result: GateResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.on("error", (error) => finish(spawnErrorGateResult(gate, error)));
		child.on("close", (code) => finish({ gate, ...evaluateProcessGateResult(gate, code, buffered.trim()) }));

		const timer = setTimeout(() => {
			if (settled) return;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
			finish({ gate, passed: false, output: `gate command timed out after ${timeout}ms` });
		}, timeout);
	});
}

function runNonProcessGate(gate: Gate): GateResult {
	if (gate.type === "file-exists") {
		const { existsSync } = require_("node:fs");
		const exists = existsSync(gate.target);
		return { gate, passed: exists, output: exists ? "exists" : "not found" };
	}
	if (gate.type === "contains") {
		try {
			const content = readBoundedGateFile(gate.target);
			const found = gate.expect ? content.includes(gate.expect) : content.length > 0;
			return { gate, passed: found, output: found ? "found" : `"${gate.expect ?? ""}" not found` };
		} catch {
			return { gate, passed: false, output: "file not readable" };
		}
	}
	return { gate, passed: false, output: `unknown gate type: ${String(gate.type)}` };
}

export function runGates(db: Db, artifactId: string, options: GateRunOptions = {}): GateResult[] {
	const art = getArtifact(db, artifactId);
	if (!art) throw new Error("artifact not found");
	const gates = (art.extra.gates as Gate[]) ?? [];
	const cwd = options.cwd;
	return gates.map((gate) => (gate.type === "command" || gate.type === "test" ? runProcessGateSync(gate, cwd) : runNonProcessGate(gate)));
}

/** Gate runner for daemon request paths; subprocess gates never block the event loop. */
export async function runGatesAsync(db: Db, artifactId: string, options: GateRunOptions = {}): Promise<GateResult[]> {
	const art = getArtifact(db, artifactId);
	if (!art) throw new Error("artifact not found");
	const gates = (art.extra.gates as Gate[]) ?? [];
	const results: GateResult[] = [];
	for (const gate of gates) {
		const remainingMs = options.deadlineMs === undefined ? undefined : options.deadlineMs - Date.now();
		if (remainingMs !== undefined && remainingMs <= 0) {
			results.push({ gate, passed: false, output: "gate runtime deadline exceeded" });
			continue;
		}
		if (gate.type === "command" || gate.type === "test") {
			const { command, timeout: configuredTimeout } = processGateCommand(gate);
			const timeout = remainingMs === undefined ? configuredTimeout : Math.max(1, Math.min(configuredTimeout, remainingMs));
			results.push(await executeGateCommand(gate, command, timeout, options.cwd));
		} else {
			results.push(runNonProcessGate(gate));
		}
	}
	return results;
}
