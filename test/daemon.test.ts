import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStateDir, loadOrCreateToken, readDaemonHandle, writeDaemonPort } from "../src/daemon-state.ts";
import { renderSystemdUnit } from "../src/cli.ts";

describe("Papyrus daemon state", () => {
	it("uses explicit, runtime, then XDG state locations", () => {
		expect(daemonStateDir({ PAPYRUS_DAEMON_DIR: "/custom", XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u")).toBe("/custom");
		expect(daemonStateDir({ XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u")).toBe("/run/user/1/papyrus");
		expect(daemonStateDir({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe("/state/papyrus");
		expect(daemonStateDir({}, "/home/u")).toBe("/home/u/.local/state/papyrus");
	});

	it("persists a private token and daemon port handle", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-daemon-state-"));
		const first = loadOrCreateToken(dir);
		const second = loadOrCreateToken(dir);
		expect(first).toBe(second);
		expect(first.length).toBe(64);
		expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
		writeDaemonPort(dir, 43123);
		expect(readDaemonHandle(dir)).toEqual({ baseUrl: "http://127.0.0.1:43123", token: first });
	});
});

describe("Papyrus systemd service", () => {
	it("renders a restartable long-running user unit", () => {
		const unit = renderSystemdUnit({
			bunBin: "/home/u/.bun/bin/bun",
			cliPath: "/home/u/Projects/papyrus/src/cli.ts",
		});
		expect(unit).toContain("ExecStart=/home/u/.bun/bin/bun /home/u/Projects/papyrus/src/cli.ts serve");
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("WantedBy=default.target");
	});
});
