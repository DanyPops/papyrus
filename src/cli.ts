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
  papyrus migrate task-lifecycle [--json]
  papyrus skills run <id> [--arguments-json <json>] [--run-id <id>] [--json]
  papyrus tasks plan [--json]
  papyrus tasks active [--json]
  papyrus tasks focus <id> [--json]
  papyrus tasks complete <id> [--json]
  papyrus tasks start <id> [--json]
  papyrus tasks submit <id> [--json]
  papyrus tasks reject <id> [--json]
  papyrus tasks retry <id> [--json]
  papyrus tasks cancel <id> [--json]
  papyrus tasks depend <id> <prerequisite-id> [--json]`;

function usage(): never {
	console.error(USAGE);
	process.exit(2);
}

type TaskCliClient = Pick<PapyrusClient, "call">;
type MigrationResult = { from: number; to: number; applied: string[] };
type CliArtifact = { id: string; title: string; status: string };
type CliCompletion = Omit<TaskCompletion, "artifact" | "blocked"> & {
	artifact: CliArtifact;
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

export async function runMigrationCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	if (positional.length !== 1 || positional[0] !== "task-lifecycle") {
		throw new Error("migrate requires exactly `task-lifecycle`");
	}
	const result = await client.call<Record<string, never>, MigrationResult>("system.migrate", {});
	if (json) return JSON.stringify(result);
	if (result.applied.length === 0) return `Schema already current at version ${result.to}.`;
	return `Migrated schema ${result.from} → ${result.to}: ${result.applied.join(", ")}`;
}

export async function runSkillCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let runId: string | undefined;
	let arguments_: Record<string, unknown> = {};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--run-id") {
			runId = args[++index];
			if (!runId) throw new Error("--run-id requires a value");
			continue;
		}
		if (argument === "--arguments-json") {
			const source = args[++index];
			if (!source) throw new Error("--arguments-json requires a JSON object");
			const parsed = JSON.parse(source) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("--arguments-json must be a JSON object");
			}
			arguments_ = parsed as Record<string, unknown>;
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown skills option ${argument}`);
		positional.push(argument);
	}
	if (positional.length !== 2 || positional[0] !== "run") throw new Error("skills requires `run <id>`");
	const input: Record<string, unknown> = { id: positional[1], arguments: arguments_ };
	if (runId) input["run_id"] = runId;
	const result = await client.call<Record<string, unknown>, {
		runId: string;
		created: { tasks: string[]; rules: string[]; docs: string[] };
		rootTaskIds: string[];
	}>("skills.run", input);
	if (json) return JSON.stringify(result);
	return `Created Skill run ${result.runId}: ${result.created.tasks.length} tasks, ${result.created.rules.length} rules, ${result.created.docs.length} docs; ready roots: ${result.rootTaskIds.join(", ") || "none"}`;
}

export async function runTaskCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	const [action, id, dependencyId] = positional;
	let result: unknown;
	let human: string;
	switch (action) {
		case "active": {
			if (id) throw new Error("tasks active accepts no positional arguments");
			const active = await client.call<Record<string, never>, CliArtifact | null>("tasks.active", {});
			result = active;
			human = active ? `Active: ${artifactLabel(active)}` : "No active task.";
			break;
		}
		case "focus": {
			if (!id || dependencyId) throw new Error("tasks focus requires exactly one task id");
			const active = await client.call<{ id: string }, CliArtifact>("tasks.focus", { id });
			result = active;
			human = `Active: ${artifactLabel(active)}`;
			break;
		}
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
			const lines = [`${completion.completed ? "Completed" : "Rejected"}: ${artifactLabel(completion.artifact)}`];
			if (completion.focused) lines.push(`Active: ${artifactLabel(completion.focused)}`);
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
		case "submit":
		case "reject":
		case "retry":
		case "cancel": {
			if (!id || dependencyId) throw new Error(`tasks ${action} requires exactly one task id`);
			const operation = `tasks.${action}` as "tasks.submit" | "tasks.reject" | "tasks.retry" | "tasks.cancel";
			const artifact = await client.call<{ id: string }, CliArtifact>(operation, { id });
			result = artifact;
			human = `${action[0]!.toUpperCase()}${action.slice(1)}: ${artifactLabel(artifact)}`;
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
			throw new Error("tasks action must be active, focus, plan, complete, start, submit, reject, retry, cancel, or depend");
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
	if (command === "skills") {
		const client = await connectPapyrusClient();
		console.log(await runSkillCli(args.slice(1), client));
		return;
	}
	if (command === "migrate") {
		const client = await connectPapyrusClient();
		console.log(await runMigrationCli(args.slice(1), client));
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
