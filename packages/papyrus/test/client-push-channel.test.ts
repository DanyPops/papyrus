import { afterAll, describe, expect, it } from "bun:test";
import { loadOrCreateToken, writeDaemonPort } from "../src/daemon-state.ts";
import { resolvePushChannelTarget } from "../src/client.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);

describe("resolvePushChannelTarget", () => {
	it("derives a ws:// URL from the same handle connectPapyrusClient reads, and reuses its token", () => {
		const dir = tempDir("papyrus-push-target-");
		const token = loadOrCreateToken(dir);
		writeDaemonPort(dir, 43123);

		expect(resolvePushChannelTarget(dir)).toEqual({ url: "ws://127.0.0.1:43123/push", token });
	});

	it("returns undefined when the daemon has never started (no port on disk)", () => {
		const dir = tempDir("papyrus-push-target-cold-");
		expect(resolvePushChannelTarget(dir)).toBeUndefined();
	});
});
