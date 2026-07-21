#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPapyrusClient, type PapyrusClient } from "./client.ts";
import { DAEMON_UNIT_NAME, TASK_EXECUTION_MAX_NODES } from "./constants.ts";
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
  papyrus migrate schema [--json]
  papyrus discourse store <action> --store-id <id> [--input-json <json>] [--json]
  papyrus graph history [--id <artifact-id>] [--actor <actor>] [--session-id <id>] [--since <rfc3339>] [--limit <count>] [--cursor <id>] [--direction <asc|desc>] [--json]
  papyrus skills run <id> [--arguments-json <json>] [--run-id <id>] [--json]
  papyrus notes capture <request> [--title <title>] [--json]
  papyrus notes list [--status <draft|active|archived>] [--text <query>] [--limit <count>] [--json]
  papyrus notes show <id> [--json]
  papyrus notes consume <id> [--reason <reason>] [--json]
  papyrus notes promote <id> <target-id> [--reason <reason>] [--json]
  papyrus notes archive <id> <completed|duplicate|declined|superseded> [--reason <reason>] [--json]
  papyrus tasks plan [--json]
  papyrus tasks graph [--json]
  papyrus tasks active [--json]
  papyrus tasks focused [--json]
  papyrus tasks pause [--json]
  papyrus tasks unpause [--json]
  papyrus tasks clear-focus [--json]
  papyrus tasks history <id> [--json]
  papyrus tasks scope [project|all|graph <root-id>] [--json]
  papyrus tasks assign-project <id> [project-root] [--json]
  papyrus tasks focus <id> [--json]
  papyrus tasks update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--status todo --reason <reason>] [--json]
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
type CliArtifact = { id: string; title: string; status: string; body?: string };
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
	if (positional.length !== 1 || positional[0] !== "schema") {
		throw new Error("migrate requires exactly `schema`");
	}
	const result = await client.call<Record<string, never>, MigrationResult>("system.migrate", {});
	if (json) return JSON.stringify(result);
	if (result.applied.length === 0) return `Schema already current at version ${result.to}.`;
	return `Migrated schema ${result.from} → ${result.to}: ${result.applied.join(", ")}`;
}

export async function runDiscourseCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let storeId: string | undefined;
	let operationInput: Record<string, unknown> = {};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--store-id" || argument === "--input-json") {
			const value = args[++index];
			if (!value) throw new Error(`${argument} requires a value`);
			if (argument === "--store-id") storeId = value;
			else {
				const parsed = JSON.parse(value) as unknown;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--input-json must be a JSON object");
				operationInput = parsed as Record<string, unknown>;
			}
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown discourse option ${argument}`);
		positional.push(argument);
	}
	if (positional.length !== 2 || positional[0] !== "store") throw new Error("discourse requires `store <action>`");
	if (!storeId) throw new Error("discourse store requires --store-id");
	const result = await client.call<Record<string, unknown>, unknown>("discourse.store", {
		action: positional[1], store_id: storeId, ...operationInput,
	});
	return json ? JSON.stringify(result) : `Discourse store ${positional[1]} completed.`;
}

export async function runSkillCli(args: string[], client: TaskCliClient, projectRoot: string = process.cwd()): Promise<string> {
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
	const input: Record<string, unknown> = { id: positional[1], arguments: arguments_, project_root: projectRoot };
	if (runId) input["run_id"] = runId;
	const result = await client.call<Record<string, unknown>, {
		runId: string;
		created: { tasks: string[]; rules: string[]; docs: string[] };
		rootTaskIds: string[];
		execution: TaskExecutionPlan;
	}>("skills.run", input);
	if (json) return JSON.stringify(result);
	return [
		`Created Skill run ${result.runId}: ${result.created.tasks.length} tasks, ${result.created.rules.length} rules, ${result.created.docs.length} docs`,
		`Ready roots: ${result.rootTaskIds.join(", ") || "none"}`,
		`Context docs: ${result.created.docs.join(", ") || "none"}`,
		`Scoped rules: ${result.created.rules.join(", ") || "none"}`,
		...result.execution.nodes.map((node) => `[${node.state}] ${node.id} ${node.title}`),
	].join("\n");
}

export async function runGraphCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	const input: Record<string, unknown> = {};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		const flags: Record<string, string> = {
			"--id": "id", "--actor": "actor", "--session-id": "session_id", "--since": "since",
			"--direction": "direction",
		};
		if (argument in flags) {
			const value = args[++index];
			if (!value) throw new Error(`${argument} requires a value`);
			input[flags[argument]!] = value;
			continue;
		}
		if (argument === "--limit" || argument === "--cursor") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error(`${argument} requires a numeric value`);
			input[argument.slice(2)] = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown graph option ${argument}`);
		positional.push(argument);
	}
	if (positional.length !== 1 || positional[0] !== "history") throw new Error("graph requires `history` with --id, --actor, or --session-id");
	const page = await client.call<Record<string, unknown>, import("./domain/artifact-event.ts").ArtifactEventPage>("graph.history", input);
	if (json) return JSON.stringify(page);
	if (page.events.length === 0) return "No recorded events.";
	return page.events.map((event) => {
		const transition = event.fromStatus || event.toStatus ? ` ${event.fromStatus ?? "\u2205"} \u2192 ${event.toStatus ?? "\u2205"}` : "";
		const relation = event.relation ? ` ${event.relation} \u2192 ${event.relatedId}` : "";
		return `${event.occurredAt} ${event.artifactId} ${event.type}${transition}${relation} \u00b7 ${event.actor}/${event.source}${event.sessionId ? ` \u00b7 ${event.sessionId}` : ""}`;
	}).join("\n");
}

export async function runNoteCli(args: string[], client: TaskCliClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let title: string | undefined;
	let status: string | undefined;
	let text: string | undefined;
	let reason: string | undefined;
	let limit: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (["--title", "--status", "--text", "--reason", "--limit"].includes(argument)) {
			const value = args[++index];
			if (value === undefined) throw new Error(`${argument} requires a value`);
			if (argument === "--title") title = value;
			else if (argument === "--status") status = value;
			else if (argument === "--text") text = value;
			else if (argument === "--reason") reason = value;
			else {
				limit = Number(value);
				if (!Number.isInteger(limit)) throw new Error("--limit requires an integer");
			}
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown notes option ${argument}`);
		positional.push(argument);
	}
	const [action, id, target] = positional;
	let result: CliArtifact | CliArtifact[];
	let human: string;
	if (action === "capture") {
		if (!id || target) throw new Error("notes capture requires exactly one request argument");
		result = await client.call("notes.capture", { body: id, ...(title ? { title } : {}), project_root: projectRoot, actor: "human", source: "cli" }) as CliArtifact;
		human = `Captured: ${artifactLabel(result)}`;
	} else if (action === "list") {
		if (id) throw new Error("notes list accepts no positional arguments");
		result = await client.call("notes.list", { project_root: projectRoot, ...(status ? { status } : {}), ...(text ? { text } : {}), ...(limit === undefined ? {} : { limit }) }) as CliArtifact[];
		human = result.length > 0 ? result.map((note) => `[${note.status}] ${artifactLabel(note)}`).join("\n") : "No open notes.";
	} else if (action === "show") {
		if (!id || target) throw new Error("notes show requires exactly one note id");
		result = await client.call("notes.show", { id, project_root: projectRoot }) as CliArtifact;
		human = `${artifactLabel(result)}\n\n${result.body ?? ""}`.trimEnd();
	} else if (action === "consume") {
		if (!id || target) throw new Error("notes consume requires exactly one note id");
		result = await client.call("notes.consume", { id, project_root: projectRoot, actor: "agent", source: "cli", ...(reason ? { reason } : {}) }) as CliArtifact;
		human = `Consumed: ${artifactLabel(result)}`;
	} else if (action === "promote") {
		if (!id || !target || positional.length !== 3) throw new Error("notes promote requires a note id and target artifact id");
		result = await client.call("notes.promote", { id, target_id: target, project_root: projectRoot, actor: "agent", source: "cli", ...(reason ? { reason } : {}) }) as CliArtifact;
		human = `Promoted: ${artifactLabel(result)} → ${target}`;
	} else if (action === "archive") {
		if (!id || !target || positional.length !== 3) throw new Error("notes archive requires a note id and disposition");
		result = await client.call("notes.archive", { id, disposition: target, project_root: projectRoot, actor: "human", source: "cli", ...(reason ? { reason } : {}) }) as CliArtifact;
		human = `Archived: ${artifactLabel(result)} · ${target}`;
	} else {
		throw new Error("notes action must be capture, list, show, consume, promote, or archive");
	}
	return json ? JSON.stringify(result) : human;
}

export async function runTaskCli(args: string[], client: TaskCliClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	const updateInput: { title?: string; body?: string; labels?: string[]; status?: "todo" } = {};
	let reason: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--title" || argument === "--body" || argument === "--labels-json" || argument === "--status" || argument === "--reason") {
			const value = args[++index];
			if (value === undefined) throw new Error(`${argument} requires a value`);
			if (argument === "--title") updateInput.title = value;
			else if (argument === "--body") updateInput.body = value;
			else if (argument === "--reason") reason = value;
			else if (argument === "--status") {
				if (value !== "todo") throw new Error("--status only supports todo for accidental creation recovery");
				updateInput.status = value;
			} else {
				const parsed = JSON.parse(value) as unknown;
				if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("--labels-json requires a JSON string array");
				updateInput.labels = parsed as string[];
			}
			continue;
		}
		positional.push(argument);
	}
	const [action, id, dependencyId] = positional;
	if (reason !== undefined && action !== "update") throw new Error("--reason is only supported by tasks update");
	let result: unknown;
	let human: string;
	switch (action) {
		case "active": {
			if (id) throw new Error("tasks active accepts no positional arguments");
			const active = await client.call<Record<string, string>, CliArtifact | null>("tasks.active", { project_root: projectRoot });
			result = active;
			human = active ? `Active: ${artifactLabel(active)}` : "No active task.";
			break;
		}
		case "focused": {
			if (id) throw new Error("tasks focused accepts no positional arguments");
			const focus = await client.call<Record<string, string>, { artifact: CliArtifact; status: "active" | "paused"; updatedAt: string } | null>("tasks.focused", { project_root: projectRoot });
			result = focus;
			human = focus ? `Focused (${focus.status}): ${artifactLabel(focus.artifact)}` : "No focused task.";
			break;
		}
		case "pause":
		case "unpause": {
			if (id) throw new Error(`tasks ${action} accepts no positional arguments`);
			const operation = action === "pause" ? "tasks.pause" : "tasks.unpause";
			const focus = await client.call<Record<string, string>, { artifact: CliArtifact; status: string }>(operation, { actor: "user", source: "cli" });
			result = focus;
			human = `Focused (${focus.status}): ${artifactLabel(focus.artifact)}`;
			break;
		}
		case "clear-focus": {
			if (id) throw new Error("tasks clear-focus accepts no positional arguments");
			const cleared = await client.call<Record<string, string>, { cleared: boolean }>("tasks.clear_focus", { actor: "user", source: "cli" });
			result = cleared;
			human = cleared.cleared ? "Task focus cleared." : "No focused task.";
			break;
		}
		case "update": {
			if (!id || dependencyId) throw new Error("tasks update requires exactly one task id");
			if (Object.keys(updateInput).length === 0) throw new Error("tasks update requires --title, --body, --labels-json, or --status todo");
			if (updateInput.status !== undefined && !reason?.trim()) throw new Error("tasks update --status requires --reason");
			if (reason !== undefined && updateInput.status === undefined) throw new Error("tasks update --reason requires --status todo");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.update", {
				id, ...updateInput, ...(reason ? { reason } : {}), actor: "user", source: "cli",
			});
			result = artifact;
			human = `Updated: ${artifactLabel(artifact)}`;
			break;
		}
		case "history": {
			if (!id || dependencyId) throw new Error("tasks history requires exactly one task id");
			const page = await client.call<{ id: string; direction: "desc" }, import("./domain/task-event.ts").TaskHistoryPage>("tasks.history", { id, direction: "desc" });
			result = page;
			human = page.events.length === 0
				? `No recorded history for ${id}.`
				: [...page.events].reverse().map((event) => `${event.occurredAt} ${event.type} ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"} · ${event.actor}/${event.source}${event.reason ? ` · ${event.reason}` : ""}`).join("\n");
			break;
		}
		case "scope": {
			if (!id) {
				const selection = await client.call<Record<string, string>, import("./domain/task-scope.ts").TaskViewSelection>("tasks.scope", { project_root: projectRoot });
				result = selection;
				human = `Task scope: ${selection.label}`;
				break;
			}
			if (id !== "project" && id !== "all" && id !== "graph") throw new Error("tasks scope mode must be project, all, or graph");
			if (id === "graph" && !dependencyId) throw new Error("tasks scope graph requires a root task id");
			if (id !== "graph" && dependencyId) throw new Error(`tasks scope ${id} accepts no root task id`);
			const selection = await client.call<Record<string, unknown>, import("./domain/task-scope.ts").TaskViewSelection>("tasks.set_scope", {
				project_root: projectRoot,
				scope: id,
				...(dependencyId ? { root_task_id: dependencyId } : {}),
			});
			result = selection;
			human = `Task scope: ${selection.label}`;
			break;
		}
		case "assign-project": {
			if (!id || positional.length > 3) throw new Error("tasks assign-project requires a task id and optional project root");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.assign_project", {
				id,
				project_root: dependencyId ?? projectRoot,
				actor: "user",
				source: "cli",
			});
			result = artifact;
			human = `Project assigned: ${artifactLabel(artifact)}`;
			break;
		}
		case "focus": {
			if (!id || dependencyId) throw new Error("tasks focus requires exactly one task id");
			const active = await client.call<Record<string, string>, CliArtifact>("tasks.focus", { id, actor: "user", source: "cli" });
			result = active;
			human = `Active: ${artifactLabel(active)}`;
			break;
		}
		case "graph": {
			if (id) throw new Error("tasks graph accepts no positional arguments");
			const graph = await client.call<{ limit: number; project_root: string }, {
				nodes: Array<{ dependencyIds: string[]; childIds: string[] }>;
				rootIds: string[];
			}>("tasks.graph", { limit: TASK_EXECUTION_MAX_NODES + 1, project_root: projectRoot });
			result = graph;
			const dependencies = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
			const children = graph.nodes.reduce((count, node) => count + node.childIds.length, 0);
			human = `Task graph: ${graph.nodes.length} nodes, ${graph.rootIds.length} roots, ${dependencies} dependencies, ${children} containment edges`;
			break;
		}
		case "plan": {
			if (id) throw new Error("tasks plan accepts no positional arguments");
			const plan = await client.call<Record<string, string>, TaskExecutionPlan>("tasks.plan", { project_root: projectRoot });
			result = plan;
			human = planText(plan);
			break;
		}
		case "complete": {
			if (!id || dependencyId) throw new Error("tasks complete requires exactly one task id");
			const completion = await client.call<Record<string, string>, CliCompletion>("tasks.complete", { id, actor: "user", source: "cli" });
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
			const artifact = await client.call<Record<string, string>, CliArtifact>("tasks.start", { id, actor: "user", source: "cli" });
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
			const artifact = await client.call<Record<string, string>, CliArtifact>(operation, { id, actor: "user", source: "cli" });
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
			throw new Error("tasks action must be active, focused, focus, pause, unpause, clear-focus, update, graph, plan, history, scope, assign-project, complete, start, submit, reject, retry, cancel, or depend");
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
	if (command === "discourse") {
		const client = await connectPapyrusClient();
		console.log(await runDiscourseCli(args.slice(1), client));
		return;
	}
	if (command === "skills") {
		const client = await connectPapyrusClient();
		console.log(await runSkillCli(args.slice(1), client));
		return;
	}
	if (command === "notes") {
		const client = await connectPapyrusClient();
		console.log(await runNoteCli(args.slice(1), client));
		return;
	}
	if (command === "migrate") {
		const client = await connectPapyrusClient();
		console.log(await runMigrationCli(args.slice(1), client));
		return;
	}
	if (command === "graph") {
		const client = await connectPapyrusClient();
		console.log(await runGraphCli(args.slice(1), client));
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
