import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DAEMON_DIR_ENV,
	DAEMON_HOST,
	DAEMON_PORT_FILE,
	DAEMON_TOKEN_FILE,
} from "./constants.ts";

export interface DaemonHandle {
	baseUrl: string;
	token: string;
}

export function daemonStateDir(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	if (env[DAEMON_DIR_ENV]) return env[DAEMON_DIR_ENV];
	if (env["XDG_RUNTIME_DIR"]) return join(env["XDG_RUNTIME_DIR"], "papyrus");
	if (env["XDG_STATE_HOME"]) return join(env["XDG_STATE_HOME"], "papyrus");
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

export function writeDaemonPort(dir: string, port: number): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, DAEMON_PORT_FILE), `${port}\n`, { mode: 0o600 });
}

export function clearDaemonPort(dir: string): void {
	rmSync(join(dir, DAEMON_PORT_FILE), { force: true });
}

export function readDaemonHandle(dir: string): DaemonHandle | undefined {
	try {
		const token = readFileSync(join(dir, DAEMON_TOKEN_FILE), "utf8").trim();
		const port = Number(readFileSync(join(dir, DAEMON_PORT_FILE), "utf8").trim());
		if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
		return { baseUrl: `http://${DAEMON_HOST}:${port}`, token };
	} catch {
		return undefined;
	}
}
