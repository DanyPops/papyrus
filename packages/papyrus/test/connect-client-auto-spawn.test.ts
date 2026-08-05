import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDaemonHandle as readVehicleHandle } from "@danypops/vehicle-server/paths";
import { connectPapyrusClient } from "../src/client.ts";
import { DAEMON_DIR_ENV } from "../src/constants.ts";
import { readDaemonHandle, vehicleHandlePath } from "../src/daemon/daemon-state.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

/** connectPapyrusClient's own connectWithPolicy default -- see @danypops/vehicle-client's daemon-client.ts. A cold boot must finish well inside this or a real caller sees the exact CI-only hang this test guards against. */
const AUTOSTART_POLL_CEILING_MS = 5_000;

afterAll(cleanupTempDirs);

/**
 * Real subprocess integration -- mirrors web-spider's own connectOrStartWebSpiderClient
 * coverage (the one other ecosystem package that already opted into auto-start). A mock
 * spawn() would only prove connectWithPolicy's own wiring, already covered by
 * @danypops/vehicle-client's own test suite; what's specific to Papyrus and worth a real
 * process here is that cli.ts's own `serve` subcommand actually starts, binds a port, and
 * writes a handle this same call can read back -- and does so entirely inside an isolated
 * temp HOME/XDG root, never touching a real operator's ~/.local/share/papyrus/papyrus.db.
 */
function isolatedEnv(root: string): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: root,
		XDG_DATA_HOME: `${root}/data`,
		XDG_STATE_HOME: `${root}/state`,
		XDG_RUNTIME_DIR: `${root}/run`,
	};
}

describe("connectPapyrusClient -- real subprocess auto-spawn", () => {
	it("auto-starts the real daemon when none is running, then connects", async () => {
		const root = tempDir("papyrus-auto-spawn-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const client = await connectPapyrusClient(dir, { env });
		try {
			const health = await client.health();
			expect(health.ok).toBe(true);
		} finally {
			const handle = readDaemonHandle(dir);
			if (handle?.pid) {
				try {
					process.kill(handle.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}, 15_000);

	it("reuses an already-running daemon instead of starting a second one", async () => {
		const root = tempDir("papyrus-auto-spawn-reuse-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const first = await connectPapyrusClient(dir, { env });
		await first.health();
		const handleAfterFirst = readDaemonHandle(dir);

		const second = await connectPapyrusClient(dir, { env });
		await second.health();
		const handleAfterSecond = readDaemonHandle(dir);

		expect(handleAfterSecond).toEqual(handleAfterFirst);

		if (handleAfterFirst?.pid) {
			try {
				process.kill(handleAfterFirst.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}, 15_000);
});

/**
 * Regression for a real CI failure: pi-papyrus's own vehicle-notes-*.test.ts files called
 * registerPapyrus(api) + fired session_start without mocking callService's daemon connector, so
 * session_start's session.register call fell through to this exact real cold-boot path. Locally
 * that always raced against a real Papyrus daemon already running for unrelated reasons (fast:
 * a live health check, no spawn at all); a from-scratch CI runner has no such daemon and
 * exercises the real spawn+poll every time. Those two tests are now hermetic (see
 * vehicle-notes-session-start.test.ts / vehicle-notes-reconnect.test.ts) and no longer depend on
 * this timing at all -- this is the durable, harness-based replacement for the ad hoc bash timing
 * probes used to diagnose that failure, so a future regression in cli.ts's own boot path is
 * caught here directly instead of surfacing as an unexplained downstream CI hang.
 */
describe("cli.ts serve -- real subprocess cold-boot timing", () => {
	it("becomes ready (handle written, /health answering) well inside connectPapyrusClient's own autostart poll ceiling", async () => {
		const root = tempDir("papyrus-cold-boot-");
		const dir = `${root}/daemon-dir`;
		const env = { ...isolatedEnv(root), [DAEMON_DIR_ENV]: dir };

		// Spawned directly with node:child_process rather than @danypops/pi-process-harness's
		// spawnCompanionDaemon: that helper disposes its process and rethrows on a readiness
		// timeout without ever exposing it to the caller, so a real CI failure here previously
		// gave zero signal beyond "timed out" -- exactly the diagnostic gap that made a real,
		// 100%-reproducing CI regression (every real-daemon-spawn test in this file, including
		// the two above that predate this one, failing in GitHub Actions while passing locally)
		// take multiple blind round-trips to even localize. This keeps its own bounded stdout/
		// stderr capture and a diagnostic poll window well past the real regression bound below,
		// so a failure here always says exactly what the process did instead of just "timeout".
		const DIAGNOSTIC_POLL_TIMEOUT_MS = 20_000;
		const child = spawn("bun", [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "serve"], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-4_000);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
		});
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		child.on("exit", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
		});

		const startedAt = Date.now();
		let attempts = 0;
		let healthyBaseUrl: string | undefined;
		let healthyAfterMs: number | undefined;
		while (Date.now() - startedAt < DIAGNOSTIC_POLL_TIMEOUT_MS) {
			attempts++;
			const handle = readDaemonHandle(dir);
			if (handle) {
				try {
					const response = await fetch(`${handle.baseUrl}/health`, { headers: { authorization: `Bearer ${handle.token}` } });
					if (response.ok) {
						healthyBaseUrl = handle.baseUrl;
						healthyAfterMs = Date.now() - startedAt;
						break;
					}
				} catch {
					// keep polling -- a connection racing the daemon's own bind is expected early on.
				}
			}
			if (exitCode !== null || exitSignal !== null) break; // no point polling a dead process further.
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		try {
			if (!healthyBaseUrl) {
				throw new Error(
					`cli.ts serve never became ready after ${Date.now() - startedAt}ms (${attempts} attempts, dir=${dir}). ` +
						`Process exit: code=${exitCode} signal=${exitSignal}. stdout: ${stdout || "(empty)"} stderr: ${stderr || "(empty)"}`,
				);
			}
			// A real regression margin, not a tight race against connectPapyrusClient's own
			// AUTOSTART_POLL_CEILING_MS: a boot legitimately this slow already leaves no headroom for
			// its own health probe (DAEMON_PROBE_TIMEOUT_MS) and version check on top of this.
			expect(healthyAfterMs).toBeLessThan(AUTOSTART_POLL_CEILING_MS / 2);
			// Armada's own readiness probe (createHandleReadinessProbe) reads this exact file and
			// shape once Papyrus is service-installed -- proves the real subprocess writes it, not
			// just that daemon-state.ts's own helpers round-trip in isolation.
			const ownHandle = readDaemonHandle(dir);
			if (!ownHandle) throw new Error("expected a daemon handle to already exist -- healthyBaseUrl came from reading one");
			expect(readVehicleHandle(vehicleHandlePath(dir))).toEqual({ host: "127.0.0.1", port: ownHandle.port, pid: ownHandle.pid });
		} finally {
			if (exitCode === null && exitSignal === null) child.kill("SIGTERM");
		}
	}, 25_000);
});
