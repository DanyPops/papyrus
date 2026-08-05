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
 * 2. What actually happens when two clients genuinely disagree about the expected version --
 *    a one-time self-heal (already covered for a single client by
 *    client-version-mismatch.test.ts), or does respawning ever change the *daemon's own*
 *    reported version such that disagreement could persist across repeated respawns?
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
		const seed = await connectPapyrusClient(dir, { env });
		await seed.health();
		const originalPid = readDaemonHandle(dir)?.pid;
		expect(originalPid).toBeGreaterThan(0);

		try {
			// Every call below defaults to the SAME PAPYRUS_VERSION (no expectedVersion override) --
			// exactly the real-world condition (many Pi tool calls, one client module, one shared
			// expectation) that live observation showed churning in practice.
			const results = await Promise.all(
				Array.from({ length: 10 }, async () => {
					const client = await connectPapyrusClient(dir, { env });
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

	it("a respawned daemon still reports its own real version -- a permanently wrong expectedVersion keeps re-triggering kills, not a one-time self-heal", async () => {
		const root = tempDir("papyrus-version-churn-disagree-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const seed = await connectPapyrusClient(dir, { env });
		const realVersion = (await seed.health()).version;
		const originalPid = readDaemonHandle(dir)?.pid;

		try {
			// A client whose own expectation is permanently wrong (unlike the real incident, where
			// the daemon's own code was genuinely stale and a respawn genuinely fixed it): the
			// respawned daemon runs the exact same source, so it reports the exact same real
			// version -- proving whether this client would consider it fixed, or keep retrying.
			const disagreeing = await connectPapyrusClient(dir, { env, expectedVersion: "0.0.0-permanently-wrong" });
			const disagreeingHealth = await disagreeing.health();

			// The respawn happened (pid changed, per client-version-mismatch.test.ts's own proven
			// behavior) -- but the new daemon's real reported version is unchanged.
			expect(disagreeingHealth.version).toBe(realVersion);
			const afterFirstRespawnPid = readDaemonHandle(dir)?.pid;
			expect(afterFirstRespawnPid).not.toBe(originalPid);

			// The same permanently-wrong client, connecting again, still disagrees -- if this kills
			// and respawns AGAIN, a client with a stale expectation causes unbounded, repeating
			// churn on every single call for as long as it keeps calling, not a one-time fix.
			const disagreeingAgain = await connectPapyrusClient(dir, { env, expectedVersion: "0.0.0-permanently-wrong" });
			await disagreeingAgain.health();
			const afterSecondRespawnPid = readDaemonHandle(dir)?.pid;
			expect(afterSecondRespawnPid).not.toBe(afterFirstRespawnPid);
		} finally {
			killIfAlive(readDaemonHandle(dir)?.pid);
		}
	}, 25_000);
});
