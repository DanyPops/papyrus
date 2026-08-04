import { afterAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { spawnCompanionDaemon } from "@danypops/pi-process-harness";
import { connectPapyrusClient } from "../src/client.ts";
import { DAEMON_DIR_ENV } from "../src/constants.ts";
import { readDaemonHandle } from "../src/daemon-state.ts";
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

		// spawnCompanionDaemon disposes its process and rethrows on a readiness timeout without
		// exposing it to the caller -- this closure is the only diagnostic surface left for "why"
		// once that happens, so every attempt's own outcome is tracked here instead of discarded.
		let healthyBaseUrl: string | undefined;
		let attempts = 0;
		let lastObservation = "isReady was never called";
		const startedAt = Date.now();
		let daemon: Awaited<ReturnType<typeof spawnCompanionDaemon>> | undefined;
		try {
			daemon = await spawnCompanionDaemon({
				command: "bun",
				args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "serve"],
				env,
				isReady: async () => {
					attempts++;
					const handle = readDaemonHandle(dir);
					if (!handle) {
						lastObservation = `attempt ${attempts}: no handle file yet at ${dir}`;
						return false;
					}
					try {
						const response = await fetch(`${handle.baseUrl}/health`, { headers: { authorization: `Bearer ${handle.token}` } });
						if (!response.ok) {
							lastObservation = `attempt ${attempts}: handle=${handle.baseUrl} health returned HTTP ${response.status}`;
							return false;
						}
						healthyBaseUrl = handle.baseUrl;
						return true;
					} catch (error) {
						lastObservation = `attempt ${attempts}: handle=${handle.baseUrl} fetch threw: ${error instanceof Error ? error.message : String(error)}`;
						return false;
					}
				},
				readyTimeoutMs: AUTOSTART_POLL_CEILING_MS,
			});
		} catch (error) {
			throw new Error(
				`cli.ts serve never became ready after ${Date.now() - startedAt}ms (${attempts} attempts). Last observation: ${lastObservation}`,
				{ cause: error },
			);
		}
		const elapsedMs = Date.now() - startedAt;

		try {
			expect(healthyBaseUrl).toBeDefined();
			// A real regression margin, not a tight race against the ceiling itself: a boot legitimately
			// this slow already leaves no headroom for connectPapyrusClient's own health probe
			// (DAEMON_PROBE_TIMEOUT_MS) and version check on top, so treat half the ceiling as the real bound.
			expect(elapsedMs).toBeLessThan(AUTOSTART_POLL_CEILING_MS / 2);
		} finally {
			if (daemon.exitCode === null) await daemon.dispose();
		}
	}, 15_000);
});
