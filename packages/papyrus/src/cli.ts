#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createNodeServiceInstallDeps, generateSystemdUnit, installUserService, type ServiceSpec } from "@danypops/vehicle-server/service";
import { runDiscussCli } from "./cli/discuss-command.ts";
import { runDocsCli } from "./cli/docs-command.ts";
import { runGatesCli } from "./cli/gates-command.ts";
import { runGraphCli } from "./cli/graph-command.ts";
import { runGraphProjectionCli } from "./cli/graph-projection-command.ts";
import { runLogCli } from "./cli/log-command.ts";
import { runMigrationCli } from "./cli/migration-command.ts";
import { runNoteCli } from "./cli/note-command.ts";
import { runRulesCli } from "./cli/rules-command.ts";
import { runSessionIdentityCli } from "./cli/session-identity-command.ts";
import { artifactLabel, type CliArtifact } from "./cli/shared.ts";
import { connectPapyrusClient, type PapyrusClient } from "./client.ts";
import { DAEMON_UNIT_NAME, dbPath, TASK_EXECUTION_MAX_NODES } from "./constants.ts";
import { serveMain } from "./daemon/daemon.ts";
import { daemonStateDir, vehicleHandlePath } from "./daemon/daemon-state.ts";
import { openDb } from "./db.ts";
import type { GateResult } from "./domain/gate.ts";
import { applyIdMigration, type IdMigrationPlan, mirrorDatabase, planIdMigration, verifyIdMigration } from "./id-migration.ts";
import type { TaskExecutionPlan } from "./task/task-execution.ts";
import type { TaskBlockage, TaskCompletion } from "./task/task-service.ts";
import { VERSION } from "./version.ts";

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
}

/**
 * Pure text generator, delegating to vehicle-server's shared generateSystemdUnit -- kept as its
 * own named export with the same options shape since this package's own tests (and any external
 * caller) call it directly.
 *
 * Papyrus's own daemon.ts does not (yet) use vehicle-server's startDaemon/runDaemonProcess -- it's
 * a bespoke Bun.serve() with its own state-file layout (daemon-state.ts) and maintenance-timer
 * scheduling, predating that shared substrate. handlePath points at the real {host,port,pid} file
 * daemon.ts writes on startup (writeVehicleHandle), so Armada's readiness probe works once Papyrus
 * is service-installed. DAEMON_KIT_LAUNCH_PROVENANCE=service is emitted (generateSystemdUnit always
 * adds it) but is currently inert -- Papyrus's daemon never reads it, since it has no idle-shutdown
 * concept of its own. Migrating daemon.ts's own substrate onto vehicle-server's shared daemon
 * runtime entirely is tracked separately.
 */
export function papyrusServiceSpec(options: SystemdUnitOptions): ServiceSpec {
	return {
		name: "papyrus",
		displayName: "Papyrus graph artifact service",
		version: VERSION,
		binPath: options.bunBin,
		args: [options.cliPath, "serve"],
		// The real {host,port,pid} file daemon.ts writes on startup (writeVehicleHandle) --
		// Armada's readiness probe polls exactly this path once Papyrus is service-installed.
		handlePath: vehicleHandlePath(daemonStateDir()),
		// Restart=always/RestartSec=2 already unconditional in the prior hand-rolled unit --
		// preserved exactly, not a new opt-in.
		restartOnFailure: true,
		restartSec: 2,
	};
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return generateSystemdUnit(papyrusServiceSpec(options));
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function isDaemonActive(): boolean {
	try {
		execFileSync("systemctl", ["--user", "is-active", "--quiet", DAEMON_UNIT_NAME]);
		return true;
	} catch {
		return false; // non-zero exit means inactive/failed/not-found -- treated the same, safely, as "not running"
	}
}

function installService(): void {
	const spec = papyrusServiceSpec({ bunBin: process.execPath, cliPath: fileURLToPath(import.meta.url) });
	const result = installUserService(spec, createNodeServiceInstallDeps());
	if (!result.installed) throw new Error(`failed to install the Papyrus service: ${result.reason}`);
	// installUserService's Linux path is `enable --now` (starts if not already running) --
	// an explicit restart on top ensures a re-install after an upgrade actually picks up the
	// freshly-generated unit's new ExecStart path, not just re-enables the old one.
	systemctl("restart", DAEMON_UNIT_NAME);
}

const USAGE = `Usage:
  papyrus serve
  papyrus service <install|start|stop|restart|status>
  papyrus migrate schema [--json]
  papyrus migrate-ids mirror [--db <path>] --out <mirror-path> [--json]
  papyrus migrate-ids validate --mirror <mirror-path> [--idmap <path>] [--json]
  papyrus migrate-ids promote --mirror <mirror-path> [--db <path>] [--idmap <path>] [--force] [--json]
  papyrus graph link <from> <relation> <to> [--json]
  papyrus graph unlink <from> <relation> <to> [--json]
  papyrus graph tree <id> [--depth <n>] [--max-nodes <n>] [--json]
  papyrus graph status <id> <status> [--json]
  papyrus graph history [--id <artifact-id>] [--actor <actor>] [--session-id <id>] [--since <rfc3339>] [--limit <count>] [--cursor <id>] [--direction <asc|desc>] [--json]
  papyrus gates run <id> [--json]
  papyrus graph-projection apply --batch-json <json> [--json]
  papyrus graph-projection checkpoint --producer-id <id> [--json]
  papyrus artifact create --kind <kind> [--title <title>] [--status <status>] [--subtype <subtype>] [--body <body>] [--labels-json <json>] [--extra-json <json>] [--template-id <id>] [--json]
  papyrus artifact query [--kind <kind>] [--status <status>] [--text <query>] [--limit <count>] [--json]
  papyrus artifact show <id> [--depth <n>] [--max-nodes <n>] [--json]
  papyrus artifact remove <id> [--reason <text>] [--json]
  papyrus artifact remove-subtree <id> [--reason <text>] [--json]
  papyrus artifact restore <id> [--json]
  papyrus artifact trash-status <id> [--json]
  papyrus artifact trash-list [--json]
  papyrus docs create --title <title> [--body <body>] [--subtype <subtype>] [--labels-json <json>] [--extra-json <json>] [--template-id <id>] [--project-root <path>] [--json]
  papyrus docs list [--status <status>] [--text <query>] [--limit <count>] [--project-root <path>] [--json]
  papyrus docs show <id> [--json]
  papyrus docs activate|archive|reopen <id> [--json]
  papyrus docs link <id> <relation> <target-id> [--json]
  papyrus docs assign-project <id> [project-root] [--json]
  papyrus docs update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--json]
  papyrus rules create --title <title> [--body <body>] [--condition <text>] [--rule-action <text>] [--severity block|warn|info] [--labels-json <json>] [--extra-json <json>] [--project-root <path>] [--json]
  papyrus rules list [--status <status>] [--text <query>] [--limit <count>] [--project-root <path>] [--json]
  papyrus rules show <id> [--json]
  papyrus rules preview <id> [--json]
  papyrus rules enable|disable <id> [--json]
  papyrus rules gate <rule-id> <task-id> [--json]
  papyrus rules injectable [--json]
  papyrus rules assign-project <id> [project-root] [--json]
  papyrus rules update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--json]
  papyrus playbooks create --title <title> [--body <body>] [--trigger <text>] [--steps-json <json array of strings and/or {kind:'doc'|'rule'|'call'|'task',...} objects>] [--tools-json <json>] [--labels-json <json>] [--extra-json <json>] [--arguments-json <json array, each optionally {type,enum,default}>] [--project-root <path>] [--json]
  papyrus playbooks invoke <id> [--arguments-json <json object>] [--run-id <id>] [--project-root <path>] [--json]  # materializes real tasks (contains/depends_on-wired) and focuses the entry task
  papyrus playbooks preview <id> [--arguments-json <json object>] [--json]  # renders text only, creates nothing
  papyrus playbooks list [--status <status>] [--text <query>] [--limit <count>] [--project-root <path>] [--json]
  papyrus playbooks show <id> [--json]
  papyrus playbooks enable|disable <id> [--json]
  papyrus playbooks assign-project <id> [project-root] [--json]
  papyrus playbooks update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--json]
  papyrus playbooks contain <parent-id> <child-id> [--json]
  papyrus playbooks uncontain <parent-id> <child-id> [--json]
  papyrus playbooks depend <id> <dependency-id> [--json]
  papyrus playbooks undepend <id> <dependency-id> [--json]
  papyrus notes capture <request> [--title <title>] [--json]
  papyrus notes list [--status <draft|active|archived>] [--text <query>] [--limit <count>] [--json]
  papyrus notes show <id> [--json]
  papyrus notes consume <id> [--reason <reason>] [--json]
  papyrus notes promote <id> <target-id> [--reason <reason>] [--json]
  papyrus notes archive <id> <completed|duplicate|declined|superseded> [--reason <reason>] [--json]
  papyrus log append --source <id> --level <debug|info|warning|error> --message <text> --operation-id <id> [--source-label <text>] [--fields-json <json>] [--session-id <id>] [--occurred-at <iso>] [--global] [--json]
  papyrus session register --session-id <id> [--json]
  papyrus session release --session-id <id> [--session-secret <secret>] [--json]
  papyrus discuss open --title <t> --actor <a> --content <c> [--body <b>] [--labels-json <json>] [--blocks-json <json>] [--options-json <json>] [--options-mode single|multi] [--option-descriptions-json <json>] [--json]
  papyrus discuss reply <id> --actor <a> --content <c> [--selected-json <json>] [--options-json <json>] [--options-mode single|multi] [--option-descriptions-json <json>] [--json]
  papyrus discuss defer <id> [--reason <text>] [--json]
  papyrus discuss resume <id> [--json]
  papyrus discuss settle <id> --settlement <text> [--json]
  papyrus discuss block <id> --task-id <task-id> [--json]
  papyrus discuss unblock <id> --task-id <task-id> [--json]
  papyrus discuss show <id> [--json]
  papyrus discuss rounds <id> [--after-round <n>] [--limit <n>] [--json]
  papyrus discuss list [--state active|deferred|settled] [--limit <n>] [--json]
  papyrus log query --source <id> [--since <iso>] [--level <debug|info|warning|error>] [--limit <count>] [--json]
  papyrus tasks plan [--session-id <id>] [--json]
  papyrus tasks graph [--session-id <id>] [--json]
  papyrus tasks active [--session-id <id>] [--json]
  papyrus tasks focused [--session-id <id>] [--json]
  papyrus tasks pause [--session-id <id>] [--session-secret <secret>] [--json]
  papyrus tasks unpause [--session-id <id>] [--session-secret <secret>] [--json]
  papyrus tasks clear-focus [--session-id <id>] [--session-secret <secret>] [--json]
  papyrus tasks reap-stale-focus [--json]
  papyrus tasks claim <id> --owner <owner> [--ttl-ms <ms>] [--note <text>] [--json]
  papyrus tasks heartbeat-lease <id> --owner <owner> --token <token> [--ttl-ms <ms>] [--json]
  papyrus tasks release-lease <id> --owner <owner> --token <token> [--json]
  papyrus tasks lease <id> [--json]
  papyrus tasks reap-stale-leases [--json]
  papyrus tasks event-feed [--cursor <n>] [--limit <n>] [--event-types-json <json>] [--json]
  papyrus tasks history <id> [--json]
  papyrus tasks scope [project|all|graph <root-id>] [--json]
  papyrus tasks assign-project <id> [project-root] [--json]
  papyrus tasks focus <id> [--session-id <id>] [--session-secret <secret>] [--json]
  papyrus tasks update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--status todo --reason <reason>] [--json]
  papyrus tasks complete <id> [--session-id <id>] [--json]
  papyrus tasks start <id> [--session-id <id>] [--json]
  papyrus tasks submit <id> [--session-id <id>] [--json]
  papyrus tasks reject <id> [--session-id <id>] [--json]
  papyrus tasks retry <id> [--session-id <id>] [--json]
  papyrus tasks cancel <id> [--session-id <id>] [--json]
  papyrus tasks cancel-subtree <id> [--session-id <id>] [--json]
  papyrus tasks depend <id> <prerequisite-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks undepend <id> <prerequisite-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks contain <parent-id> <child-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks uncontain <parent-id> <child-id> [--reason <reason>] [--session-id <id>] [--json]
  papyrus tasks create --title <title> [--body <body>] [--status <status>] [--labels-json <json>] [--extra-json <json>] [--gates-json <json>] [--checklist-json <json>] [--template-id <id>] [--parent-id <id>] [--depends-on-json <json>] [--session-id <id>] [--json]
  papyrus tasks list [--status <status>] [--text <query>] [--limit <count>] [--scope <project|graph|all>] [--root-task-id <id>] [--session-id <id>] [--json]
  papyrus tasks show <id> [--json]
  papyrus tasks run-gates <id> [--json]
  papyrus tasks set-checklist <id> --checklist-json <json> [--json]
  papyrus tasks set-gates <id> --gates-json <json> [--json]
  papyrus tasks context [--scope <project|graph|all>] [--root-task-id <id>] [--session-id <id>] [--json]

A "--session-id" scopes Task Focus to one agent session; omit it to use the shared "global" Focus (today's behavior).
Once a session id is registered ("papyrus session register"), mutating its Focus (focus/pause/unpause/clear-focus) requires the matching "--session-secret"; an unregistered session id is unaffected.`;

function usage(): never {
	console.error(USAGE);
	process.exit(2);
}

type TaskCliClient = Pick<PapyrusClient, "call">;
type CliTaskLease = {
	taskId: string;
	owner: string;
	token: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
};
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

/**
 * No shape assertion here -- playbooks --arguments-json is genuinely polymorphic (an array on
 * create, a {name: value} map on invoke, sharing one flag-parsing pass in runPlaybooksCli), and
 * --steps-json accepts a mix of plain prose strings and structured step objects (doc/rule/call/
 * task) that a single string-array assertion would wrongly reject. The service validates the
 * real shape for whichever operation actually receives it.
 */
function parseJsonAnyFlag(value: string | undefined, flag: string): unknown {
	if (value === undefined) throw new Error(`${flag} requires a value`);
	return JSON.parse(value) as unknown;
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

export { runMigrationCli };

function readIdMap(sidecarPath: string): IdMigrationPlan {
	const raw = JSON.parse(readFileSync(sidecarPath, "utf8")) as { idMap: Record<string, string> };
	return { idMap: new Map(Object.entries(raw.idMap)) };
}

/**
 * Offline, file-path-based -- deliberately not a daemon operation. Required sequence:
 * mirror (produces a migrated copy + an inspectable id-map sidecar, touches nothing live) ->
 * validate (re-checks the mirror in a fresh process, using only the sidecar) ->
 * promote (re-validates, then swaps the mirror into place; refuses while the daemon is active).
 * See src/id-migration.ts's module doc comment for why each step exists and what it does not cover.
 */
export function runIdMigrationCli(args: string[]): string {
	const [subcommand, ...rest] = args;
	const json = rest.includes("--json");
	const flag = (name: string): string | undefined => {
		const index = rest.indexOf(`--${name}`);
		return index === -1 ? undefined : rest[index + 1];
	};

	if (subcommand === "mirror") {
		const source = flag("db") ?? dbPath();
		const mirrorPath = flag("out");
		if (!mirrorPath) throw new Error("migrate-ids mirror requires --out <path>");
		const sourceDb = openDb(source);
		try {
			mirrorDatabase(sourceDb, mirrorPath);
		} finally {
			sourceDb.close();
		}

		const mirror = openDb(mirrorPath);
		let plan: IdMigrationPlan;
		let report: ReturnType<typeof applyIdMigration>;
		try {
			plan = planIdMigration(mirror);
			report = applyIdMigration(mirror, plan);
		} finally {
			mirror.close();
		}
		const sidecarPath = `${mirrorPath}.idmap.json`;
		writeFileSync(sidecarPath, JSON.stringify({ idMap: Object.fromEntries(plan.idMap) }, null, 2));

		const result = { source, mirrorPath, sidecarPath, ...report };
		if (json) return JSON.stringify(result);
		return [
			`Mirrored ${source} -> ${mirrorPath}`,
			`Remapped ${report.artifactsRemapped} artifact id(s), ${report.edgesRemapped} edge row(s), ${report.textOccurrencesRemapped} embedded text mention(s).`,
			`Id map: ${sidecarPath}`,
			`Next: papyrus migrate-ids validate --mirror ${mirrorPath}`,
		].join("\n");
	}

	if (subcommand === "validate") {
		const mirrorPath = flag("mirror");
		if (!mirrorPath) throw new Error("migrate-ids validate requires --mirror <path>");
		const plan = readIdMap(flag("idmap") ?? `${mirrorPath}.idmap.json`);
		const mirror = openDb(mirrorPath);
		let result: ReturnType<typeof verifyIdMigration>;
		try {
			result = verifyIdMigration(mirror, plan);
		} finally {
			mirror.close();
		}
		if (json) return JSON.stringify(result);
		if (result.ok)
			return `Validation passed: ${plan.idMap.size} artifact id(s) correctly migrated.\nNext: papyrus migrate-ids promote --mirror ${mirrorPath}`;
		return `Validation FAILED:\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}\nDo not promote this mirror.`;
	}

	if (subcommand === "promote") {
		const mirrorPath = flag("mirror");
		if (!mirrorPath) throw new Error("migrate-ids promote requires --mirror <path>");
		const target = flag("db") ?? dbPath();
		const force = rest.includes("--force");
		if (isDaemonActive() && !force) {
			throw new Error(
				`refusing to promote while ${DAEMON_UNIT_NAME} is active -- stop it first (papyrus service stop), or pass --force if you have already verified it is safe`,
			);
		}
		const plan = readIdMap(flag("idmap") ?? `${mirrorPath}.idmap.json`);
		const mirror = openDb(mirrorPath);
		let result: ReturnType<typeof verifyIdMigration>;
		try {
			result = verifyIdMigration(mirror, plan);
		} finally {
			mirror.close();
		}
		if (!result.ok) {
			throw new Error(
				`refusing to promote: mirror failed validation (${result.problems.length} problem(s)) -- run migrate-ids validate for details`,
			);
		}
		let backupPath: string | undefined;
		if (existsSync(target)) {
			// Fold target's own WAL into its main file first -- otherwise a stale -wal/-shm left
			// behind after the file swap below would make SQLite replay target's OWN pre-
			// migration state back on top of the freshly copied (already-checkpointed) mirror on
			// next open, silently discarding the migration. Copying only the main .db file while
			// a WAL sidecar for the *old* file identity still sits at the same path is exactly
			// the bug this closes.
			const targetDb = openDb(target);
			targetDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			targetDb.close();
			backupPath = `${target}.pre-id-migration-${Date.now()}.bak`;
			copyFileSync(target, backupPath);
			for (const sidecar of [`${target}-wal`, `${target}-shm`]) if (existsSync(sidecar)) unlinkSync(sidecar);
		}
		copyFileSync(mirrorPath, target);
		const result2 = { target, backupPath };
		if (json) return JSON.stringify(result2);
		return [
			`Promoted ${mirrorPath} -> ${target}`,
			...(backupPath ? [`Previous database backed up to ${backupPath}`] : []),
			"Restart papyrus.service for the daemon to pick this up.",
		].join("\n");
	}

	throw new Error("migrate-ids requires one of: mirror, validate, promote");
}

export { runDocsCli, runGraphCli, runRulesCli };

export async function runPlaybooksCli(args: string[], client: TaskCliClient): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	let title: string | undefined;
	let body: string | undefined;
	let trigger: string | undefined;
	let steps: unknown;
	let tools: string[] | undefined;
	let labels: string[] | undefined;
	let extra: Record<string, unknown> | undefined;
	let playbookArguments: unknown;
	let runId: string | undefined;
	let status: string | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	let playbookProjectRoot: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--title") {
			title = args[++index];
			if (title === undefined) throw new Error("--title requires a value");
			continue;
		}
		if (argument === "--body") {
			body = args[++index];
			if (body === undefined) throw new Error("--body requires a value");
			continue;
		}
		if (argument === "--trigger") {
			trigger = args[++index];
			if (trigger === undefined) throw new Error("--trigger requires a value");
			continue;
		}
		if (argument === "--steps-json") {
			steps = parseJsonAnyFlag(args[++index], "--steps-json");
			continue;
		}
		if (argument === "--tools-json") {
			tools = parseJsonStringArrayFlag(args[++index], "--tools-json");
			continue;
		}
		if (argument === "--labels-json") {
			labels = parseJsonStringArrayFlag(args[++index], "--labels-json");
			continue;
		}
		if (argument === "--extra-json") {
			extra = parseJsonObjectFlag(args[++index], "--extra-json");
			continue;
		}
		if (argument === "--arguments-json") {
			playbookArguments = parseJsonAnyFlag(args[++index], "--arguments-json");
			continue;
		}
		if (argument === "--run-id") {
			runId = args[++index];
			if (!runId) throw new Error("--run-id requires a value");
			continue;
		}
		if (argument === "--status") {
			status = args[++index];
			if (!status) throw new Error("--status requires a value");
			continue;
		}
		if (argument === "--text") {
			text = args[++index];
			if (text === undefined) throw new Error("--text requires a value");
			continue;
		}
		if (argument === "--project-root") {
			playbookProjectRoot = args[++index];
			if (!playbookProjectRoot) throw new Error("--project-root requires a value");
			continue;
		}
		if (argument === "--limit") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--limit requires a numeric value");
			limit = Number(value);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown playbooks option ${argument}`);
		positional.push(argument);
	}
	const [action, id, second] = positional;
	let result: unknown;
	let human: string;
	switch (action) {
		case "create": {
			if (id) throw new Error("playbooks create accepts no positional arguments");
			if (!title) throw new Error("playbooks create requires --title");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.create", {
				title,
				body,
				trigger,
				steps,
				tools,
				labels,
				extra,
				arguments: playbookArguments,
				project_root: playbookProjectRoot,
			});
			result = artifact;
			human = `Created playbook: ${artifactLabel(artifact)}`;
			break;
		}
		case "list": {
			if (id) throw new Error("playbooks list accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("playbooks.list", {
				status,
				text,
				limit,
				project_root: playbookProjectRoot,
			});
			result = rows;
			human = rows.length === 0 ? "No playbooks found." : rows.map((row) => artifactLabel(row)).join("\n");
			break;
		}
		case "show": {
			if (!id || second) throw new Error("playbooks show requires exactly one playbook id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.show", { id });
			result = artifact;
			human = `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`;
			break;
		}
		case "preview": {
			if (!id || second) throw new Error("playbooks preview requires exactly one playbook id");
			const rendered = await client.call<Record<string, unknown>, string>("playbooks.preview", { id, arguments: playbookArguments });
			result = rendered;
			human = rendered;
			break;
		}
		case "invoke": {
			if (!id || second) throw new Error("playbooks invoke requires exactly one playbook id");
			const invocation = await client.call<Record<string, unknown>, { entryTaskId: string; missingArguments?: string[] }>(
				"playbooks.invoke",
				{ id, arguments: playbookArguments, run_id: runId, project_root: playbookProjectRoot },
			);
			result = invocation;
			human = invocation.missingArguments
				? `Missing required argument(s): ${invocation.missingArguments.join(", ")}.`
				: `Invoked: entry task ${invocation.entryTaskId} focused. Drive it forward with \`tasks start/submit/complete\` like any other task.`;
			break;
		}
		case "enable":
		case "disable": {
			if (!id || second) throw new Error(`playbooks ${action} requires exactly one playbook id`);
			const artifact = await client.call<Record<string, unknown>, CliArtifact>(`playbooks.${action}`, { id });
			result = artifact;
			human = `${artifactLabel(artifact)}`;
			break;
		}
		case "assign-project": {
			if (!id || (second === undefined && positional.length > 2)) throw new Error("playbooks assign-project requires <id> [project-root]");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.assign_project", { id, project_root: second });
			result = artifact;
			human = second ? `Assigned ${id} to ${second}` : `Unscoped ${id}`;
			break;
		}
		case "update": {
			if (!id || second) throw new Error("playbooks update requires exactly one playbook id");
			if (title === undefined && body === undefined && labels === undefined)
				throw new Error("playbooks update requires --title, --body, or --labels-json");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.update", { id, title, body, labels });
			result = artifact;
			human = `${artifactLabel(artifact)}`;
			break;
		}
		case "contain": {
			if (!id || !second || positional.length !== 3) throw new Error("playbooks contain requires a parent id and child id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.contain", { parent_id: id, child_id: second });
			result = artifact;
			human = `Nested: ${second} → ${artifactLabel(artifact)}`;
			break;
		}
		case "uncontain": {
			if (!id || !second || positional.length !== 3) throw new Error("playbooks uncontain requires a parent id and child id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.uncontain", { parent_id: id, child_id: second });
			result = artifact;
			human = `Removed ${second} from ${artifactLabel(artifact)}`;
			break;
		}
		case "depend": {
			if (!id || !second || positional.length !== 3) throw new Error("playbooks depend requires a playbook id and prerequisite id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.depend", { id, dependency_id: second });
			result = artifact;
			human = `Dependency added: ${artifactLabel(artifact)} waits for ${second}`;
			break;
		}
		case "undepend": {
			if (!id || !second || positional.length !== 3) throw new Error("playbooks undepend requires a playbook id and prerequisite id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("playbooks.undepend", { id, dependency_id: second });
			result = artifact;
			human = `Dependency removed: ${artifactLabel(artifact)} no longer waits for ${second}`;
			break;
		}
		default:
			throw new Error(
				"playbooks action must be create, list, show, invoke, preview, enable, disable, assign-project, update, contain, uncontain, depend, or undepend",
			);
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
	let reason: string | undefined;
	let text: string | undefined;
	let limit: number | undefined;
	let depth: number | undefined;
	let maxNodes: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--kind") {
			kind = args[++index];
			if (!kind) throw new Error("--kind requires a value");
			continue;
		}
		if (argument === "--title") {
			title = args[++index];
			if (title === undefined) throw new Error("--title requires a value");
			continue;
		}
		if (argument === "--body") {
			body = args[++index];
			if (body === undefined) throw new Error("--body requires a value");
			continue;
		}
		if (argument === "--status") {
			status = args[++index];
			if (!status) throw new Error("--status requires a value");
			continue;
		}
		if (argument === "--subtype") {
			subtype = args[++index];
			if (!subtype) throw new Error("--subtype requires a value");
			continue;
		}
		if (argument === "--labels-json") {
			labels = parseJsonStringArrayFlag(args[++index], "--labels-json");
			continue;
		}
		if (argument === "--extra-json") {
			extra = parseJsonObjectFlag(args[++index], "--extra-json");
			continue;
		}
		if (argument === "--template-id") {
			templateId = args[++index];
			if (!templateId) throw new Error("--template-id requires a value");
			continue;
		}
		if (argument === "--reason") {
			reason = args[++index];
			if (reason === undefined) throw new Error("--reason requires a value");
			continue;
		}
		if (argument === "--text") {
			text = args[++index];
			if (text === undefined) throw new Error("--text requires a value");
			continue;
		}
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
				kind,
				title,
				body,
				status,
				subtype,
				labels,
				extra,
				template_id: templateId,
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
		case "remove": {
			if (!id) throw new Error("artifact remove requires exactly one artifact id");
			const record = await client.call<
				Record<string, unknown>,
				{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string }
			>("artifact.remove", { id, reason });
			result = record;
			human = `Trashed ${record.artifactId}: eligible for purge at ${record.purgeAfter}`;
			break;
		}
		case "remove-subtree": {
			if (!id) throw new Error("artifact remove-subtree requires exactly one artifact id");
			const outcome = await client.call<Record<string, unknown>, { removed: string[]; skipped: string[] }>("artifact.remove_subtree", {
				id,
				reason,
			});
			result = outcome;
			human = `Trashed ${outcome.removed.length} artifact(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-trashed` : ""}.`;
			break;
		}
		case "restore": {
			if (!id) throw new Error("artifact restore requires exactly one artifact id");
			const outcome = await client.call<Record<string, unknown>, { restored: boolean }>("artifact.restore", { id });
			result = outcome;
			human = outcome.restored ? `Restored ${id}` : `${id} was not trashed`;
			break;
		}
		case "trash-status": {
			if (!id) throw new Error("artifact trash-status requires exactly one artifact id");
			const record = await client.call<
				Record<string, unknown>,
				{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string } | null
			>("artifact.trash_status", { id });
			result = record;
			human = record
				? `${record.artifactId}: trashed at ${record.trashedAt}, purge eligible at ${record.purgeAfter}`
				: `${id} is not trashed`;
			break;
		}
		case "trash-list": {
			if (id) throw new Error("artifact trash-list accepts no positional arguments");
			const rows = await client.call<
				Record<string, unknown>,
				Array<{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string }>
			>("artifact.trash_list", {});
			result = rows;
			human =
				rows.length === 0 ? "Trash is empty." : rows.map((row) => `${row.artifactId}: purge eligible at ${row.purgeAfter}`).join("\n");
			break;
		}
		default:
			throw new Error("artifact action must be create, query, show, remove, remove-subtree, restore, trash-status, or trash-list");
	}
	return json ? JSON.stringify(result) : human;
}

export { runDiscussCli, runGatesCli, runGraphProjectionCli, runLogCli, runNoteCli, runSessionIdentityCli };

export async function runTaskCli(args: string[], client: TaskCliClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional: string[] = [];
	const updateInput: { title?: string; body?: string; labels?: string[]; status?: "todo" } = {};
	let reason: string | undefined;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
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
	let owner: string | undefined;
	let token: string | undefined;
	let ttlMs: number | undefined;
	let note: string | undefined;
	let cursor: number | undefined;
	let eventTypes: string[] | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") continue;
		if (argument === "--session-id") {
			sessionId = args[++index];
			if (!sessionId) throw new Error("--session-id requires a value");
			continue;
		}
		if (argument === "--session-secret") {
			sessionSecret = args[++index];
			if (!sessionSecret) throw new Error("--session-secret requires a value");
			continue;
		}
		if (
			argument === "--title" ||
			argument === "--body" ||
			argument === "--labels-json" ||
			argument === "--status" ||
			argument === "--reason"
		) {
			const value = args[++index];
			if (value === undefined) throw new Error(`${argument} requires a value`);
			if (argument === "--title") {
				updateInput.title = value;
				title = value;
			} else if (argument === "--body") {
				updateInput.body = value;
				body = value;
			} else if (argument === "--reason") reason = value;
			else if (argument === "--status") {
				status = value;
				if (value === "todo") updateInput.status = value;
			} else {
				labels = parseJsonStringArrayFlag(value, "--labels-json");
				updateInput.labels = labels;
			}
			continue;
		}
		if (argument === "--extra-json") {
			extra = parseJsonObjectFlag(args[++index]!, "--extra-json");
			continue;
		}
		if (argument === "--gates-json") {
			const value = args[++index];
			if (!value) throw new Error("--gates-json requires a value");
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) throw new Error("--gates-json must be a JSON array");
			gates = parsed;
			continue;
		}
		if (argument === "--checklist-json") {
			checklist = parseJsonObjectFlag(args[++index]!, "--checklist-json");
			continue;
		}
		if (argument === "--template-id") {
			templateId = args[++index];
			if (!templateId) throw new Error("--template-id requires a value");
			continue;
		}
		if (argument === "--parent-id") {
			parentId = args[++index];
			if (!parentId) throw new Error("--parent-id requires a value");
			continue;
		}
		if (argument === "--depends-on-json") {
			dependsOn = parseJsonStringArrayFlag(args[++index]!, "--depends-on-json");
			continue;
		}
		if (argument === "--text") {
			text = args[++index];
			if (text === undefined) throw new Error("--text requires a value");
			continue;
		}
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
		if (argument === "--root-task-id") {
			rootTaskId = args[++index];
			if (!rootTaskId) throw new Error("--root-task-id requires a value");
			continue;
		}
		if (argument === "--owner") {
			owner = args[++index];
			if (!owner) throw new Error("--owner requires a value");
			continue;
		}
		if (argument === "--token") {
			token = args[++index];
			if (!token) throw new Error("--token requires a value");
			continue;
		}
		if (argument === "--note") {
			note = args[++index];
			if (note === undefined) throw new Error("--note requires a value");
			continue;
		}
		if (argument === "--ttl-ms") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--ttl-ms requires a numeric value");
			ttlMs = Number(value);
			continue;
		}
		if (argument === "--cursor") {
			const value = args[++index];
			if (!value || Number.isNaN(Number(value))) throw new Error("--cursor requires a numeric value");
			cursor = Number(value);
			continue;
		}
		if (argument === "--event-types-json") {
			eventTypes = parseJsonStringArrayFlag(args[++index]!, "--event-types-json");
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`unknown tasks option ${argument}`);
		positional.push(argument);
	}
	const [action, id, dependencyId] = positional;
	const reasonSupportedActions = new Set(["update", "depend", "undepend", "contain", "uncontain"]);
	if (reason !== undefined && !reasonSupportedActions.has(action ?? ""))
		throw new Error("--reason is only supported by tasks update, depend, undepend, contain, and uncontain");
	const sessionScope = sessionId ? { session_id: sessionId } : {};
	// Only meaningful alongside a registered session_id (see session.register); required by the
	// daemon only for the specific Focus-mutating operations below (focus/pause/unpause/clear_focus)
	// once that session_id has been armored (see session-identity-service.ts assertAuthorized).
	const sessionSecretField = sessionSecret ? { session_secret: sessionSecret } : {};
	let result: unknown;
	let human: string;
	switch (action) {
		case "active": {
			if (id) throw new Error("tasks active accepts no positional arguments");
			const active = await client.call<Record<string, unknown>, CliArtifact | null>("tasks.active", {
				project_root: projectRoot,
				...sessionScope,
			});
			result = active;
			human = active ? `Active: ${artifactLabel(active)}` : "No active task.";
			break;
		}
		case "focused": {
			if (id) throw new Error("tasks focused accepts no positional arguments");
			const focus = await client.call<
				Record<string, unknown>,
				{ artifact: CliArtifact; status: "active" | "paused"; updatedAt: string } | null
			>("tasks.focused", { project_root: projectRoot, ...sessionScope });
			result = focus;
			human = focus ? `Focused (${focus.status}): ${artifactLabel(focus.artifact)}` : "No focused task.";
			break;
		}
		case "pause":
		case "unpause": {
			if (id) throw new Error(`tasks ${action} accepts no positional arguments`);
			const operation = action === "pause" ? "tasks.pause" : "tasks.unpause";
			const focus = await client.call<Record<string, unknown>, { artifact: CliArtifact; status: string }>(operation, {
				actor: "user",
				source: "cli",
				...sessionScope,
				...sessionSecretField,
			});
			result = focus;
			human = `Focused (${focus.status}): ${artifactLabel(focus.artifact)}`;
			break;
		}
		case "clear-focus": {
			if (id) throw new Error("tasks clear-focus accepts no positional arguments");
			const cleared = await client.call<Record<string, unknown>, { cleared: boolean }>("tasks.clear_focus", {
				actor: "user",
				source: "cli",
				...sessionScope,
				...sessionSecretField,
			});
			result = cleared;
			human = cleared.cleared ? "Task focus cleared." : "No focused task.";
			break;
		}
		case "reap-stale-focus": {
			if (id) throw new Error("tasks reap-stale-focus accepts no positional arguments");
			const reaped = await client.call<Record<string, unknown>, { removed: number }>("tasks.reap_stale_focus", {});
			result = reaped;
			human = `Reaped ${reaped.removed} stale Focus scope(s).`;
			break;
		}
		case "claim": {
			if (!id || dependencyId) throw new Error("tasks claim requires exactly one task id");
			if (!owner) throw new Error("tasks claim requires --owner");
			const lease = await client.call<Record<string, unknown>, CliTaskLease>("tasks.claim", { id, owner, ttl_ms: ttlMs, note });
			result = lease;
			human = `Claimed by "${lease.owner}" until ${lease.leaseExpiresAt} (token ${lease.token}).`;
			break;
		}
		case "heartbeat-lease": {
			if (!id || dependencyId) throw new Error("tasks heartbeat-lease requires exactly one task id");
			if (!owner || !token) throw new Error("tasks heartbeat-lease requires --owner and --token");
			const lease = await client.call<Record<string, unknown>, CliTaskLease>("tasks.heartbeat_lease", { id, owner, token, ttl_ms: ttlMs });
			result = lease;
			human = `Renewed until ${lease.leaseExpiresAt}.`;
			break;
		}
		case "release-lease": {
			if (!id || dependencyId) throw new Error("tasks release-lease requires exactly one task id");
			if (!owner || !token) throw new Error("tasks release-lease requires --owner and --token");
			const released = await client.call<Record<string, unknown>, { released: boolean }>("tasks.release_lease", { id, owner, token });
			result = released;
			human = released.released ? "Lease released." : "No live lease to release.";
			break;
		}
		case "lease": {
			if (!id || dependencyId) throw new Error("tasks lease requires exactly one task id");
			const lease = await client.call<Record<string, unknown>, CliTaskLease | null>("tasks.lease", { id });
			result = lease;
			human = lease ? `Leased by "${lease.owner}" until ${lease.leaseExpiresAt}.` : "No live lease.";
			break;
		}
		case "reap-stale-leases": {
			if (id) throw new Error("tasks reap-stale-leases accepts no positional arguments");
			const reaped = await client.call<Record<string, unknown>, { removed: number }>("tasks.reap_stale_leases", {});
			result = reaped;
			human = `Reaped ${reaped.removed} expired lease(s).`;
			break;
		}
		case "event-feed": {
			if (id) throw new Error("tasks event-feed accepts no positional arguments");
			const page = await client.call<Record<string, unknown>, import("./domain/task-event.ts").TaskEventFeedPage>("tasks.event_feed", {
				cursor,
				limit,
				event_types: eventTypes,
			});
			result = page;
			human =
				page.events.length === 0
					? "No events."
					: page.events.map((event) => `${event.id} ${event.occurredAt} ${event.taskId} ${event.type}`).join("\n");
			break;
		}
		case "create": {
			if (id) throw new Error("tasks create accepts no positional arguments");
			if (!title) throw new Error("tasks create requires --title");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.create", {
				title,
				body,
				status,
				labels,
				extra,
				gates,
				checklist,
				template_id: templateId,
				parent_id: parentId,
				depends_on: dependsOn,
				project_root: projectRoot,
				actor: "user",
				source: "cli",
				...sessionScope,
			});
			result = artifact;
			human = `Created task: ${artifactLabel(artifact)}`;
			break;
		}
		case "list": {
			if (id) throw new Error("tasks list accepts no positional arguments");
			const rows = await client.call<Record<string, unknown>, CliArtifact[]>("tasks.list", {
				status,
				text,
				limit,
				labels,
				project_root: projectRoot,
				scope: listScope,
				root_task_id: rootTaskId,
				...sessionScope,
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
			human =
				results.length === 0
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
		case "set-gates": {
			if (!id || dependencyId) throw new Error("tasks set-gates requires exactly one task id");
			if (!gates) throw new Error("tasks set-gates requires --gates-json");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.set_gates", { id, gates });
			result = artifact;
			human = `Updated gates: ${artifactLabel(artifact)}`;
			break;
		}
		case "context": {
			if (id) throw new Error("tasks context accepts no positional arguments");
			const summary = await client.call<Record<string, unknown>, string | null>("tasks.context", {
				project_root: projectRoot,
				scope: listScope,
				root_task_id: rootTaskId,
				...sessionScope,
			});
			result = summary;
			human = summary ?? "No open tasks.";
			break;
		}
		case "contain": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks contain requires a parent id and child id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.contain", {
				parent_id: id,
				child_id: dependencyId,
				actor: "user",
				source: "cli",
				...(reason ? { reason } : {}),
				...sessionScope,
			});
			result = artifact;
			human = `Contained: ${dependencyId} → ${artifactLabel(artifact)}`;
			break;
		}
		case "uncontain": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks uncontain requires a parent id and child id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.uncontain", {
				parent_id: id,
				child_id: dependencyId,
				actor: "user",
				source: "cli",
				...(reason ? { reason } : {}),
				...sessionScope,
			});
			result = artifact;
			human = `Removed ${dependencyId} from ${artifactLabel(artifact)}`;
			break;
		}
		case "update": {
			if (!id || dependencyId) throw new Error("tasks update requires exactly one task id");
			if (status !== undefined && status !== "todo")
				throw new Error("tasks update --status only supports todo for accidental creation recovery");
			if (Object.keys(updateInput).length === 0) throw new Error("tasks update requires --title, --body, --labels-json, or --status todo");
			if (updateInput.status !== undefined && !reason?.trim()) throw new Error("tasks update --status requires --reason");
			if (reason !== undefined && updateInput.status === undefined) throw new Error("tasks update --reason requires --status todo");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.update", {
				id,
				...updateInput,
				...(reason ? { reason } : {}),
				actor: "user",
				source: "cli",
			});
			result = artifact;
			human = `Updated: ${artifactLabel(artifact)}`;
			break;
		}
		case "history": {
			if (!id || dependencyId) throw new Error("tasks history requires exactly one task id");
			const page = await client.call<{ id: string; direction: "desc" }, import("./domain/task-event.ts").TaskHistoryPage>("tasks.history", {
				id,
				direction: "desc",
			});
			result = page;
			human =
				page.events.length === 0
					? `No recorded history for ${id}.`
					: [...page.events]
							.reverse()
							.map(
								(event) =>
									`${event.occurredAt} ${event.type} ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"} · ${event.actor}/${event.source}${event.reason ? ` · ${event.reason}` : ""}`,
							)
							.join("\n");
			break;
		}
		case "scope": {
			if (!id) {
				const selection = await client.call<Record<string, string>, import("./domain/task-scope.ts").TaskViewSelection>("tasks.scope", {
					project_root: projectRoot,
				});
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
			const active = await client.call<Record<string, unknown>, CliArtifact>("tasks.focus", {
				id,
				actor: "user",
				source: "cli",
				...sessionScope,
				...sessionSecretField,
			});
			result = active;
			human = `Active: ${artifactLabel(active)}`;
			break;
		}
		case "graph": {
			if (id) throw new Error("tasks graph accepts no positional arguments");
			const graph = await client.call<
				Record<string, unknown>,
				{
					nodes: Array<{ dependencyIds: string[]; childIds: string[] }>;
					rootIds: string[];
				}
			>("tasks.graph", {
				limit: TASK_EXECUTION_MAX_NODES + 1,
				labels,
				project_root: projectRoot,
				scope: listScope,
				root_task_id: rootTaskId,
				...sessionScope,
			});
			result = graph;
			const dependencies = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
			const children = graph.nodes.reduce((count, node) => count + node.childIds.length, 0);
			human = `Task graph: ${graph.nodes.length} nodes, ${graph.rootIds.length} roots, ${dependencies} dependencies, ${children} containment edges`;
			break;
		}
		case "plan": {
			if (id) throw new Error("tasks plan accepts no positional arguments");
			const plan = await client.call<Record<string, unknown>, TaskExecutionPlan>("tasks.plan", {
				project_root: projectRoot,
				...sessionScope,
			});
			result = plan;
			human = planText(plan);
			break;
		}
		case "complete": {
			if (!id || dependencyId) throw new Error("tasks complete requires exactly one task id");
			const completion = await client.call<Record<string, unknown>, CliCompletion>("tasks.complete", {
				id,
				actor: "user",
				source: "cli",
				...sessionScope,
			});
			result = completion;
			const lines = [`${completion.completed ? "Completed" : "Rejected"}: ${artifactLabel(completion.artifact)}`];
			if (completion.focused) lines.push(`Active: ${artifactLabel(completion.focused)}`);
			if (completion.blocked.length > 0) {
				lines.push(
					`Blocked: ${completion.blocked.map((entry) => `${artifactLabel(entry.artifact)} waits for ${entry.dependencyIds.join(", ")}`).join("; ")}`,
				);
			}
			for (const gate of completion.gates) lines.push(`${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`);
			human = lines.join("\n");
			break;
		}
		case "start": {
			if (!id || dependencyId) throw new Error("tasks start requires exactly one task id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.start", {
				id,
				actor: "user",
				source: "cli",
				...sessionScope,
			});
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
			const artifact = await client.call<Record<string, unknown>, CliArtifact>(operation, {
				id,
				actor: "user",
				source: "cli",
				...sessionScope,
			});
			result = artifact;
			human = `${action[0]!.toUpperCase()}${action.slice(1)}: ${artifactLabel(artifact)}`;
			break;
		}
		case "cancel-subtree": {
			if (!id || dependencyId) throw new Error("tasks cancel-subtree requires exactly one task id");
			const outcome = await client.call<Record<string, unknown>, { canceled: string[]; skipped: string[] }>("tasks.cancel_subtree", {
				id,
				actor: "user",
				source: "cli",
				...sessionScope,
			});
			result = outcome;
			human = `Canceled ${outcome.canceled.length} task(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-terminal` : ""}.`;
			break;
		}
		case "depend": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks depend requires a task id and prerequisite id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.depend", {
				id,
				dependency_id: dependencyId,
				actor: "user",
				source: "cli",
				...(reason ? { reason } : {}),
				...sessionScope,
			});
			result = artifact;
			human = `Dependency added: ${artifactLabel(artifact)} waits for ${dependencyId}`;
			break;
		}
		case "undepend": {
			if (!id || !dependencyId || positional.length !== 3) throw new Error("tasks undepend requires a task id and prerequisite id");
			const artifact = await client.call<Record<string, unknown>, CliArtifact>("tasks.undepend", {
				id,
				dependency_id: dependencyId,
				actor: "user",
				source: "cli",
				...(reason ? { reason } : {}),
				...sessionScope,
			});
			result = artifact;
			human = `Dependency removed: ${artifactLabel(artifact)} no longer waits for ${dependencyId}`;
			break;
		}
		default:
			throw new Error(
				"tasks action must be create, list, show, active, focused, focus, pause, unpause, clear-focus, update, graph, plan, context, history, scope, assign-project, complete, start, submit, reject, retry, cancel, cancel-subtree, depend, undepend, contain, uncontain, run-gates, set-checklist, or set-gates",
			);
	}
	return json ? JSON.stringify(result) : human;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	const [command, action] = args;
	if (command === "serve") {
		serveMain();
		return;
	}
	if (command === "tasks") {
		const client = await connectPapyrusClient();
		console.log(await runTaskCli(args.slice(1), client));
		return;
	}
	if (command === "playbooks") {
		const client = await connectPapyrusClient();
		console.log(await runPlaybooksCli(args.slice(1), client));
		return;
	}
	if (command === "notes") {
		const client = await connectPapyrusClient();
		console.log(await runNoteCli(args.slice(1), client));
		return;
	}
	if (command === "log") {
		const client = await connectPapyrusClient();
		console.log(await runLogCli(args.slice(1), client));
		return;
	}
	if (command === "session") {
		const client = await connectPapyrusClient();
		console.log(await runSessionIdentityCli(args.slice(1), client));
		return;
	}
	if (command === "discuss") {
		const client = await connectPapyrusClient();
		console.log(await runDiscussCli(args.slice(1), client));
		return;
	}
	if (command === "migrate") {
		const client = await connectPapyrusClient();
		console.log(await runMigrationCli(args.slice(1), client));
		return;
	}
	if (command === "migrate-ids") {
		console.log(runIdMigrationCli(args.slice(1)));
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
	if (command === "graph-projection") {
		const client = await connectPapyrusClient();
		console.log(await runGraphProjectionCli(args.slice(1), client));
		return;
	}
	if (command !== "service") usage();
	switch (action) {
		case "install":
			installService();
			break;
		case "start":
			systemctl("start", DAEMON_UNIT_NAME);
			break;
		case "stop":
			systemctl("stop", DAEMON_UNIT_NAME);
			break;
		case "restart":
			systemctl("restart", DAEMON_UNIT_NAME);
			break;
		case "status":
			systemctl("status", DAEMON_UNIT_NAME);
			break;
		default:
			usage();
	}
}

if (import.meta.main) {
	void main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
