#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_UNIT_NAME } from "./constants.ts";
import { serveMain } from "./daemon.ts";

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return `[Unit]
Description=Papyrus graph artifact service
After=default.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function unitPath(): string {
	const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
	return join(configHome, "systemd", "user", DAEMON_UNIT_NAME);
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function installService(): void {
	const path = unitPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderSystemdUnit({
		bunBin: process.execPath,
		cliPath: fileURLToPath(import.meta.url),
	}));
	systemctl("daemon-reload");
	systemctl("enable", DAEMON_UNIT_NAME);
	systemctl("restart", DAEMON_UNIT_NAME);
}

function usage(): never {
	console.error("Usage: papyrus serve | service <install|start|stop|restart|status>");
	process.exit(2);
}

export function main(args: string[] = process.argv.slice(2)): void {
	const [command, action] = args;
	if (command === "serve") { serveMain(); return; }
	if (command !== "service") usage();
	switch (action) {
		case "install": installService(); break;
		case "start": systemctl("start", DAEMON_UNIT_NAME); break;
		case "stop": systemctl("stop", DAEMON_UNIT_NAME); break;
		case "restart": systemctl("restart", DAEMON_UNIT_NAME); break;
		case "status": systemctl("status", DAEMON_UNIT_NAME); break;
		default: usage();
	}
}

if (import.meta.main) main();
