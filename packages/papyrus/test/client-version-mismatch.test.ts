/**
 * Real spawned-subprocess coverage for connectPapyrusClient's stale-daemon
 * detection: managed clients leave replacement to Armada, explicitly standalone
 * clients may replace their daemon, and a version match leaves it alone.
 * connectWithVersionCheck's mechanics are covered by @danypops/vehicle-client;
 * this suite proves Papyrus's ownership-policy wiring.
 *
 * A real daemon always truthfully reports its own real version over
 * /health, so `expectedVersion` (test-only) forces the mismatch instead of
 * requiring a second, differently-versioned build.
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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, pollIntervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	return predicate();
}

describe("connectPapyrusClient -- real stale-daemon detection and self-heal", () => {
	it("leaves a managed stale daemon running for Armada to restart", async () => {
		const root = tempDir("papyrus-managed-version-mismatch-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const first = await connectPapyrusClient(dir, { env, autoStart: true });
		const originalHandle = readDaemonHandle(dir);
		expect(originalHandle?.pid).toBeGreaterThan(0);

		try {
			await expect(connectPapyrusClient(dir, { env, expectedVersion: "999.999.999" })).rejects.toThrow(/restart the daemon manually/);
			expect(isProcessAlive(originalHandle!.pid)).toBe(true);
			expect(readDaemonHandle(dir)).toEqual(originalHandle);
			await expect(first.health()).resolves.toMatchObject({ ok: true });
		} finally {
			if (originalHandle?.pid) {
				try {
					process.kill(originalHandle.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}, 15_000);

	it("replaces a standalone stale daemon when auto-start is explicitly enabled", async () => {
		const root = tempDir("papyrus-version-mismatch-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const first = await connectPapyrusClient(dir, { env, autoStart: true });
		const firstHealth = await first.health();
		const originalHandle = readDaemonHandle(dir);
		expect(originalHandle?.pid).toBeGreaterThan(0);

		try {
			// Higher than any real version -- this client is the one that's up to date, the running
			// daemon is the genuinely stale side, which is what should trigger a kill+respawn.
			const healed = await connectPapyrusClient(dir, { env, autoStart: true, expectedVersion: "999.999.999" });

			const originalKilled = await waitUntil(() => !isProcessAlive(originalHandle!.pid), 3_000);
			expect(originalKilled).toBe(true);

			const healedHandle = readDaemonHandle(dir);
			expect(healedHandle?.pid).toBeGreaterThan(0);
			expect(healedHandle?.pid).not.toBe(originalHandle?.pid);

			const healedHealthCheck = await healed.health();
			expect(healedHealthCheck.ok).toBe(true);
			expect(healedHealthCheck.version).toBe(firstHealth.version);
		} finally {
			const finalHandle = readDaemonHandle(dir);
			if (finalHandle?.pid) {
				try {
					process.kill(finalHandle.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}, 20_000);

	it("returns the same daemon unchanged when the version matches -- no kill, no respawn", async () => {
		const root = tempDir("papyrus-version-match-");
		const dir = `${root}/daemon-dir`;
		const env = isolatedEnv(root);

		const first = await connectPapyrusClient(dir, { env, autoStart: true });
		await first.health();
		const handleAfterFirst = readDaemonHandle(dir);

		try {
			const second = await connectPapyrusClient(dir, { env, autoStart: true });
			await second.health();
			const handleAfterSecond = readDaemonHandle(dir);

			expect(handleAfterSecond).toEqual(handleAfterFirst);
		} finally {
			if (handleAfterFirst?.pid) {
				try {
					process.kill(handleAfterFirst.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}, 15_000);
});
