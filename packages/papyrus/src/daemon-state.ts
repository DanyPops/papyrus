import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOOPBACK_HOST, removeDaemonHandle, writeDaemonHandle } from "@danypops/vehicle-server/paths";
import { DAEMON_DIR_ENV, DAEMON_HANDLE_FILE, DAEMON_HOST, DAEMON_PORT_FILE, DAEMON_TOKEN_FILE } from "./constants.ts";

export interface DaemonHandle {
	baseUrl: string;
	token: string;
	host: string;
	port: number;
	pid: number;
}

export function daemonStateDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	if (env[DAEMON_DIR_ENV]) return env[DAEMON_DIR_ENV];
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "papyrus");
	if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, "papyrus");
	return join(home, ".local", "state", "papyrus");
}

export function loadOrCreateToken(dir: string): string {
	const path = join(dir, DAEMON_TOKEN_FILE);
	try {
		const token = readFileSync(path, "utf8").trim();
		if (token) return token;
	} catch {
		// First daemon start.
	}
	const token = randomBytes(32).toString("hex");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${token}\n`, { mode: 0o600 });
	return token;
}

export function writeDaemonPort(dir: string, port: number, pid: number = process.pid): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, DAEMON_PORT_FILE), `${port}\n${pid}\n`, { mode: 0o600 });
}

export function clearDaemonPort(dir: string): void {
	rmSync(join(dir, DAEMON_PORT_FILE), { force: true });
}

/** Where Armada's readiness probe looks once Papyrus is service-installed -- see cli.ts's papyrusServiceSpec. */
export function vehicleHandlePath(dir: string): string {
	return join(dir, DAEMON_HANDLE_FILE);
}

/** vehicle-server's own {host,port,pid} handle format, distinct from this file's port/token pair -- Armada's readiness probe (createHandleReadinessProbe) reads exactly this shape. */
export function writeVehicleHandle(dir: string, port: number, pid: number = process.pid): void {
	writeDaemonHandle(vehicleHandlePath(dir), { host: LOOPBACK_HOST, port, pid });
}

export function clearVehicleHandle(dir: string): void {
	removeDaemonHandle(vehicleHandlePath(dir));
}

export function readDaemonHandle(dir: string): DaemonHandle | undefined {
	try {
		const token = readFileSync(join(dir, DAEMON_TOKEN_FILE), "utf8").trim();
		const lines = readFileSync(join(dir, DAEMON_PORT_FILE), "utf8").trim().split("\n");
		const port = Number(lines[0]);
		// pid is absent for a handle written before this field existed -- 0 is a safe
		// "unknown" sentinel (never a real pid), not a crash. Nothing currently reads
		// pid to make a kill/staleness decision, so a stale 0 is inert, not unsafe.
		const pid = lines[1] ? Number(lines[1]) : 0;
		if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
		return { baseUrl: `http://${DAEMON_HOST}:${port}`, token, host: DAEMON_HOST, port, pid };
	} catch {
		return undefined;
	}
}
