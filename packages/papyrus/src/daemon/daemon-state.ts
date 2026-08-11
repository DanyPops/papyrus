import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOOPBACK_HOST, removeDaemonHandle, resolveSharedVehicleHandlePath, writeDaemonHandle } from "@danypops/vehicle-server/paths";
import {
	DAEMON_DIR_ENV,
	DAEMON_HANDLE_FILE,
	DAEMON_HOST,
	DAEMON_LIFECYCLE_FILE,
	DAEMON_PORT_FILE,
	DAEMON_TOKEN_FILE,
} from "../constants.ts";

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

/** Where the structured daemon lifecycle event log (@danypops/vehicle-server's daemon-lifecycle.ts) persists start/stop/already_running history across restarts -- see daemon.ts's diagnose wiring. */
export function lifecyclePath(dir: string): string {
	return join(dir, DAEMON_LIFECYCLE_FILE);
}

/** vehicle-server's own {host,port,pid} handle format, distinct from this file's port/token pair -- Armada's readiness probe (createHandleReadinessProbe) reads exactly this shape. */
export function writeVehicleHandle(dir: string, port: number, pid: number = process.pid): void {
	writeDaemonHandle(vehicleHandlePath(dir), { host: LOOPBACK_HOST, port, pid });
}

export function clearVehicleHandle(dir: string): void {
	removeDaemonHandle(vehicleHandlePath(dir));
}

/** Where the private auth token lives -- passed as SharedVehicleHandleEntry.tokenPath so a broker-mode discoverer with read access to it can authenticate against Papyrus. */
export function tokenPath(dir: string): string {
	return join(dir, DAEMON_TOKEN_FILE);
}

/** Papyrus's own stable identity name in the shared Vehicle Handle Directory (see @danypops/vehicle-server's resolveSharedVehicleHandlePath) -- must match the ownVehicleName Vehicle Shell broker mode is registered under. */
export const PAPYRUS_VEHICLE_NAME = "papyrus";

/**
 * Writes Papyrus's entry into the shared, cross-package Vehicle Handle Directory (independent of
 * writeVehicleHandle's own private per-package handle file above) -- the seam a broker-mode
 * tools_list/tools_man discovery scan reads without needing to already know Papyrus's own
 * daemonStateDir convention in advance. env is injectable for tests; defaults to process.env.
 */
export function writeSharedVehicleHandle(
	port: number,
	tokenFilePath: string,
	pid: number = process.pid,
	env: Record<string, string | undefined> = process.env,
): void {
	writeDaemonHandle(resolveSharedVehicleHandlePath(PAPYRUS_VEHICLE_NAME, { env }), {
		host: LOOPBACK_HOST,
		port,
		pid,
		tokenPath: tokenFilePath,
	});
}

export function clearSharedVehicleHandle(env: Record<string, string | undefined> = process.env): void {
	removeDaemonHandle(resolveSharedVehicleHandlePath(PAPYRUS_VEHICLE_NAME, { env }));
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
