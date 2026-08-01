import { afterAll, describe, expect, it } from "bun:test";
import { connectPapyrusClient } from "../src/client.ts";
import { readDaemonHandle } from "../src/daemon-state.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

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
