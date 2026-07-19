#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPapyrusClient, type PapyrusClient } from "./client.ts";
import { DAEMON_UNIT_NAME } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import type { GateResult } from "./domain/gate.ts";
import type { TaskExecutionPlan } from "./task-execution.ts";
import type { TaskBlockage, TaskCompletion } from "./task-service.ts";

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

const USAGE = `Usage:
  papyrus serve
  papyrus service <install|start|stop|restart|status>
  papyrus tasks plan [--json]
  papyrus tasks complete <id> [--json]
  papyrus tasks start <id> [--json]
  papyrus tasks depend <id> <prerequisite-id> [--json]`;

function usage(): never {
	console.error(USAGE);
	process.exit(2);
}

type TaskCliClient = Pick<PapyrusClient, "call">;
type CliArtifact = { id: string; title: string; status: string };
type CliCompletion = Omit<TaskCompletion, "artifact" | "started" | "blocked"> & {
	artifact: CliArtifact;
	started: CliArtifact[];
	blocked: Array<Omit<TaskBlockage, "artifact"> & { artifact: CliArtifact }>;
	gates: GateResult[];
};

function artifactLabel(artifact: CliArtifact): string {
	return `${artifact.id} ${artifact.title}`;
}

function planText(plan: TaskExecutionPlan): string {
	const byId = new Map(plan.nodes.map((node) => [node.id, node]));
	const lines = ["Execution order:"];
	plan.layers.forEach((layer, index) => {
		lines.push(`  Layer ${index + 1}:`);
		for (const id of layer) {
			const node = byId.get(id);
			lines.push(node ? `    [${node.state}] ${node.id} ${node.title}` : `    [unknown] ${id}`);
		}
	});
	if (plan.layers.length === 0) lines.push("  (no tasks)");
	if (plan.cycleIds.length > 0) lines.push(`  Invalid cycle: ${plan.cycleIds.join(", ")}`);
	return lines.join("\n");
}

export async function runTaskCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	const [action, id, dependencyId] = positional;
	let result: unknown;
	let human: string;
	switch (action) {
		case "plan": {
			if (id) throw new Error("tasks plan accepts no positional arguments");
			const plan = await client.call<Record<string, never>, TaskExecutionPlan>("tasks.plan", {});
			result = plan;
			human = planText(plan);
			break;
		}
		case "complete": {
			if (!id || dependencyId) throw new Error("tasks complete requires exactly one task id");
			const completion = await client.call<{ id: string }, CliCompletion>("tasks.complete", { id });
			result = completion;
			const lines = [`${completion.completed ? "Completed" : "Not completed"}: ${artifactLabel(completion.artifact)}`];
			if (completion.started.length > 0) lines.push(`Started: ${completion.started.map(artifactLabel).join(", ")}`);
			if (completion.blocked.length > 0) {
				lines.push(`Blocked: ${completion.blocked.map((entry) => `${artifactLabel(entry.artifact)} waits for ${entry.dependencyIds.join(", ")}`).join("; ")}`);
			}
			for (const gate of completion.gates) lines.push(`${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`);
			human = lines.join("\n");
			break;
		}
		case "start": {
			if (!id || dependencyId) throw new Error("tasks start requires exactly one task id");
			const artifact = await client.call<{ id: string }, CliArtifact>("tasks.start", { id });
			result = artifact;
			human = `Started: ${artifactLabel(artifact)}`;
			break;
		}
		case "depend": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks depend requires a task id and prerequisite id");
			const artifact = await client.call<{ id: string; dependency_id: string }, CliArtifact>("tasks.depend", {
				id,
				dependency_id: dependencyId,
			});
			result = artifact;
			human = `Dependency added: ${artifactLabel(artifact)} waits for ${dependencyId}`;
			break;
		}
		default:
			throw new Error("tasks action must be plan, complete, start, or depend");
	}
	return json ? JSON.stringify(result) : human;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	const [command, action] = args;
	if (command === "serve") { serveMain(); return; }
	if (command === "tasks") {
		const client = await connectPapyrusClient();
		console.log(await runTaskCli(args.slice(1), client));
		return;
	}
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

if (import.meta.main) {
	void main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
