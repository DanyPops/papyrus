#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createNodeServiceInstallDeps, generateSystemdUnit, installUserService, type ServiceSpec } from "@danypops/vehicle-server/service";
import { runArtifactCli } from "./cli/artifact-command.ts";
import { runBatchCli } from "./cli/batch-command.ts";
import { runDaemonCli } from "./cli/daemon-command.ts";
import { runDiscussCli } from "./cli/discuss-command.ts";
import { runDocsCli } from "./cli/docs-command.ts";
import { runGatesCli } from "./cli/gates-command.ts";
import { runGraphCli } from "./cli/graph-command.ts";
import { runGraphProjectionCli } from "./cli/graph-projection-command.ts";
import { runLogCli } from "./cli/log-command.ts";
import { runMigrationCli } from "./cli/migration-command.ts";
import { runNoteCli } from "./cli/note-command.ts";
import { runPlaybooksCli } from "./cli/playbooks-command.ts";
import { runProjectsCli } from "./cli/projects-command.ts";
import { runRulesCli } from "./cli/rules-command.ts";
import { runScopeGroupsCli } from "./cli/scope-groups-command.ts";
import { runSessionIdentityCli } from "./cli/session-identity-command.ts";
import { runTaskCli } from "./cli/task-command.ts";
import { connectPapyrusClient } from "./client.ts";
import { DAEMON_UNIT_NAME, dbPath } from "./constants.ts";
import { serveMain } from "./daemon/daemon.ts";
import { daemonStateDir, vehicleHandlePath } from "./daemon/daemon-state.ts";
import { openDb } from "./db.ts";
import { applyIdMigration, type IdMigrationPlan, mirrorDatabase, planIdMigration, verifyIdMigration } from "./id-migration.ts";
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
  papyrus tasks pause [--session-id <id>] [--session-secret <secret>] [--idempotency-key <key>] [--json]
  papyrus tasks unpause [--session-id <id>] [--session-secret <secret>] [--idempotency-key <key>] [--json]
  papyrus tasks clear-focus [--session-id <id>] [--session-secret <secret>] [--json]
  papyrus tasks reap-stale-focus [--json]
  papyrus tasks claim <id> --owner <owner> [--ttl-ms <ms>] [--note <text>] [--json]
  papyrus tasks heartbeat-lease <id> --owner <owner> --token <token> [--ttl-ms <ms>] [--json]
  papyrus tasks release-lease <id> --owner <owner> --token <token> [--json]
  papyrus tasks lease <id> [--json]
  papyrus tasks reap-stale-leases [--json]
  papyrus tasks event-feed [--cursor <n>] [--limit <n>] [--event-types-json <json>] [--json]
  papyrus tasks mutation-status <idempotency-key> [--json]
  papyrus tasks history <id> [--json]
  papyrus tasks scope [project|all|graph <root-id>] [--json]
  papyrus tasks assign-project <id> [project-root] [--json]
  papyrus tasks focus <id> [--session-id <id>] [--session-secret <secret>] [--json]
  papyrus tasks update <id> [--title <title>] [--body <body>] [--labels-json <json>] [--status todo --reason <reason>] [--json]
  papyrus tasks complete <id> [--session-id <id>] [--idempotency-key <key>] [--json]
  papyrus tasks start <id> [--session-id <id>] [--idempotency-key <key>] [--json]
  papyrus tasks submit <id> [--session-id <id>] [--idempotency-key <key>] [--json]
  papyrus tasks reject <id> [--session-id <id>] [--idempotency-key <key>] [--json]
  papyrus tasks retry <id> [--session-id <id>] [--idempotency-key <key>] [--json]
  papyrus tasks cancel <id> [--session-id <id>] [--idempotency-key <key>] [--json]
  papyrus tasks reopen <id> [--session-id <id>] [--idempotency-key <key>] [--json]
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

export { runDaemonCli, runMigrationCli };

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
			// openDb() always opens a file-backed database in WAL mode, including this mirror
			// (produced by VACUUM INTO with no WAL of its own until this very open). Fold it back
			// into the main file and drop the sidecars before copying just the main file below --
			// the same reasoning already applied to target's own sidecars a few lines down. Copying
			// the main file while leaving a newer -wal/-shm pair for a now-deleted identity behind
			// produces a file SQLite reopens as a malformed image, not merely a stale one.
			mirror.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			mirror.close();
			for (const sidecar of [`${mirrorPath}-wal`, `${mirrorPath}-shm`]) if (existsSync(sidecar)) unlinkSync(sidecar);
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
		// A plain copyFileSync(mirrorPath, target) overwrites target's own file content in place --
		// confirmed live to reopen as "database disk image is malformed" even though both the
		// checkpointed target and the checkpointed mirror are independently completely healthy
		// right before this copy: something about SQLite's own handling of a path/inode this
		// process already opened earlier in the same run (target was just opened above to
		// checkpoint it) survives closing that connection. Copying to a fresh staging path (a new
		// inode, never opened by this process) and swapping it into place with an atomic rename
		// sidesteps that entirely -- renameSync never fails partway the way a corrupted in-place
		// overwrite can.
		const staging = `${target}.promoting`;
		copyFileSync(mirrorPath, staging);
		renameSync(staging, target);
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

export {
	runArtifactCli,
	runBatchCli,
	runDiscussCli,
	runDocsCli,
	runGatesCli,
	runGraphCli,
	runGraphProjectionCli,
	runLogCli,
	runNoteCli,
	runPlaybooksCli,
	runProjectsCli,
	runRulesCli,
	runScopeGroupsCli,
	runSessionIdentityCli,
	runTaskCli,
};

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	const [command, action] = args;
	if (command === "serve") {
		await serveMain();
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
	if (command === "projects") {
		const client = await connectPapyrusClient();
		console.log(await runProjectsCli(args.slice(1), client));
		return;
	}
	if (command === "scope-groups") {
		const client = await connectPapyrusClient();
		console.log(await runScopeGroupsCli(args.slice(1), client));
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
	if (command === "batch") {
		const client = await connectPapyrusClient();
		console.log(await runBatchCli(args.slice(1), client));
		return;
	}
	if (command === "daemon") {
		const client = await connectPapyrusClient();
		console.log(await runDaemonCli(args.slice(1), client));
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
