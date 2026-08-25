import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquirePapyrusDaemonLock } from "../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterEach(cleanupTempDirs);

describe("Papyrus daemon lock ownership", () => {
	it("lets a service launch reclaim an auto-spawned holder", async () => {
		const dir = tempDir("papyrus-service-lock-");
		const lockPath = join(dir, "daemon.lock");
		const holderPid = 999_321;
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath, `${holderPid}\nauto-spawn\n`);
		let alive = true;
		const signals: NodeJS.Signals[] = [];

		const result = await acquirePapyrusDaemonLock(lockPath, "service", {
			isPidAlive: (pid) => pid === holderPid && alive,
			kill: (_pid, signal) => {
				signals.push(signal);
				alive = false;
			},
			sleep: async () => {},
		});

		expect(result).toEqual({ acquired: true });
		expect(signals).toEqual(["SIGTERM"]);
		rmSync(lockPath, { force: true });
	});
});
