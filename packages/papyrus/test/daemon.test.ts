import { afterAll, describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { daemonStateDir, loadOrCreateToken, readDaemonHandle, writeDaemonPort } from "../src/daemon-state.ts";
import { renderSystemdUnit } from "../src/cli.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);

describe("Papyrus daemon state", () => {
	it("uses explicit, runtime, then XDG state locations", () => {
		expect(daemonStateDir({ PAPYRUS_DAEMON_DIR: "/custom", XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u")).toBe("/custom");
		expect(daemonStateDir({ XDG_RUNTIME_DIR: "/run/user/1" }, "/home/u")).toBe("/run/user/1/papyrus");
		expect(daemonStateDir({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe("/state/papyrus");
		expect(daemonStateDir({}, "/home/u")).toBe("/home/u/.local/state/papyrus");
	});

	it("persists a private token and daemon port handle", () => {
		const dir = tempDir("papyrus-daemon-state-");
		const first = loadOrCreateToken(dir);
		const second = loadOrCreateToken(dir);
		expect(first).toBe(second);
		expect(first.length).toBe(64);
		expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
		writeDaemonPort(dir, 43123, 99999);
		expect(readDaemonHandle(dir)).toEqual({ baseUrl: "http://127.0.0.1:43123", token: first, host: "127.0.0.1", port: 43123, pid: 99999 });
	});
});

describe("Papyrus systemd service", () => {
	// Delegates to vehicle-server's shared generateSystemdUnit (see cli.ts's papyrusServiceSpec) --
	// ExecStart is now shell-quoted per argument, and DAEMON_KIT_LAUNCH_PROVENANCE=service is now
	// always present (currently inert -- Papyrus's own daemon.ts doesn't read it, see cli.ts's
	// doc comment). Restart=always/RestartSec=2 preserved exactly as before.
	it("renders a restartable long-running user unit", () => {
		const unit = renderSystemdUnit({
			bunBin: "/home/u/.bun/bin/bun",
			cliPath: "/home/u/Projects/papyrus/src/cli.ts",
		});
		expect(unit).toContain('ExecStart="/home/u/.bun/bin/bun" "/home/u/Projects/papyrus/src/cli.ts" "serve"');
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("RestartSec=2");
		expect(unit).toContain("WantedBy=default.target");
	});
});
