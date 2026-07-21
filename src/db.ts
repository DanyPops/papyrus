/**
 * db.ts — enforced-schema SQLite store for Papyrus.
 * Dual-runtime: bun:sqlite (Bun) / node:sqlite (Node/pi host).
 * Four kinds (doc/task/rule/skill) are FK-enforced; relations are universal (any→any).
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION } from "./constants.ts";

const require_ = createRequire(import.meta.url);
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const backend = IS_BUN
	? (require_("bun:sqlite") as typeof import("bun:sqlite"))
	: (require_("node:sqlite") as unknown as typeof import("bun:sqlite"));

const DatabaseCtor = (
	"DatabaseSync" in backend ? (backend as { DatabaseSync: unknown }).DatabaseSync : backend.Database
) as new (path: string, opts?: { create?: boolean }) => Db;

export interface DbStatement {
	run(...params: unknown[]): { lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}
export interface Db {
	exec(sql: string): unknown;
	prepare(sql: string): DbStatement;
	close(): void;
}

const TRANSACTION_DEPTH = new WeakMap<object, number>();

export function inTransaction<T>(db: Db, fn: () => T): T {
	const depth = TRANSACTION_DEPTH.get(db as object) ?? 0;
	if (depth > 0) {
		const savepoint = `papyrus_nested_${depth}`;
		db.exec(`SAVEPOINT ${savepoint}`);
		TRANSACTION_DEPTH.set(db as object, depth + 1);
		try {
			const result = fn();
			db.exec(`RELEASE SAVEPOINT ${savepoint}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
			db.exec(`RELEASE SAVEPOINT ${savepoint}`);
			throw error;
		} finally {
			TRANSACTION_DEPTH.set(db as object, depth);
		}
	}

	db.exec("BEGIN IMMEDIATE");
	TRANSACTION_DEPTH.set(db as object, 1);
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	} finally {
		TRANSACTION_DEPTH.delete(db as object);
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS module_migrations (
	module_id   TEXT NOT NULL,
	version     INTEGER NOT NULL,
	name        TEXT NOT NULL,
	checksum    TEXT NOT NULL,
	applied_at  TEXT NOT NULL,
	PRIMARY KEY (module_id, version)
);
CREATE TABLE IF NOT EXISTS kinds (
	name        TEXT PRIMARY KEY,
	description TEXT
);
CREATE TABLE IF NOT EXISTS statuses (
	name        TEXT NOT NULL,
	kind        TEXT NOT NULL REFERENCES kinds(name),
	PRIMARY KEY (name, kind)
);
CREATE TABLE IF NOT EXISTS artifacts (
	id          TEXT PRIMARY KEY,
	kind        TEXT NOT NULL REFERENCES kinds(name),
	title       TEXT NOT NULL,
	status      TEXT NOT NULL,
	subtype     TEXT DEFAULT '',
	body        TEXT DEFAULT '',
	labels      TEXT DEFAULT '[]',
	extra       TEXT DEFAULT '{}',
	created_at  TEXT NOT NULL,
	updated_at  TEXT NOT NULL,
	FOREIGN KEY (kind, status) REFERENCES statuses(kind, name)
);
CREATE TABLE IF NOT EXISTS edges (
	from_id     TEXT NOT NULL REFERENCES artifacts(id),
	relation    TEXT NOT NULL REFERENCES relation_names(name),
	to_id       TEXT NOT NULL REFERENCES artifacts(id),
	PRIMARY KEY (from_id, relation, to_id)
);
CREATE TABLE IF NOT EXISTS relation_names (
	name        TEXT PRIMARY KEY,
	description TEXT
);
CREATE TABLE IF NOT EXISTS task_focus (
	scope       TEXT PRIMARY KEY CHECK (scope = 'global'),
	task_id     TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
	status      TEXT NOT NULL CHECK (status IN ('active', 'paused')),
	pause_reason TEXT,
	updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id              TEXT NOT NULL REFERENCES artifacts(id),
	occurred_at           TEXT NOT NULL,
	event_type            TEXT NOT NULL,
	actor                 TEXT NOT NULL,
	source                TEXT NOT NULL,
	session_id            TEXT,
	reason                TEXT,
	from_status           TEXT,
	to_status             TEXT,
	attempt_id             TEXT,
	evidence_json         TEXT,
	event_schema_version  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS task_events_history_idx ON task_events(task_id, occurred_at, id);
CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END;
CREATE TABLE IF NOT EXISTS task_scopes (
	task_id       TEXT PRIMARY KEY REFERENCES artifacts(id),
	project_root  TEXT,
	source        TEXT NOT NULL CHECK (source IN ('cwd', 'explicit', 'unscoped')),
	assigned_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_scopes_project_idx ON task_scopes(project_root, task_id);
CREATE TABLE IF NOT EXISTS task_views (
	project_root  TEXT PRIMARY KEY,
	mode          TEXT NOT NULL CHECK (mode IN ('project', 'graph', 'all')),
	root_task_id  TEXT REFERENCES artifacts(id),
	updated_at    TEXT NOT NULL,
	CHECK ((mode = 'graph' AND root_task_id IS NOT NULL) OR (mode != 'graph' AND root_task_id IS NULL))
);
`;

const SEED_SQL = `
INSERT OR IGNORE INTO kinds VALUES ('doc','Knowledge — what we know (specs, decisions, research, designs)');
INSERT OR IGNORE INTO kinds VALUES ('task','Work — what we are doing (objectives, steps, checklists)');
INSERT OR IGNORE INTO kinds VALUES ('rule','Governance — when doing X, follow Y');
INSERT OR IGNORE INTO kinds VALUES ('skill','Parameterized workflow bundle — inputs and templates load tasks, rules, and docs');
INSERT OR IGNORE INTO statuses VALUES ('draft','doc');
INSERT OR IGNORE INTO statuses VALUES ('active','doc');
INSERT OR IGNORE INTO statuses VALUES ('archived','doc');
INSERT OR IGNORE INTO statuses VALUES ('todo','task');
INSERT OR IGNORE INTO statuses VALUES ('in-progress','task');
INSERT OR IGNORE INTO statuses VALUES ('review','task');
INSERT OR IGNORE INTO statuses VALUES ('rejected','task');
INSERT OR IGNORE INTO statuses VALUES ('done','task');
INSERT OR IGNORE INTO statuses VALUES ('canceled','task');
INSERT OR IGNORE INTO statuses VALUES ('active','rule');
INSERT OR IGNORE INTO statuses VALUES ('deprecated','rule');
INSERT OR IGNORE INTO statuses VALUES ('active','skill');
INSERT OR IGNORE INTO statuses VALUES ('deprecated','skill');
INSERT OR IGNORE INTO relation_names VALUES ('references','Source material (doc→doc, doc→task, doc→rule)');
INSERT OR IGNORE INTO relation_names VALUES ('implements','This work satisfies that (task→doc, task→rule)');
INSERT OR IGNORE INTO relation_names VALUES ('follows','This work obeys that (task→rule, task→skill)');
INSERT OR IGNORE INTO relation_names VALUES ('depends_on','DAG ordering (task→task)');
INSERT OR IGNORE INTO relation_names VALUES ('documents','Describes (doc→task, doc→rule, doc→skill)');
INSERT OR IGNORE INTO relation_names VALUES ('blocks','Blocking relationship (task→task)');
INSERT OR IGNORE INTO relation_names VALUES ('supersedes','Replaces (doc→doc, rule→rule)');
INSERT OR IGNORE INTO relation_names VALUES ('relates_to','Catch-all (any→any)');
INSERT OR IGNORE INTO relation_names VALUES ('gates','This rule gates that task (rule→task)');
INSERT OR IGNORE INTO relation_names VALUES ('triggers','This skill applies to that work (skill→task)');
INSERT OR IGNORE INTO relation_names VALUES ('contains','Parent contains a nested artifact (any→any)');
INSERT OR IGNORE INTO relation_names VALUES ('part_of','Artifact belongs to a parent artifact (any→any)');
CREATE INDEX IF NOT EXISTS edges_to_id_idx ON edges(to_id);
`;

export interface MigrationResult {
	from: number;
	to: number;
	applied: string[];
}

export function schemaVersion(db: Db): number {
	return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * One row per (module_id, version) applied migration, checksummed so a since-edited
 * definition is detected rather than silently trusted. "core" consolidates this
 * repository's entire pre-ledger migration history (every schemaVersion 1..CURRENT
 * branch below) into one baseline, checked against the exact SCHEMA+SEED_SQL text those
 * branches converge on -- new modules going forward register their own migrations
 * independently, without touching "core" or duplicating a separate bootstrap path.
 */
export interface ModuleMigrationRow {
	readonly moduleId: string;
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly appliedAt: string;
}

const CORE_BASELINE_CHECKSUM = createHash("sha256").update(SCHEMA + SEED_SQL).digest("hex");

export function migrationLedger(db: Db): ModuleMigrationRow[] {
	// A database that has never reached current schema (still awaiting explicit migrateDb())
	// has no ledger table yet -- "nothing recorded" is the correct answer, not an error.
	const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'module_migrations'").get() != null;
	if (!tableExists) return [];
	const rows = db.prepare("SELECT module_id, version, name, checksum, applied_at FROM module_migrations ORDER BY module_id, version").all() as Array<{
		module_id: string; version: number; name: string; checksum: string; applied_at: string;
	}>;
	return rows.map((row) => ({ moduleId: row.module_id, version: row.version, name: row.name, checksum: row.checksum, appliedAt: row.applied_at }));
}

/**
 * Ensures the ledger correctly reflects "core" once a database is confirmed at the full
 * current schema, however it got there: a truly empty database runs the baseline DDL and
 * records it; a database that already reached current shape (a fresh bootstrap from a
 * past release, or a full upgrade through the pre-ledger sequential migrateDb() chain
 * below) is backfilled without re-running any DDL against data that already exists.
 * Verifies the stored checksum on every open so a since-edited baseline is caught, not
 * silently trusted.
 */
function ensureCoreBaseline(db: Db, alreadyAtCurrentSchema: boolean): void {
	// Idempotent and standalone: must succeed even on a truly empty database, before the rest
	// of SCHEMA (which also declares this table) has run.
	db.exec(`
		CREATE TABLE IF NOT EXISTS module_migrations (
			module_id   TEXT NOT NULL,
			version     INTEGER NOT NULL,
			name        TEXT NOT NULL,
			checksum    TEXT NOT NULL,
			applied_at  TEXT NOT NULL,
			PRIMARY KEY (module_id, version)
		);
	`);
	const existingRow = db.prepare("SELECT checksum FROM module_migrations WHERE module_id = 'core' AND version = 1").get() as { checksum: string } | null;
	if (existingRow != null) {
		if (existingRow.checksum !== CORE_BASELINE_CHECKSUM) {
			throw new Error('module migration "core" version 1 checksum mismatch: the baseline definition changed since it was applied');
		}
		return;
	}
	inTransaction(db, () => {
		if (!alreadyAtCurrentSchema) {
			db.exec(SCHEMA);
			db.exec(SEED_SQL);
			db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
		}
		db.prepare("INSERT INTO module_migrations (module_id, version, name, checksum, applied_at) VALUES ('core', 1, 'baseline', ?, ?)")
			.run(CORE_BASELINE_CHECKSUM, new Date().toISOString());
	});
}

function bootstrapEmptyDatabase(db: Db): void {
	const existing = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
		.get();
	if (existing) throw new Error("database schema is unversioned; refusing to migrate existing data during boot");
	ensureCoreBaseline(db, false);
}

export function migrateDb(db: Db): MigrationResult {
	const from = schemaVersion(db);
	if (from > SQLITE_SCHEMA_VERSION) {
		throw new Error(`database schema ${from} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (from === SQLITE_SCHEMA_VERSION) return { from, to: from, applied: [] };
	if (from !== 1 && from !== 2 && from !== 3 && from !== 4) throw new Error(`no explicit migration path from database schema ${from}`);
	const applied: string[] = [];

	inTransaction(db, () => {
		if (schemaVersion(db) === 1) {
			db.exec(`
				INSERT OR IGNORE INTO statuses VALUES ('todo','task');
				INSERT OR IGNORE INTO statuses VALUES ('in-progress','task');
				INSERT OR IGNORE INTO statuses VALUES ('review','task');
				INSERT OR IGNORE INTO statuses VALUES ('rejected','task');
				INSERT OR IGNORE INTO statuses VALUES ('done','task');
				INSERT OR IGNORE INTO statuses VALUES ('canceled','task');
				CREATE TABLE task_focus (
					scope TEXT PRIMARY KEY CHECK (scope = 'global'),
					task_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
					updated_at TEXT NOT NULL
				);
				INSERT INTO task_focus (scope, task_id, updated_at)
				SELECT 'global', id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
				FROM artifacts WHERE kind = 'task' AND status = 'active'
				ORDER BY updated_at DESC, id ASC LIMIT 1;
				UPDATE artifacts SET status = CASE status
					WHEN 'pending' THEN 'todo'
					WHEN 'active' THEN 'in-progress'
					WHEN 'failed' THEN 'rejected'
					ELSE status END
				WHERE kind = 'task';
				DELETE FROM statuses WHERE kind = 'task' AND name IN ('pending', 'active', 'failed');
				PRAGMA user_version = 2;
			`);
			applied.push("task-lifecycle-and-focus");
		}
		if (schemaVersion(db) === 2) {
			db.exec(`
				CREATE TABLE task_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					task_id TEXT NOT NULL REFERENCES artifacts(id),
					occurred_at TEXT NOT NULL,
					event_type TEXT NOT NULL,
					actor TEXT NOT NULL,
					source TEXT NOT NULL,
					session_id TEXT,
					reason TEXT,
					from_status TEXT,
					to_status TEXT,
					attempt_id TEXT,
					evidence_json TEXT,
					event_schema_version INTEGER NOT NULL DEFAULT 1
				);
				CREATE INDEX task_events_history_idx ON task_events(task_id, occurred_at, id);
				CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
				BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END;
				CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
				BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END;
				PRAGMA user_version = 3;
			`);
			applied.push("task-history");
		}
		if (schemaVersion(db) === 3) {
			db.exec(`
				CREATE TABLE task_scopes (
					task_id TEXT PRIMARY KEY REFERENCES artifacts(id),
					project_root TEXT,
					source TEXT NOT NULL CHECK (source IN ('cwd', 'explicit', 'unscoped')),
					assigned_at TEXT NOT NULL
				);
				CREATE INDEX task_scopes_project_idx ON task_scopes(project_root, task_id);
				CREATE TABLE task_views (
					project_root TEXT PRIMARY KEY,
					mode TEXT NOT NULL CHECK (mode IN ('project', 'graph', 'all')),
					root_task_id TEXT REFERENCES artifacts(id),
					updated_at TEXT NOT NULL,
					CHECK ((mode = 'graph' AND root_task_id IS NOT NULL) OR (mode != 'graph' AND root_task_id IS NULL))
				);
				INSERT INTO task_scopes (task_id, project_root, source, assigned_at)
				SELECT id, NULL, 'unscoped', strftime('%Y-%m-%dT%H:%M:%fZ','now')
				FROM artifacts WHERE kind = 'task';
				PRAGMA user_version = 4;
			`);
			applied.push("task-project-scope");
		}
		if (schemaVersion(db) === 4) {
			db.exec(`
				ALTER TABLE task_focus ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused'));
				ALTER TABLE task_focus ADD COLUMN pause_reason TEXT;
				PRAGMA user_version = 5;
			`);
			applied.push("task-focus-continuation");
		}
	});
	if (schemaVersion(db) === SQLITE_SCHEMA_VERSION) ensureCoreBaseline(db, true);
	return { from, to: schemaVersion(db), applied };
}

export function openDb(path: string): Db {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = IS_BUN ? new DatabaseCtor(path, { create: true }) : new DatabaseCtor(path);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	const current = schemaVersion(db);
	if (current > SQLITE_SCHEMA_VERSION) {
		db.close();
		throw new Error(`database schema ${current} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (current === 0) bootstrapEmptyDatabase(db);
	else if (current === SQLITE_SCHEMA_VERSION) ensureCoreBaseline(db, true);
	db.exec("PRAGMA optimize=0x10002");
	return db;
}
