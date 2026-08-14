/**
 * Reproduction for task 65fa7bc2 / 197a4f6e: live journalctl/pgrep observation showed the
 * daemon's own lock-holder pid changing every ~1.5s under ordinary tool-call load, with
 * intermittent client failures during each cycle -- consistent with connectWithVersionCheck's
 * kill-stale-then-respawn path firing repeatedly against a daemon that isn't actually stale.
 * That evidence was gathered by polling a real running process, never reproduced as an
 * automated test. These two tests isolate the two live-plausible causes directly:
 *
 * 1. Does the daemon ever get killed/respawned when many clients connect concurrently but
 *    genuinely agree on the expected version (no real staleness at all)?
 * 2. What actually happens when a client's own expectedVersion is permanently wrong (lower
 *    than the real daemon's version, unlike a genuine post-upgrade staleness case) -- this
 *    used to keep re-triggering kill+respawn forever (the actual live incident: two installed
 *    copies of the same package, each with a different self-reported "correct" version,
 *    endlessly killing whatever the other one had just started). Fixed in
 *    @danypops/vehicle-client@0.6.2's connectWithVersionCheck: a client whose expectation is
 *    LOWER than the running daemon's real version is the stale side and is refused, never
 *    kills the daemon.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { connectPapyrusClient } from "../src/client.ts";
import { readDaemonHandle } from "../src/daemon/daemon-state.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

function isolatedEnv(root: string): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: root,
		XDG_DATA_HOME: `${root}/data`,
		XDG_STATE_HOME: `${root}/state`,
		XDG_RUNTIME_DIR: `${root}/run`,
	};
}

function killIfAlive(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		/* already gone */
	}
}

describe("connectPapyrusClient -- version-check churn under concurrent/disagreeing clients", () => {
	it("10 concurrent connects that all agree on the expected version never kill/respawn the daemon", async () => {
		const root = tempDir("papyrus-version-churn-agree-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		// Establishes the one real daemon every concurrent call below should find and reuse.
		const seed = await connectPapyrusClient(dir, { env, autoStart: true });
		await seed.health();
		const originalPid = readDaemonHandle(dir)?.pid;
		expect(originalPid).toBeGreaterThan(0);

		try {
			// Every call below defaults to the SAME PAPYRUS_VERSION (no expectedVersion override) --
			// exactly the real-world condition (many Pi tool calls, one client module, one shared
			// expectation) that live observation showed churning in practice.
			const results = await Promise.all(
				Array.from({ length: 10 }, async () => {
					const client = await connectPapyrusClient(dir, { env, autoStart: true });
					return client.health();
				}),
			);

			for (const health of results) expect(health.ok).toBe(true);

			const finalPid = readDaemonHandle(dir)?.pid;
			expect(finalPid).toBe(originalPid);
		} finally {
			killIfAlive(readDaemonHandle(dir)?.pid);
		}
	}, 20_000);

	it("a permanently-lower expectedVersion is refused on every call, never kills the real daemon, and never churns", async () => {
		const root = tempDir("papyrus-version-churn-disagree-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const seed = await connectPapyrusClient(dir, { env, autoStart: true });
		await seed.health();
		const originalPid = readDaemonHandle(dir)?.pid;

		try {
			// A client whose own expectation is permanently wrong AND lower than the real running
			// version -- exactly the live incident's shape (an older installed copy of the same
			// package disagreeing with a newer one already running). This must refuse, not kill.
			await expect(connectPapyrusClient(dir, { env, autoStart: true, expectedVersion: "0.0.0-permanently-wrong" })).rejects.toThrow(
				/daemon is running a newer version/,
			);
			expect(readDaemonHandle(dir)?.pid).toBe(originalPid);

			// Calling again changes nothing -- the same refusal, the same untouched daemon, not a
			// one-time exception that then falls back to the old kill-and-respawn churn.
			await expect(connectPapyrusClient(dir, { env, autoStart: true, expectedVersion: "0.0.0-permanently-wrong" })).rejects.toThrow(
				/daemon is running a newer version/,
			);
			expect(readDaemonHandle(dir)?.pid).toBe(originalPid);
		} finally {
			killIfAlive(readDaemonHandle(dir)?.pid);
		}
	}, 25_000);
});
