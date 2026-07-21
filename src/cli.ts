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
  papyrus graph link <from> <relation> <to> [--json]
  papyrus graph unlink <from> <relation> <to> [--json]
  papyrus graph tree <id> [--depth <n>] [--max-nodes <n>] [--json]
  papyrus graph status <id> <status> [--json]
  papyrus graph history [--id <artifact-id>] [--actor <actor>] [--session-id <id>] [--since <rfc3339>] [--limit <count>] [--cursor <id>] [--direction <asc|desc>] [--json]
  papyrus gates run <id> [--json]
  papyrus artifact create --kind <kind> [--title <title>] [--status <status>] [--subtype <subtype>] [--body <body>] [--labels-json <json>] [--extra-json <json>] [--template-id <id>] [--json]
  papyrus artifact query [--kind <kind>] [--status <status>] [--text <query>] [--limit <count>] [--json]
  papyrus artifact show <id> [--depth <n>] [--max-nodes <n>] [--json]
  papyrus docs create --title <title> [--body <body>] [--subtype <subtype>] [--labels-json <json>] [--extra-json <json>] [--template-id <id>] [--json]
  papyrus docs list [--status <status>] [--text <query>] [--limit <count>] [--json]
  papyrus docs show <id> [--json]
  papyrus docs activate|archive|reopen <id> [--json]
  papyrus docs link <id> <relation> <target-id> [--json]
  papyrus rules create --title <title> [--body <body>] [--condition <text>] [--rule-action <text>] [--severity block|warn|info] [--labels-json <json>] [--extra-json <json>] [--json]
  papyrus rules list [--status <status>] [--text <query>] [--limit <count>] [--json]
  papyrus rules show <id> [--json]
  papyrus rules preview <id> [--json]
  papyrus rules enable|disable <id> [--json]
  papyrus rules gate <rule-id> <task-id> [--json]
  papyrus rules injectable [--json]
  papyrus skills run <id> [--arguments-json <json>] [--run-id <id>] [--json]
  papyrus skills create --title <title> [--body <body>] [--trigger <text>] [--steps-json <json>] [--tools-json <json>] [--definition-json <json>] [--labels-json <json>] [--extra-json <json>] [--json]
  papyrus skills create-template --title <title> --target-kind <kind> [--defaults-json <json>] [--required-json <json>] [--body <body>] [--labels-json <json>] [--json]
  papyrus skills list [--status <status>] [--text <query>] [--limit <count>] [--json]
  papyrus skills show <id> [--json]
  papyrus skills invoke <id> [--json]
  papyrus skills enable|disable <id> [--json]
  papyrus skills instantiate <template-id> [--title <title>] [--body <body>] [--status <status>] [--labels-json <json>] [--extra-json <json>] [--json]
  papyrus notes capture <request> [--title <title>] [--json]
  papyrus notes list [--status <draft|active|archived>] [--text <query>] [--limit <count>] [--json]
  papyrus notes show <id> [--json]
  papyrus notes consume <id> [--reason <reason>] [--json]
  papyrus notes promote <id> <target-id> [--reason <reason>] [--json]
  papyrus notes archive <id> <completed|duplicate|declined|superseded> [--reason <reason>] [--json]
  papyrus tasks plan [--session-id <id>] [--json]
  papyrus tasks graph [--session-id <id>] [--json]
  papyrus tasks active [--session-id <id>] [--json]
  papyrus tasks focused [--session-id <id>] [--json]
  papyrus tasks pause [--session-id <id>] [--json]
  papyrus tasks unpause [--session-id <id>] [--json]
  papyrus tasks clear-focus [--session-id <id>] [--json]
  papyrus tasks history <id> [--json]
  papyrus tasks scope [project|all|graph <root-id>] [--json]
  papyrus tasks assign-project <id> [project-root] [--json]
  papyrus tasks focus <id> [--session-id <id>] [--json]
  papyrus tasks update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--status todo --reason <reason>] [--json]
  papyrus tasks complete <id> [--session-id <id>] [--json]
  papyrus tasks start <id> [--session-id <id>] [--json]
  papyrus tasks submit <id> [--session-id <id>] [--json]
  papyrus tasks reject <id> [--session-id <id>] [--json]
  papyrus tasks retry <id> [--session-id <id>] [--json]
  papyrus tasks cancel <id> [--session-id <id>] [--json]
  papyrus tasks depend <id> <prerequisite-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks undepend <id> <prerequisite-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks contain <parent-id> <child-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks uncontain <parent-id> <child-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks create --title <title> [--body <body>] [--status <status>] [--labels-json <json>] [--extra-json <json>] [--gates-json <json>] [--checklist-json <json>] [--template-id <id>] [--parent-id <id>] [--depends-on-json <json>] [--session-id <id>] [--json]
  papyrus tasks list [--status <status>] [--text <query>] [--limit <count>] [--scope <project|graph|all>] [--root-task-id <id>] [--session-id <id>] [--json]
  papyrus tasks show <id> [--json]
  papyrus tasks run-gates <id> [--json]
  papyrus tasks set-checklist <id> --checklist-json <json> [--json]
  papyrus tasks context [--scope <project|graph|all>] [--root-task-id <id>] [--session-id <id>] [--json]

A "--session-id" scopes Task Focus to one agent session; omit it to use the shared "global" Focus (today's behavior).`;

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

function parseJsonObjectFlag(value: string | undefined, flag: string): Record<string, unknown> {
	if (value === undefined) throw new Error(`${flag} requires a value`);
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${flag} must be a JSON object`);
	return parsed as Record<string, unknown>;
}

function parseJsonStringArrayFlag(value: string | undefined, flag: string): string[] {
	if (value === undefined) throw new Error(`${flag} requires a value`);
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error(`${flag} must be a JSON string array`);
	return parsed as string[];
}

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
	let title: string | undefined;
	let body: string | undefined;
	let trigger: string | undefined;
	let steps: string[] | undefined;
	let tools: string[] | undefined;
	let definition: unknown;
	let labels: string[] | undefined;
	let extra: Record<string, unknown> | undefined;
	let targetKind: string | undefined;
	let defaults: Record<string, unknown> | undefined;
	let required: string[] | undefined;
	let status: string | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--run-id") { runId = args[++index]; if (!runId) throw new Error("--run-id requires a value"); continue; }
		if (argument === "--arguments-json") { arguments_ = parseJsonObjectFlag(args[++index], "--arguments-json"); continue; }
		if (argument === "--title") { title = args[++index]; if (title === undefined) throw new Error("--title requires a value"); continue; }
		if (argument === "--body") { body = args[++index]; if (body === undefined) throw new Error("--body requires a value"); continue; }
		if (argument === "--trigger") { trigger = args[++index]; if (trigger === undefined) throw new Error("--trigger requires a value"); continue; }
		if (argument === "--steps-json") { steps = parseJsonStringArrayFlag(args[++index], "--steps-json"); continue; }
		if (argument === "--tools-json") { tools = parseJsonStringArrayFlag(args[++index], "--tools-json"); continue; }
		if (argument === "--definition-json") {
			const value = args[++index];
			if (!value) throw new Error("--definition-json requires a value");
			definition = JSON.parse(value);
			continue;
		}
		if (argument === "--labels-json") { labels = parseJsonStringArrayFlag(args[++index], "--labels-json"); continue; }
		if (argument === "--extra-json") { extra = parseJsonObjectFlag(args[++index], "--extra-json"); continue; }
		if (argument === "--target-kind") { targetKind = args[++index]; if (!targetKind) throw new Error("--target-kind requires a value"); continue; }
		if (argument === "--defaults-json") { defaults = parseJsonObjectFlag(args[++index], "--defaults-json"); continue; }
		if (argument === "--required-json") { required = parseJsonStringArrayFlag(args[++index], "--required-json"); continue; }
		if (argument === "--status") { status = args[++index]; if (!status) throw new Error("--status requires a value"); continue; }
		if (argument === "--text") { text = args[++index]; if (text === undefined) throw new Error("--text requires a value"); continue; }
		if (argument === "--limit") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--limit requires a numeric value");
			limit = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown skills option ${argument}`);
		positional.push(argument);
	}
	const [action, id] = positional;
	if (action === "run") {
		if (positional.length !== 2) throw new Error("skills requires `run <id>`");
		const input: Record<string, unknown> = { id, arguments: arguments_, project_root: projectRoot };
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
	let result: unknown;
	let human: string;
	switch (action) {
		case "create": {
			if (id) throw new Error("skills create accepts no positional arguments");
			if (!title) throw new Error("skills create requires --title");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("skills.create", { title, body, trigger, steps, tools, definition, labels, extra });
			result = artifact;
			human = `Created skill: ${artifactLabel(artifact)}`;
			break;
		}
		case "create-template": {
			if (id) throw new Error("skills create-template accepts no positional arguments");
			if (!title || !targetKind) throw new Error("skills create-template requires --title and --target-kind");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("skills.create_template", {
				title, target_kind: targetKind, defaults, required, body, labels,
			});
			result = artifact;
			human = `Created template: ${artifactLabel(artifact)}`;
			break;
		}
		case "list": {
			if (id) throw new Error("skills list accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("skills.list", { status, text, limit });
			result = rows;
			human = rows.length === 0 ? "No skills found." : rows.map((row) => artifactLabel(row)).join("\n");
			break;
		}
		case "show": {
			if (!id) throw new Error("skills show requires exactly one skill id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("skills.show", { id });
			result = artifact;
			human = `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`;
			break;
		}
		case "invoke": {
			if (!id) throw new Error("skills invoke requires exactly one skill id");
			const invocation = await client.call<Record<string, unknown>, string>("skills.invoke", { id });
			result = invocation;
			human = invocation;
			break;
		}
		case "enable":
		case "disable": {
			if (!id) throw new Error(`skills ${action} requires exactly one skill id`);
			const operation = action === "enable" ? "skills.enable" : "skills.disable";
			const artifact = await client.call<Record<string, unknown>, CliArtifact>(operation, { id });
			result = artifact;
			human = `${artifactLabel(artifact)}`;
			break;
		}
		case "instantiate": {
			if (!id) throw new Error("skills instantiate requires exactly one template id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("skills.instantiate", {
				template_id: id, title, body, status, labels, extra, project_root: projectRoot,
			});
			result = artifact;
			human = `Created: ${artifactLabel(artifact)}`;
			break;
		}
		default:
			throw new Error("skills action must be run, create, create-template, list, show, invoke, enable, disable, or instantiate");
	}
	return json ? JSON.stringify(result) : human;
}

export async function runGraphCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	const input: Record<string, unknown> = {};
	let depth: number | undefined;
	let maxNodes: number | undefined;
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
		if (argument === "--depth") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--depth requires a numeric value");
			depth = Number(value);
			continue;
		}
		if (argument === "--max-nodes") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--max-nodes requires a numeric value");
			maxNodes = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown graph option ${argument}`);
		positional.push(argument);
	}
	const [action, first, second, third] = positional;
	if (action === "link") {
		if (positional.length !== 4) throw new Error("graph link requires <from> <relation> <to>");
		const result = await client.call<Record<string, unknown>, { ok: boolean }>("graph.link", { from: first, relation: second, to: third });
		return json ? JSON.stringify(result) : `Linked ${first} --${second}--> ${third}`;
	}
	if (action === "unlink") {
		if (positional.length !== 4) throw new Error("graph unlink requires <from> <relation> <to>");
		const result = await client.call<Record<string, unknown>, { removed: boolean }>("graph.unlink", { from: first, relation: second, to: third });
		if (json) return JSON.stringify(result);
		return result.removed ? `Unlinked ${first} --${second}--> ${third}` : `No such relationship: ${first} --${second}--> ${third}`;
	}
	if (action === "tree") {
		if (positional.length !== 2) throw new Error("graph tree requires exactly one artifact id");
		const artifact = await client.call<Record<string, unknown>, CliArtifact & { edges?: Array<{ from: string; relation: string; to: string }> }>("graph.tree", { id: first, depth, max_nodes: maxNodes });
		if (json) return JSON.stringify(artifact);
		const edges = artifact.edges ?? [];
		return edges.length === 0
			? `${artifactLabel(artifact)} — no edges`
			: `${artifactLabel(artifact)}\n${edges.map((edge) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`;
	}
	if (action === "status") {
		if (positional.length !== 3) throw new Error("graph status requires <id> <status>");
		const artifact = await client.call<Record<string, unknown>, CliArtifact>("graph.status", { id: first, status: second });
		return json ? JSON.stringify(artifact) : `Updated ${artifact.id} → [${artifact.status}]`;
	}
	if (action !== "history") throw new Error("graph action must be link, unlink, tree, status, or history");
	const page = await client.call<Record<string, unknown>, import("./domain/artifact-event.ts").ArtifactEventPage>("graph.history", input);
	if (json) return JSON.stringify(page);
	if (page.events.length === 0) return "No recorded events.";
	return page.events.map((event) => {
		const transition = event.fromStatus || event.toStatus ? ` ${event.fromStatus ?? "\u2205"} \u2192 ${event.toStatus ?? "\u2205"}` : "";
		const relation = event.relation ? ` ${event.relation} \u2192 ${event.relatedId}` : "";
		return `${event.occurredAt} ${event.artifactId} ${event.type}${transition}${relation} \u00b7 ${event.actor}/${event.source}${event.sessionId ? ` \u00b7 ${event.sessionId}` : ""}`;
	}).join("\n");
}

export async function runDocsCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let title: string | undefined;
	let body: string | undefined;
	let subtype: string | undefined;
	let labels: string[] | undefined;
	let extra: Record<string, unknown> | undefined;
	let templateId: string | undefined;
	let status: string | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--title") { title = args[++index]; if (title === undefined) throw new Error("--title requires a value"); continue; }
		if (argument === "--body") { body = args[++index]; if (body === undefined) throw new Error("--body requires a value"); continue; }
		if (argument === "--subtype") { subtype = args[++index]; if (!subtype) throw new Error("--subtype requires a value"); continue; }
		if (argument === "--labels-json") { labels = parseJsonStringArrayFlag(args[++index], "--labels-json"); continue; }
		if (argument === "--extra-json") { extra = parseJsonObjectFlag(args[++index], "--extra-json"); continue; }
		if (argument === "--template-id") { templateId = args[++index]; if (!templateId) throw new Error("--template-id requires a value"); continue; }
		if (argument === "--status") { status = args[++index]; if (!status) throw new Error("--status requires a value"); continue; }
		if (argument === "--text") { text = args[++index]; if (text === undefined) throw new Error("--text requires a value"); continue; }
		if (argument === "--limit") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--limit requires a numeric value");
			limit = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown docs option ${argument}`);
		positional.push(argument);
	}
	const [action, id, second, third] = positional;
	let result: unknown;
	let human: string;
	switch (action) {
		case "create": {
			if (id) throw new Error("docs create accepts no positional arguments");
			if (!title) throw new Error("docs create requires --title");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("docs.create", { title, body, subtype, labels, extra, template_id: templateId });
			result = artifact;
			human = `Created document: ${artifactLabel(artifact)}`;
			break;
		}
		case "list": {
			if (id) throw new Error("docs list accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("docs.list", { status, text, limit });
			result = rows;
			human = rows.length === 0 ? "No documents found." : rows.map((row) => artifactLabel(row)).join("\n");
			break;
		}
		case "show": {
			if (!id || second) throw new Error("docs show requires exactly one document id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("docs.show", { id });
			result = artifact;
			human = `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`;
			break;
		}
		case "activate":
		case "archive":
		case "reopen": {
			if (!id || second) throw new Error(`docs ${action} requires exactly one document id`);
			const artifact = await client.call<Record<string, unknown>, CliArtifact>(`docs.${action}`, { id });
			result = artifact;
			human = `${artifactLabel(artifact)}`;
			break;
		}
		case "link": {
			if (!id || !second || !third || positional.length !== 4) throw new Error("docs link requires <id> <relation> <target-id>");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("docs.link", { id, relation: second, target_id: third });
			result = artifact;
			human = `Linked ${id} --${second}--> ${third}`;
			break;
		}
		default:
			throw new Error("docs action must be create, list, show, activate, archive, reopen, or link");
	}
	return json ? JSON.stringify(result) : human;
}

export async function runRulesCli(args: string[], client: TaskCliClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let title: string | undefined;
	let body: string | undefined;
	let condition: string | undefined;
	let ruleAction: string | undefined;
	let severity: string | undefined;
	let labels: string[] | undefined;
	let extra: Record<string, unknown> | undefined;
	let status: string | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--title") { title = args[++index]; if (title === undefined) throw new Error("--title requires a value"); continue; }
		if (argument === "--body") { body = args[++index]; if (body === undefined) throw new Error("--body requires a value"); continue; }
		if (argument === "--condition") { condition = args[++index]; if (condition === undefined) throw new Error("--condition requires a value"); continue; }
		if (argument === "--rule-action") { ruleAction = args[++index]; if (ruleAction === undefined) throw new Error("--rule-action requires a value"); continue; }
		if (argument === "--severity") { severity = args[++index]; if (!severity) throw new Error("--severity requires a value"); continue; }
		if (argument === "--labels-json") { labels = parseJsonStringArrayFlag(args[++index], "--labels-json"); continue; }
		if (argument === "--extra-json") { extra = parseJsonObjectFlag(args[++index], "--extra-json"); continue; }
		if (argument === "--status") { status = args[++index]; if (!status) throw new Error("--status requires a value"); continue; }
		if (argument === "--text") { text = args[++index]; if (text === undefined) throw new Error("--text requires a value"); continue; }
		if (argument === "--limit") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--limit requires a numeric value");
			limit = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown rules option ${argument}`);
		positional.push(argument);
	}
	const [action, id, second] = positional;
	let result: unknown;
	let human: string;
	switch (action) {
		case "create": {
			if (id) throw new Error("rules create accepts no positional arguments");
			if (!title) throw new Error("rules create requires --title");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("rules.create", { title, body, condition, rule_action: ruleAction, severity, labels, extra });
			result = artifact;
			human = `Created rule: ${artifactLabel(artifact)}`;
			break;
		}
		case "list": {
			if (id) throw new Error("rules list accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("rules.list", { status, text, limit });
			result = rows;
			human = rows.length === 0 ? "No rules found." : rows.map((row) => artifactLabel(row)).join("\n");
			break;
		}
		case "show": {
			if (!id || second) throw new Error("rules show requires exactly one rule id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("rules.show", { id });
			result = artifact;
			human = `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`;
			break;
		}
		case "preview": {
			if (!id || second) throw new Error("rules preview requires exactly one rule id");
			const preview = await client.call<Record<string, unknown>, string>("rules.preview", { id });
			result = preview;
			human = preview;
			break;
		}
		case "enable":
		case "disable": {
			if (!id || second) throw new Error(`rules ${action} requires exactly one rule id`);
			const artifact = await client.call<Record<string, unknown>, CliArtifact>(`rules.${action}`, { id });
			result = artifact;
			human = `${artifactLabel(artifact)}`;
			break;
		}
		case "gate": {
			if (!id || !second || positional.length !== 3) throw new Error("rules gate requires <rule-id> <task-id>");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("rules.gate", { id, task_id: second });
			result = artifact;
			human = `Gated ${second} with rule ${artifactLabel(artifact)}`;
			break;
		}
		case "injectable": {
			if (id) throw new Error("rules injectable accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("rules.injectable", { project_root: projectRoot });
			result = rows;
			human = rows.length === 0 ? "No injectable rules." : rows.map((row) => row.title).join("\n");
			break;
		}
		default:
			throw new Error("rules action must be create, list, show, preview, enable, disable, gate, or injectable");
	}
	return json ? JSON.stringify(result) : human;
}

export async function runArtifactCli(args: string[], client: TaskCliClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let kind: string | undefined;
	let title: string | undefined;
	let body: string | undefined;
	let status: string | undefined;
	let subtype: string | undefined;
	let labels: string[] | undefined;
	let extra: Record<string, unknown> | undefined;
	let templateId: string | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	let depth: number | undefined;
	let maxNodes: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--kind") { kind = args[++index]; if (!kind) throw new Error("--kind requires a value"); continue; }
		if (argument === "--title") { title = args[++index]; if (title === undefined) throw new Error("--title requires a value"); continue; }
		if (argument === "--body") { body = args[++index]; if (body === undefined) throw new Error("--body requires a value"); continue; }
		if (argument === "--status") { status = args[++index]; if (!status) throw new Error("--status requires a value"); continue; }
		if (argument === "--subtype") { subtype = args[++index]; if (!subtype) throw new Error("--subtype requires a value"); continue; }
		if (argument === "--labels-json") { labels = parseJsonStringArrayFlag(args[++index], "--labels-json"); continue; }
		if (argument === "--extra-json") { extra = parseJsonObjectFlag(args[++index], "--extra-json"); continue; }
		if (argument === "--template-id") { templateId = args[++index]; if (!templateId) throw new Error("--template-id requires a value"); continue; }
		if (argument === "--text") { text = args[++index]; if (text === undefined) throw new Error("--text requires a value"); continue; }
		if (argument === "--limit") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--limit requires a numeric value");
			limit = Number(value);
			continue;
		}
		if (argument === "--depth") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--depth requires a numeric value");
			depth = Number(value);
			continue;
		}
		if (argument === "--max-nodes") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--max-nodes requires a numeric value");
			maxNodes = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown artifact option ${argument}`);
		positional.push(argument);
	}
	const [action, id] = positional;
	let result: unknown;
	let human: string;
	switch (action) {
		case "create": {
			if (id) throw new Error("artifact create accepts no positional arguments");
			if (!kind && !templateId) throw new Error("artifact create requires --kind (or --template-id)");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("artifact.create", {
				kind, title, body, status, subtype, labels, extra, template_id: templateId,
				...(kind === "task" ? { project_root: projectRoot } : {}),
			});
			result = artifact;
			human = `Created: ${artifactLabel(artifact)}`;
			break;
		}
		case "query": {
			if (id) throw new Error("artifact query accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("artifact.query", { kind, status, text, limit });
			result = rows;
			human = rows.length === 0 ? "No artifacts found." : rows.map((row) => artifactLabel(row)).join("\n");
			break;
		}
		case "show": {
			if (!id) throw new Error("artifact show requires exactly one artifact id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("artifact.show", { id, depth, max_nodes: maxNodes });
			result = artifact;
			human = `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`;
			break;
		}
		default:
			throw new Error("artifact action must be create, query, or show");
	}
	return json ? JSON.stringify(result) : human;
}

export async function runGatesCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	if (positional.length !== 2 || positional[0] !== "run") throw new Error("gates requires `run <id>`");
	const results = await client.call<Record<string, unknown>, GateResult[]>("gates.run", { id: positional[1] });
	if (json) return JSON.stringify(results);
	return results.length === 0
		? "No gates configured."
		: results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n");
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
	let sessionId: string | undefined;
	let title: string | undefined;
	let body: string | undefined;
	let status: string | undefined;
	let labels: string[] | undefined;
	let extra: Record<string, unknown> | undefined;
	let gates: unknown[] | undefined;
	let checklist: Record<string, unknown> | undefined;
	let templateId: string | undefined;
	let parentId: string | undefined;
	let dependsOn: string[] | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	let listScope: "project" | "graph" | "all" | undefined;
	let rootTaskId: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--session-id") {
			sessionId = args[++index];
			if (!sessionId) throw new Error("--session-id requires a value");
			continue;
		}
		if (argument === "--title" || argument === "--body" || argument === "--labels-json" || argument === "--status" || argument === "--reason") {
			const value = args[++index];
			if (value === undefined) throw new Error(`${argument} requires a value`);
			if (argument === "--title") { updateInput.title = value; title = value; }
			else if (argument === "--body") { updateInput.body = value; body = value; }
			else if (argument === "--reason") reason = value;
			else if (argument === "--status") {
				status = value;
				if (value === "todo") updateInput.status = value;
			} else {
				labels = parseJsonStringArrayFlag(value, "--labels-json");
				updateInput.labels = labels;
			}
			continue;
		}
		if (argument === "--extra-json") { extra = parseJsonObjectFlag(args[++index]!, "--extra-json"); continue; }
		if (argument === "--gates-json") {
			const value = args[++index];
			if (!value) throw new Error("--gates-json requires a value");
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) throw new Error("--gates-json must be a JSON array");
			gates = parsed;
			continue;
		}
		if (argument === "--checklist-json") { checklist = parseJsonObjectFlag(args[++index]!, "--checklist-json"); continue; }
		if (argument === "--template-id") { templateId = args[++index]; if (!templateId) throw new Error("--template-id requires a value"); continue; }
		if (argument === "--parent-id") { parentId = args[++index]; if (!parentId) throw new Error("--parent-id requires a value"); continue; }
		if (argument === "--depends-on-json") { dependsOn = parseJsonStringArrayFlag(args[++index]!, "--depends-on-json"); continue; }
		if (argument === "--text") { text = args[++index]; if (text === undefined) throw new Error("--text requires a value"); continue; }
		if (argument === "--limit") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--limit requires a numeric value");
			limit = Number(value);
			continue;
		}
		if (argument === "--scope") {
			const value = args[++index];
			if (value !== "project" && value !== "graph" && value !== "all") throw new Error("--scope must be project, graph, or all");
			listScope = value;
			continue;
		}
		if (argument === "--root-task-id") { rootTaskId = args[++index]; if (!rootTaskId) throw new Error("--root-task-id requires a value"); continue; }
		if (argument.startsWith("--")) throw new Error(`unknown tasks option ${argument}`);
		positional.push(argument);
	}
	const [action, id, dependencyId] = positional;
	const reasonSupportedActions = new Set(["update", "depend", "undepend", "contain", "uncontain"]);
	if (reason !== undefined && !reasonSupportedActions.has(action ?? "")) throw new Error("--reason is only supported by tasks update, depend, undepend, contain, and uncontain");
	const sessionScope = sessionId ? { session_id: sessionId } : {};
	let result: unknown;
	let human: string;
	switch (action) {
		case "active": {
			if (id) throw new Error("tasks active accepts no positional arguments");
			const active = await client.call<Record<string, unknown>, CliArtifact | null>("tasks.active", { project_root: projectRoot, ...sessionScope });
			result = active;
			human = active ? `Active: ${artifactLabel(active)}` : "No active task.";
			break;
		}
		case "focused": {
			if (id) throw new Error("tasks focused accepts no positional arguments");
			const focus = await client.call<Record<string, unknown>, { artifact: CliArtifact; status: "active" | "paused"; updatedAt: string } | null>("tasks.focused", { project_root: projectRoot, ...sessionScope });
			result = focus;
			human = focus ? `Focused (${focus.status}): ${artifactLabel(focus.artifact)}` : "No focused task.";
			break;
		}
		case "pause":
		case "unpause": {
			if (id) throw new Error(`tasks ${action} accepts no positional arguments`);
			const operation = action === "pause" ? "tasks.pause" : "tasks.unpause";
			const focus = await client.call<Record<string, unknown>, { artifact: CliArtifact; status: string }>(operation, { actor: "user", source: "cli", ...sessionScope });
			result = focus;
			human = `Focused (${focus.status}): ${artifactLabel(focus.artifact)}`;
			break;
		}
		case "clear-focus": {
			if (id) throw new Error("tasks clear-focus accepts no positional arguments");
			const cleared = await client.call<Record<string, unknown>, { cleared: boolean }>("tasks.clear_focus", { actor: "user", source: "cli", ...sessionScope });
			result = cleared;
			human = cleared.cleared ? "Task focus cleared." : "No focused task.";
			break;
		}
		case "create": {
			if (id) throw new Error("tasks create accepts no positional arguments");
			if (!title) throw new Error("tasks create requires --title");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.create", {
				title, body, status, labels, extra, gates, checklist,
				template_id: templateId, parent_id: parentId, depends_on: dependsOn,
				project_root: projectRoot, actor: "user", source: "cli", ...sessionScope,
			});
			result = artifact;
			human = `Created task: ${artifactLabel(artifact)}`;
			break;
		}
		case "list": {
			if (id) throw new Error("tasks list accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("tasks.list", {
				status, text, limit, project_root: projectRoot, scope: listScope, root_task_id: rootTaskId, ...sessionScope,
			});
			result = rows;
			human = rows.length === 0 ? "No tasks found." : rows.map((row) => artifactLabel(row)).join("\n");
			break;
		}
		case "show": {
			if (!id || dependencyId) throw new Error("tasks show requires exactly one task id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.show", { id });
			result = artifact;
			human = `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`;
			break;
		}
		case "run-gates": {
			if (!id || dependencyId) throw new Error("tasks run-gates requires exactly one task id");
			const results = await client.call<Record<string, unknown>, GateResult[]>("tasks.run_gates", { id, actor: "user", source: "cli" });
			result = results;
			human = results.length === 0
				? "No gates configured."
				: results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n");
			break;
		}
		case "set-checklist": {
			if (!id || dependencyId) throw new Error("tasks set-checklist requires exactly one task id");
			if (!checklist) throw new Error("tasks set-checklist requires --checklist-json");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.set_checklist", { id, checklist });
			result = artifact;
			human = `Updated checklist: ${artifactLabel(artifact)}`;
			break;
		}
		case "context": {
			if (id) throw new Error("tasks context accepts no positional arguments");
			const summary = await client.call<Record<string, unknown>, string | null>("tasks.context", {
				project_root: projectRoot, scope: listScope, root_task_id: rootTaskId, ...sessionScope,
			});
			result = summary;
			human = summary ?? "No open tasks.";
			break;
		}
		case "contain": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks contain requires a parent id and child id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.contain", {
				parent_id: id, child_id: dependencyId, actor: "user", source: "cli", ...(reason ? { reason } : {}), ...sessionScope,
			});
			result = artifact;
			human = `Contained: ${dependencyId} → ${artifactLabel(artifact)}`;
			break;
		}
		case "uncontain": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks uncontain requires a parent id and child id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.uncontain", {
				parent_id: id, child_id: dependencyId, actor: "user", source: "cli", ...(reason ? { reason } : {}), ...sessionScope,
			});
			result = artifact;
			human = `Removed ${dependencyId} from ${artifactLabel(artifact)}`;
			break;
		}
		case "update": {
			if (!id || dependencyId) throw new Error("tasks update requires exactly one task id");
			if (status !== undefined && status !== "todo") throw new Error("tasks update --status only supports todo for accidental creation recovery");
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
			const active = await client.call<Record<string, unknown>, CliArtifact>("tasks.focus", { id, actor: "user", source: "cli", ...sessionScope });
			result = active;
			human = `Active: ${artifactLabel(active)}`;
			break;
		}
		case "graph": {
			if (id) throw new Error("tasks graph accepts no positional arguments");
			const graph = await client.call<Record<string, unknown>, {
				nodes: Array<{ dependencyIds: string[]; childIds: string[] }>;
				rootIds: string[];
			}>("tasks.graph", { limit: TASK_EXECUTION_MAX_NODES + 1, project_root: projectRoot, ...sessionScope });
			result = graph;
			const dependencies = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
			const children = graph.nodes.reduce((count, node) => count + node.childIds.length, 0);
			human = `Task graph: ${graph.nodes.length} nodes, ${graph.rootIds.length} roots, ${dependencies} dependencies, ${children} containment edges`;
			break;
		}
		case "plan": {
			if (id) throw new Error("tasks plan accepts no positional arguments");
			const plan = await client.call<Record<string, unknown>, TaskExecutionPlan>("tasks.plan", { project_root: projectRoot, ...sessionScope });
			result = plan;
			human = planText(plan);
			break;
		}
		case "complete": {
			if (!id || dependencyId) throw new Error("tasks complete requires exactly one task id");
			const completion = await client.call<Record<string, unknown>, CliCompletion>("tasks.complete", { id, actor: "user", source: "cli", ...sessionScope });
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
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.start", { id, actor: "user", source: "cli", ...sessionScope });
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
			const artifact = await client.call<Record<string, unknown>, CliArtifact>(operation, { id, actor: "user", source: "cli", ...sessionScope });
			result = artifact;
			human = `${action[0]!.toUpperCase()}${action.slice(1)}: ${artifactLabel(artifact)}`;
			break;
		}
		case "depend": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks depend requires a task id and prerequisite id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.depend", {
				id, dependency_id: dependencyId, actor: "user", source: "cli", ...(reason ? { reason } : {}), ...sessionScope,
			});
			result = artifact;
			human = `Dependency added: ${artifactLabel(artifact)} waits for ${dependencyId}`;
			break;
		}
		case "undepend": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks undepend requires a task id and prerequisite id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.undepend", {
				id, dependency_id: dependencyId, actor: "user", source: "cli", ...(reason ? { reason } : {}), ...sessionScope,
			});
			result = artifact;
			human = `Dependency removed: ${artifactLabel(artifact)} no longer waits for ${dependencyId}`;
			break;
		}
		default:
			throw new Error("tasks action must be create, list, show, active, focused, focus, pause, unpause, clear-focus, update, graph, plan, context, history, scope, assign-project, complete, start, submit, reject, retry, cancel, depend, undepend, contain, uncontain, run-gates, or set-checklist");
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
	if (command === "docs") {
		const client = await connectPapyrusClient();
		console.log(await runDocsCli(args.slice(1), client));
		return;
	}
	if (command === "rules") {
		const client = await connectPapyrusClient();
		console.log(await runRulesCli(args.slice(1), client));
		return;
	}
	if (command === "artifact") {
		const client = await connectPapyrusClient();
		console.log(await runArtifactCli(args.slice(1), client));
		return;
	}
	if (command === "gates") {
		const client = await connectPapyrusClient();
		console.log(await runGatesCli(args.slice(1), client));
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
