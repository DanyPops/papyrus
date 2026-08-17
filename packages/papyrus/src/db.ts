import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { runMigrations, type SqliteMigrationRunner } from "@danypops/vehicle-server/storage";
import { generateUniqueAlias, slugify } from "./artifact/artifact-alias.ts";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION } from "./constants.ts";

const require_ = createRequire(import.meta.url);
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Bun's bun:sqlite exports Database; Node's node:sqlite exports DatabaseSync -- neither module is
 * actually the other, but both satisfy this shape at the methods Papyrus calls through Db/DbStatement. */
interface SqliteBackendModule {
	Database?: new (path: string, opts?: { create?: boolean }) => Db;
	DatabaseSync?: new (path: string, opts?: { create?: boolean }) => Db;
}

const backend = require_(IS_BUN ? "bun:sqlite" : "node:sqlite") as SqliteBackendModule;
// Explicit return type + IIFE: TS narrowing from a plain guard here wouldn't propagate into
// openDb() below, a separate function closing over this module-level binding.
const DatabaseCtor: new (path: string, opts?: { create?: boolean }) => Db = (() => {
	const ctor = backend.DatabaseSync ?? backend.Database;
	if (!ctor) throw new Error("no compatible sqlite backend found (expected bun:sqlite's Database or node:sqlite's DatabaseSync)");
	return ctor;
})();

export interface DbStatement {
	/** changes: number of rows the statement affected. Both bun:sqlite and node:sqlite's real run() return this at runtime; declared here so callers (e.g. reapStale) can rely on it without an unsafe cast. */
	run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
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
	alias       TEXT,
	FOREIGN KEY (kind, status) REFERENCES statuses(kind, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_alias_idx ON artifacts(alias);
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
	scope       TEXT PRIMARY KEY,
	task_id     TEXT NOT NULL REFERENCES artifacts(id),
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
WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.task_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'task_events are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
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
CREATE TABLE IF NOT EXISTS task_projects (
	id            TEXT PRIMARY KEY,
	name          TEXT NOT NULL,
	aliases_json  TEXT NOT NULL DEFAULT '[]',
	project_root  TEXT NOT NULL UNIQUE,
	created_at    TEXT NOT NULL,
	updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_projects_name_idx ON task_projects(name);
CREATE TABLE IF NOT EXISTS task_create_requests (
	request_scope   TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	request_hash    TEXT NOT NULL,
	response_json   TEXT NOT NULL,
	created_at      TEXT NOT NULL,
	expires_at      TEXT NOT NULL,
	PRIMARY KEY (request_scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS task_create_requests_expiry_idx ON task_create_requests(expires_at);
CREATE TABLE IF NOT EXISTS task_mutation_requests (
	request_scope   TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	receipt_id      TEXT NOT NULL UNIQUE,
	task_id         TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
	operation       TEXT NOT NULL,
	request_hash    TEXT NOT NULL,
	state           TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
	response_json   TEXT,
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	expires_at      TEXT NOT NULL,
	PRIMARY KEY (request_scope, idempotency_key),
	CHECK ((state = 'pending' AND response_json IS NULL) OR (state = 'completed' AND response_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS task_mutation_requests_expiry_idx ON task_mutation_requests(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS task_mutation_requests_pending_task_operation_idx
	ON task_mutation_requests(task_id, operation) WHERE state = 'pending' AND task_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS artifact_events (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	artifact_id          TEXT NOT NULL REFERENCES artifacts(id),
	occurred_at          TEXT NOT NULL,
	event_type           TEXT NOT NULL,
	actor                TEXT NOT NULL,
	source               TEXT NOT NULL,
	session_id           TEXT,
	from_status          TEXT,
	to_status            TEXT,
	relation             TEXT,
	related_id           TEXT,
	event_schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS artifact_events_artifact_idx ON artifact_events(artifact_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS artifact_events_related_idx ON artifact_events(related_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS artifact_events_actor_idx ON artifact_events(actor, occurred_at, id);
CREATE INDEX IF NOT EXISTS artifact_events_session_idx ON artifact_events(session_id, occurred_at, id);
CREATE TRIGGER IF NOT EXISTS artifact_events_no_update BEFORE UPDATE ON artifact_events
BEGIN SELECT RAISE(ABORT, 'artifact_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS artifact_events_no_delete BEFORE DELETE ON artifact_events
WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.artifact_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'artifact_events are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
CREATE TABLE IF NOT EXISTS graph_projection_checkpoints (
	producer_id    TEXT PRIMARY KEY,
	last_sequence  INTEGER NOT NULL,
	last_batch_id  TEXT NOT NULL,
	applied_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_projection_identities (
	producer_id   TEXT NOT NULL,
	external_id   TEXT NOT NULL,
	artifact_id   TEXT NOT NULL REFERENCES artifacts(id),
	PRIMARY KEY (producer_id, external_id)
);
CREATE INDEX IF NOT EXISTS graph_projection_identities_artifact_idx ON graph_projection_identities(artifact_id);
CREATE TABLE IF NOT EXISTS artifact_scopes (
	artifact_id   TEXT PRIMARY KEY REFERENCES artifacts(id),
	project_root  TEXT,
	mode          TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('none', 'all', 'explicit')),
	source        TEXT NOT NULL CHECK (source IN ('cwd', 'explicit', 'unscoped')),
	assigned_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_scopes_project_idx ON artifact_scopes(project_root, artifact_id);
CREATE TABLE IF NOT EXISTS artifact_scope_members (
	artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
	member_type  TEXT NOT NULL CHECK (member_type IN ('project', 'group')),
	member_id    TEXT NOT NULL,
	PRIMARY KEY (artifact_id, member_type, member_id)
);
CREATE INDEX IF NOT EXISTS artifact_scope_members_member_idx ON artifact_scope_members(member_type, member_id, artifact_id);
CREATE TABLE IF NOT EXISTS scope_groups (
	id            TEXT PRIMARY KEY,
	name          TEXT NOT NULL,
	aliases_json  TEXT NOT NULL DEFAULT '[]',
	created_at    TEXT NOT NULL,
	updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scope_groups_name_idx ON scope_groups(name);
CREATE TABLE IF NOT EXISTS scope_group_members (
	group_id     TEXT NOT NULL REFERENCES scope_groups(id) ON DELETE CASCADE,
	member_type  TEXT NOT NULL CHECK (member_type IN ('project', 'group')),
	member_id    TEXT NOT NULL,
	PRIMARY KEY (group_id, member_type, member_id)
);
CREATE INDEX IF NOT EXISTS scope_group_members_group_idx ON scope_group_members(group_id);
CREATE INDEX IF NOT EXISTS scope_group_members_member_idx ON scope_group_members(member_type, member_id);
CREATE TABLE IF NOT EXISTS log_sources (
	id            TEXT PRIMARY KEY,
	label         TEXT NOT NULL,
	project_root  TEXT,
	created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log_entries (
	id            TEXT PRIMARY KEY,
	source_id     TEXT NOT NULL REFERENCES log_sources(id),
	occurred_at   TEXT NOT NULL,
	level         TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
	message       TEXT NOT NULL,
	truncated     INTEGER NOT NULL DEFAULT 0,
	fields_json   TEXT NOT NULL DEFAULT '{}',
	operation_id  TEXT NOT NULL,
	session_id    TEXT,
	UNIQUE (source_id, operation_id)
);
CREATE INDEX IF NOT EXISTS log_entries_source_idx ON log_entries(source_id, occurred_at, id);
CREATE TRIGGER IF NOT EXISTS log_entries_no_update BEFORE UPDATE ON log_entries
BEGIN SELECT RAISE(ABORT, 'log_entries are immutable once written; retention trimming is the only supported deletion path'); END;
CREATE TABLE IF NOT EXISTS session_identities (
	session_id    TEXT PRIMARY KEY,
	secret_hash   TEXT NOT NULL,
	registered_at TEXT NOT NULL,
	last_seen_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_trash (
	artifact_id  TEXT PRIMARY KEY REFERENCES artifacts(id),
	trashed_at   TEXT NOT NULL,
	purge_after  TEXT NOT NULL,
	reason       TEXT
);
CREATE INDEX IF NOT EXISTS artifact_trash_purge_idx ON artifact_trash(purge_after);
CREATE TABLE IF NOT EXISTS discussion_rounds (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	discussion_id TEXT NOT NULL REFERENCES artifacts(id),
	round_number  INTEGER NOT NULL,
	actor         TEXT NOT NULL,
	content       TEXT NOT NULL,
	occurred_at   TEXT NOT NULL,
	event_schema_version INTEGER NOT NULL DEFAULT 1,
	options       TEXT,
	options_mode  TEXT,
	selected      TEXT,
	option_descriptions TEXT,
	-- Quiz: quiz marks a posing round (safe, public); quiz_correct_options/quiz_explanation are the
	-- hidden answer (never selected by any general-purpose query, only resolvePendingQuizAnswer's
	-- own dedicated one); quiz_result_* is the graded outcome on the answering round (public, safe
	-- once submission has already happened). See domain/discussion.ts.
	quiz          INTEGER,
	quiz_correct_options TEXT,
	quiz_explanation TEXT,
	quiz_result_correct INTEGER,
	quiz_result_correct_options TEXT,
	quiz_result_explanation TEXT,
	UNIQUE (discussion_id, round_number)
);
CREATE INDEX IF NOT EXISTS discussion_rounds_discussion_idx ON discussion_rounds(discussion_id, round_number, id);
CREATE TRIGGER IF NOT EXISTS discussion_rounds_no_update BEFORE UPDATE ON discussion_rounds
BEGIN SELECT RAISE(ABORT, 'discussion_rounds are append-only'); END;
CREATE TRIGGER IF NOT EXISTS discussion_rounds_no_delete BEFORE DELETE ON discussion_rounds
WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.discussion_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'discussion_rounds are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
CREATE TABLE IF NOT EXISTS task_leases (
	task_id           TEXT PRIMARY KEY REFERENCES artifacts(id),
	owner             TEXT NOT NULL,
	token             TEXT NOT NULL,
	claimed_at        TEXT NOT NULL,
	lease_expires_at  TEXT NOT NULL,
	heartbeat_at      TEXT,
	note              TEXT
);
CREATE INDEX IF NOT EXISTS task_leases_expiry_idx ON task_leases(lease_expires_at);
CREATE TABLE IF NOT EXISTS note_events (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	note_id              TEXT NOT NULL REFERENCES artifacts(id),
	occurred_at          TEXT NOT NULL,
	event_type           TEXT NOT NULL,
	actor                TEXT NOT NULL,
	source               TEXT NOT NULL,
	session_id           TEXT,
	reason               TEXT,
	related_id           TEXT,
	disposition          TEXT,
	event_schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS note_events_history_idx ON note_events(note_id, occurred_at, id);
CREATE TRIGGER IF NOT EXISTS note_events_no_update BEFORE UPDATE ON note_events
BEGIN SELECT RAISE(ABORT, 'note_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS note_events_no_delete BEFORE DELETE ON note_events
WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.note_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'note_events are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
`;

const SEED_SQL = `
INSERT OR IGNORE INTO kinds VALUES ('doc','Knowledge — what we know (specs, decisions, research, designs)');
INSERT OR IGNORE INTO kinds VALUES ('task','Work — what we are doing (objectives, steps, checklists)');
INSERT OR IGNORE INTO kinds VALUES ('rule','Governance — when doing X, follow Y');
INSERT OR IGNORE INTO kinds VALUES ('playbook','Reusable procedure — a trigger and an ordered list of steps an agent reads and follows, not a mechanically instantiated blueprint');
INSERT OR IGNORE INTO statuses VALUES ('draft','doc');
INSERT OR IGNORE INTO statuses VALUES ('active','doc');
INSERT OR IGNORE INTO statuses VALUES ('archived','doc');
INSERT OR IGNORE INTO statuses VALUES ('todo','task');
INSERT OR IGNORE INTO statuses VALUES ('in-progress','task');
INSERT OR IGNORE INTO statuses VALUES ('review','task');
INSERT OR IGNORE INTO statuses VALUES ('rejected','task');
INSERT OR IGNORE INTO statuses VALUES ('done','task');
INSERT OR IGNORE INTO statuses VALUES ('canceled','task');
INSERT OR IGNORE INTO statuses VALUES ('draft','rule');
INSERT OR IGNORE INTO statuses VALUES ('active','rule');
INSERT OR IGNORE INTO statuses VALUES ('deprecated','rule');
INSERT OR IGNORE INTO statuses VALUES ('active','playbook');
INSERT OR IGNORE INTO statuses VALUES ('deprecated','playbook');
INSERT OR IGNORE INTO relation_names VALUES ('references','Source material (doc→doc, doc→task, doc→rule)');
INSERT OR IGNORE INTO relation_names VALUES ('implements','This work satisfies that (task→doc, task→rule)');
INSERT OR IGNORE INTO relation_names VALUES ('follows','This work obeys that (task→rule, task→playbook)');
INSERT OR IGNORE INTO relation_names VALUES ('depends_on','DAG ordering (task→task, playbook→playbook)');
INSERT OR IGNORE INTO relation_names VALUES ('documents','Describes (doc→task, doc→rule, doc→playbook)');
INSERT OR IGNORE INTO relation_names VALUES ('blocks','Blocking relationship (task→task, or an active Discussion doc→task)');
INSERT OR IGNORE INTO relation_names VALUES ('supersedes','Replaces (doc→doc, rule→rule)');
INSERT OR IGNORE INTO relation_names VALUES ('relates_to','Catch-all (any→any)');
INSERT OR IGNORE INTO relation_names VALUES ('gates','This rule gates that task (rule→task)');
INSERT OR IGNORE INTO relation_names VALUES ('triggers','This playbook run applies to that work (playbook→task)');
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
 * definition is detected rather than silently trusted.
 */
export interface ModuleMigrationRow {
	readonly moduleId: string;
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly appliedAt: string;
}

/**
 * "core"'s ledger history. Each entry's checksum is a FROZEN, hardcoded literal, computed
 * once at the moment that version was introduced and embedded here permanently -- never
 * recomputed from the live, evolving SCHEMA/SEED_SQL constants. That distinction is the
 * entire point: an earlier version of this file computed the checksum from the current
 * SCHEMA text every time, which meant "core version 1" silently redefined itself every
 * time SCHEMA grew, and would have thrown a checksum-mismatch error against every
 * database that had already recorded the OLDER value -- including a real, already-
 * deployed production database. Only the LAST entry's DDL actually runs (SCHEMA+SEED_SQL,
 * the full current shape) for a truly fresh database; every earlier entry is pure
 * historical bookkeeping, backfilled alongside it without being replayed, so a new
 * database is not forced to pass through migrations it never structurally needed. A
 * database that already recorded an earlier version keeps that exact checksum forever;
 * adding schema later means appending a new entry here, never editing an existing one.
 */
const CORE_LEDGER_VERSIONS: ReadonlyArray<{ version: number; name: string; checksum: string }> = [
	{ version: 1, name: "baseline", checksum: "af81e9f51d915ba538af3f468dc044bda5e2c5a5f5037e9c7c01540f87288763" },
	{ version: 2, name: "docs-rules-skills-project-scope", checksum: "8b16d8f631ad628f4799ff09b1ebe8be28343e4f677d52bf2a39a8bedc19e64e" },
	{ version: 3, name: "log-domain", checksum: "c87f43c22b2608619ada9a529d7899ae74b7f38cd554135c8034116fc96e1eff" },
	{ version: 4, name: "remove-discourse", checksum: "b923f41c44460f0aaeb2f4e60e28f8b8e1425d03f527955bd991434b46de4c82" },
	{ version: 5, name: "session-identity", checksum: "1c6a165bbe37f82a100fd34762db70c3f8ab15ff20c3a53c2e60448edc815a5e" },
	{ version: 6, name: "artifact-trash", checksum: "4a75dbec2892deb54bcc1afdf0d51d81f03a8d10861787d083784a29e5c7e8f9" },
	{ version: 7, name: "discuss-native", checksum: "ab7bdd04824bd93681917807b817d6e08b9825af90161e3ccd6d6663021dc6a0" },
	{ version: 8, name: "discuss-options", checksum: "ba1fc5ab7cfe9166d71cc1842f13bc32a0905d08696006cec202196a70c832e8" },
];

export function migrationLedger(db: Db): ModuleMigrationRow[] {
	// A database that has never reached current schema (still awaiting explicit migrateDb())
	// has no ledger table yet -- "nothing recorded" is the correct answer, not an error.
	const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'module_migrations'").get() != null;
	if (!tableExists) return [];
	const rows = db
		.prepare("SELECT module_id, version, name, checksum, applied_at FROM module_migrations ORDER BY module_id, version")
		.all() as Array<{
		module_id: string;
		version: number;
		name: string;
		checksum: string;
		applied_at: string;
	}>;
	return rows.map((row) => ({
		moduleId: row.module_id,
		version: row.version,
		name: row.name,
		checksum: row.checksum,
		appliedAt: row.applied_at,
	}));
}

/**
 * Ensures the ledger correctly reflects every entry in CORE_LEDGER_VERSIONS once a
 * database is confirmed at the full current schema, however it got there: a truly empty
 * database runs the current bootstrap DDL once (for the last/current entry only) and
 * backfills every entry as historical bookkeeping; a database that already reached
 * current shape (a fresh bootstrap from a past release, or a full upgrade through the
 * pre-ledger sequential migrateDb() chain below) is backfilled without re-running any DDL
 * against data that already exists. Verifies every already-recorded entry's stored
 * checksum on every open so a since-edited definition is caught, not silently trusted --
 * and because each entry's checksum is frozen at introduction (see the constant's own
 * comment), an already-recorded entry can never spuriously mismatch just because a later
 * entry was appended.
 */
function ensureCoreLedger(db: Db, alreadyAtCurrentSchema: boolean): void {
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
	inTransaction(db, () => {
		for (const [index, entry] of CORE_LEDGER_VERSIONS.entries()) {
			const existingRow = db
				.prepare("SELECT checksum FROM module_migrations WHERE module_id = 'core' AND version = ?")
				.get(entry.version) as { checksum: string } | null;
			if (existingRow != null) {
				if (existingRow.checksum !== entry.checksum) {
					throw new Error(
						`module migration "core" version ${entry.version} checksum mismatch: the frozen definition for this version was edited after it was applied`,
					);
				}
				continue;
			}
			const isLast = index === CORE_LEDGER_VERSIONS.length - 1;
			if (isLast && !alreadyAtCurrentSchema) {
				db.exec(SCHEMA);
				db.exec(SEED_SQL);
				db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
			}
			db.prepare("INSERT INTO module_migrations (module_id, version, name, checksum, applied_at) VALUES ('core', ?, ?, ?, ?)").run(
				entry.version,
				entry.name,
				entry.checksum,
				new Date().toISOString(),
			);
		}
	});
}

function bootstrapEmptyDatabase(db: Db): void {
	const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
	if (existing) throw new Error("database schema is unversioned; refusing to migrate existing data during boot");
	ensureCoreLedger(db, false);
}

/**
 * Version the hardcoded, sequential if-chain below produces once fully applied. Frozen
 * forever, per this same function's own "deliberately not a hand-enumerated allow-list"
 * history below: that chain is never edited once shipped, only ever extended with a new
 * `if` branch -- except a NEW branch is no longer how migrations beyond this version are
 * added (see FUTURE_MIGRATIONS). The legacy chain itself stays byte-for-byte as it always
 * was: same SQL, same single all-or-nothing transaction, same dynamic post-hoc gap check.
 */
const LEGACY_MIGRATION_CHAIN_TARGET_VERSION = 13;

/**
 * A migration beyond LEGACY_MIGRATION_CHAIN_TARGET_VERSION. Runs through @danypops/
 * vehicle-server's generic runMigrations engine (one transaction per migration, its
 * default) via dbMigrationRunner below, instead of a new branch appended to the legacy
 * if-chain -- the exact reuse the storage module was refactored (originally daemon-kit
 * v0.2.1, now absorbed into vehicle-server) to allow,
 * since Papyrus's dual bun:sqlite/node:sqlite Db abstraction could never satisfy that
 * engine's original bun:sqlite-only signature.
 */
export interface PapyrusMigration {
	version: number;
	name: string;
	up: (db: Db) => void;
}

const FUTURE_MIGRATIONS: ReadonlyArray<PapyrusMigration> = [
	{
		version: 14,
		name: "artifact-trash",
		// See domain/artifact-trash.ts for the full design rationale. The two trigger bodies here
		// must match SCHEMA's fresh-bootstrap versions of the same triggers byte-for-byte -- DROP
		// then CREATE is required since SQLite has no ALTER TRIGGER.
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS artifact_trash (
					artifact_id  TEXT PRIMARY KEY REFERENCES artifacts(id),
					trashed_at   TEXT NOT NULL,
					purge_after  TEXT NOT NULL,
					reason       TEXT
				);
				CREATE INDEX IF NOT EXISTS artifact_trash_purge_idx ON artifact_trash(purge_after);
				DROP TRIGGER IF EXISTS task_events_no_delete;
				CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
				WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.task_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				BEGIN SELECT RAISE(ABORT, 'task_events are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
				DROP TRIGGER IF EXISTS artifact_events_no_delete;
				CREATE TRIGGER artifact_events_no_delete BEFORE DELETE ON artifact_events
				WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.artifact_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				BEGIN SELECT RAISE(ABORT, 'artifact_events are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
			`);
		},
	},
	{
		version: 15,
		name: "discuss-native",
		// See domain/discussion.ts. discussion_rounds mirrors task_events' proven shape (append-only,
		// with the identical trash-purge trigger carve-out); the blocks relation's description is
		// widened to reflect that an active Discussion doc can now block a task too.
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS discussion_rounds (
					id            INTEGER PRIMARY KEY AUTOINCREMENT,
					discussion_id TEXT NOT NULL REFERENCES artifacts(id),
					round_number  INTEGER NOT NULL,
					actor         TEXT NOT NULL,
					content       TEXT NOT NULL,
					occurred_at   TEXT NOT NULL,
					event_schema_version INTEGER NOT NULL DEFAULT 1,
					UNIQUE (discussion_id, round_number)
				);
				CREATE INDEX IF NOT EXISTS discussion_rounds_discussion_idx ON discussion_rounds(discussion_id, round_number, id);
				CREATE TRIGGER IF NOT EXISTS discussion_rounds_no_update BEFORE UPDATE ON discussion_rounds
				BEGIN SELECT RAISE(ABORT, 'discussion_rounds are append-only'); END;
				CREATE TRIGGER IF NOT EXISTS discussion_rounds_no_delete BEFORE DELETE ON discussion_rounds
				WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.discussion_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				BEGIN SELECT RAISE(ABORT, 'discussion_rounds are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
				UPDATE relation_names SET description = 'Blocking relationship (task→task, or an active Discussion doc→task)' WHERE name = 'blocks';
			`);
		},
	},
	{
		version: 16,
		name: "discuss-options",
		// See domain/discussion.ts. Nullable, purely additive columns: a round with no posed choice
		// (the overwhelming majority, before this feature existed) simply stores NULL in all three.
		// Guarded per-column (SQLite has no `ADD COLUMN IF NOT EXISTS`): a fixture that bootstraps
		// from the CURRENT SCHEMA text (which already declares these columns) and then only fakes an
		// older user_version to exercise this migration path must not fail with "duplicate column
		// name" -- the same class of already-bootstrapped-fixture concern version 9's comment covers.
		up: (db) => {
			const existing = new Set(
				(db.prepare("PRAGMA table_info(discussion_rounds)").all() as Array<{ name: string }>).map((row) => row.name),
			);
			for (const column of ["options", "options_mode", "selected"]) {
				if (!existing.has(column)) db.exec(`ALTER TABLE discussion_rounds ADD COLUMN ${column} TEXT`);
			}
		},
	},
	{
		version: 17,
		name: "discussion-task-kind",
		// See domain/discussion.ts for why. Status remaps the same loosely-followed way the
		// doc column always worked: active/deferred -> in-progress, archived -> done.
		up: (db) => {
			db.exec(`
				UPDATE artifacts SET kind = 'task', status = CASE status
					WHEN 'archived' THEN 'done'
					ELSE 'in-progress' END
				WHERE kind = 'doc' AND subtype = 'discussion';
			`);
		},
	},
	{
		version: 18,
		name: "playbook-kind",
		// Playbooks (trigger/steps/tools guidance an agent reads and follows) were a subtype-less
		// shape squeezed into the "skill" kind alongside artifact-templates and workflow blueprints
		// -- fundamentally different mechanisms (mechanical multi-artifact instantiation) from a flat
		// step list. Split into its own kind; only rows with no subtype move -- artifact-template and
		// workflow rows stay exactly where they are.
		up: (db) => {
			db.exec(`
				INSERT OR IGNORE INTO kinds VALUES ('playbook','Reusable procedure — a trigger and an ordered list of steps an agent reads and follows, not a mechanically instantiated blueprint');
				INSERT OR IGNORE INTO statuses VALUES ('active','playbook');
				INSERT OR IGNORE INTO statuses VALUES ('deprecated','playbook');
				UPDATE artifacts SET kind = 'playbook' WHERE kind = 'skill' AND (subtype IS NULL OR subtype = '');
			`);
		},
	},
	{
		version: 19,
		name: "discuss-option-descriptions",
		// See domain/discussion.ts's pendingOptionDescriptions. Nullable, purely additive column, same
		// pattern as version 16's discuss-options -- a round with no per-option description (every
		// round before this feature existed, and any that simply doesn't need one) stores NULL.
		up: (db) => {
			const existing = new Set(
				(db.prepare("PRAGMA table_info(discussion_rounds)").all() as Array<{ name: string }>).map((row) => row.name),
			);
			if (!existing.has("option_descriptions")) db.exec("ALTER TABLE discussion_rounds ADD COLUMN option_descriptions TEXT");
		},
	},
	{
		version: 20,
		name: "task-leases",
		// See domain/task-lease.ts. One row per task (a task has at most one live lease at a time),
		// same PRIMARY KEY-per-task shape as task_focus -- but a lease is deliberately orthogonal to
		// Focus (multiple sessions can focus the same task; only one owner can hold its lease).
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS task_leases (
					task_id           TEXT PRIMARY KEY REFERENCES artifacts(id),
					owner             TEXT NOT NULL,
					token             TEXT NOT NULL,
					claimed_at        TEXT NOT NULL,
					lease_expires_at  TEXT NOT NULL,
					heartbeat_at      TEXT,
					note              TEXT
				);
				CREATE INDEX IF NOT EXISTS task_leases_expiry_idx ON task_leases(lease_expires_at);
			`);
		},
	},
	{
		version: 21,
		name: "note-events",
		// See domain/note-event.ts. Retires extra.noteHistory (a bounded array inside a mutable
		// JSON field, which a later setExtra from a concurrent operation could silently overwrite)
		// in favor of a real append-only table, mirroring task_events' already-proven shape.
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS note_events (
					id                   INTEGER PRIMARY KEY AUTOINCREMENT,
					note_id              TEXT NOT NULL REFERENCES artifacts(id),
					occurred_at          TEXT NOT NULL,
					event_type           TEXT NOT NULL,
					actor                TEXT NOT NULL,
					source               TEXT NOT NULL,
					session_id           TEXT,
					reason               TEXT,
					related_id           TEXT,
					disposition          TEXT,
					event_schema_version INTEGER NOT NULL DEFAULT 1
				);
				CREATE INDEX IF NOT EXISTS note_events_history_idx ON note_events(note_id, occurred_at, id);
				CREATE TRIGGER IF NOT EXISTS note_events_no_update BEFORE UPDATE ON note_events
				BEGIN SELECT RAISE(ABORT, 'note_events are append-only'); END;
				CREATE TRIGGER IF NOT EXISTS note_events_no_delete BEFORE DELETE ON note_events
				WHEN NOT EXISTS (SELECT 1 FROM artifact_trash WHERE artifact_id = OLD.note_id AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				BEGIN SELECT RAISE(ABORT, 'note_events are append-only except during an explicit, elapsed-grace-period artifact trash purge'); END;
			`);
			const rows = db.prepare("SELECT id, extra FROM artifacts WHERE kind = 'doc' AND subtype = 'note'").all() as Array<{
				id: string;
				extra: string;
			}>;
			const insert = db.prepare(`
				INSERT INTO note_events (note_id, occurred_at, event_type, actor, source, session_id, reason, related_id, disposition, event_schema_version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			`);
			const strip = db.prepare("UPDATE artifacts SET extra = ? WHERE id = ?");
			for (const row of rows) {
				const extra = JSON.parse(row.extra) as Record<string, unknown>;
				const noteHistory = extra.noteHistory;
				if (Array.isArray(noteHistory)) {
					for (const raw of noteHistory) {
						const entry = raw as Record<string, unknown>;
						insert.run(
							row.id,
							typeof entry.at === "string" ? entry.at : new Date().toISOString(),
							typeof entry.action === "string" ? entry.action : "captured",
							typeof entry.actor === "string" ? entry.actor : "system",
							typeof entry.source === "string" ? entry.source : "unknown",
							typeof entry.sessionId === "string" ? entry.sessionId : null,
							typeof entry.reason === "string" ? entry.reason : null,
							typeof entry.targetId === "string" ? entry.targetId : null,
							typeof entry.disposition === "string" ? entry.disposition : null,
						);
					}
				}
				if ("noteHistory" in extra) {
					const { noteHistory: _drop, ...rest } = extra;
					strip.run(JSON.stringify(rest), row.id);
				}
			}
		},
	},
	{
		version: 22,
		name: "skill-to-playbook-data-migration",
		// Part of the Skill→Playbook consolidation. Migration 18 already moved subtype-less Skill
		// rows to kind=playbook; this moves everything still left under kind=skill (workflow and
		// artifact-template rows alike, plus any bare stragglers), preserving subtype and status so
		// a later task can still tell which authoring shape each migrated row came from. The
		// 'skill'/'artifact-template' kinds/statuses type rows themselves are deliberately NOT
		// dropped here: src/modules/skills.ts's createSkill (and the CLI/Vehicle/TUI surfaces still
		// wired to it) still writes kind='skill' rows in its own live, not-yet-retired test suite --
		// dropping the kinds row now would break that FK-enforced write path before its own
		// retirement task removes it. Dropping the type rows is that later task's job.
		up: (db) => {
			db.exec(`UPDATE artifacts SET kind = 'playbook' WHERE kind = 'skill'`);
		},
	},
	{
		version: 23,
		name: "retire-skill-kind",
		// Final step of the Skill→Playbook consolidation. Every module/CLI/Vehicle/TUI surface
		// that wrote kind='skill' is now retired (confirmed live: zero real callers anywhere), and
		// migration 22 already moved every existing row off kind=skill. The type rows themselves
		// are now genuinely dead -- safe to drop.
		up: (db) => {
			db.exec(`
				DELETE FROM statuses WHERE kind = 'skill';
				DELETE FROM kinds WHERE name = 'skill';
			`);
		},
	},
	{
		version: 24,
		name: "artifact-aliases",
		// See domain/artifact-alias.ts. A real column + unique index, backfilled here rather than
		// computed lazily on read -- IF NOT EXISTS/guarded column add throughout since a fixture
		// that bootstraps from the current SCHEMA text (which already declares alias) and then only
		// fakes an older user_version to exercise this migration path must not fail with "duplicate
		// column name", the same class of concern version 16's comment covers.
		up: (db) => {
			const existing = new Set((db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).map((row) => row.name));
			if (!existing.has("alias")) db.exec("ALTER TABLE artifacts ADD COLUMN alias TEXT");
			const rows = db.prepare("SELECT id, title FROM artifacts WHERE alias IS NULL ORDER BY created_at, id").all() as Array<{
				id: string;
				title: string;
			}>;
			const taken = new Set(
				(db.prepare("SELECT alias FROM artifacts WHERE alias IS NOT NULL").all() as Array<{ alias: string }>).map((row) => row.alias),
			);
			const update = db.prepare("UPDATE artifacts SET alias = ? WHERE id = ?");
			for (const row of rows) {
				const alias = generateUniqueAlias(slugify(row.title), (candidate) => taken.has(candidate));
				taken.add(alias);
				update.run(alias, row.id);
			}
			db.exec("CREATE UNIQUE INDEX IF NOT EXISTS artifacts_alias_idx ON artifacts(alias)");
		},
	},
	{
		version: 25,
		name: "rule-draft-status",
		up: (db) => {
			db.exec("INSERT OR IGNORE INTO statuses SELECT 'draft','rule' WHERE EXISTS (SELECT 1 FROM kinds WHERE name = 'rule')");
		},
	},
	{
		version: 26,
		name: "task-projects-and-create-idempotency",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS task_projects (
					id            TEXT PRIMARY KEY,
					name          TEXT NOT NULL,
					aliases_json  TEXT NOT NULL DEFAULT '[]',
					project_root  TEXT NOT NULL UNIQUE,
					created_at    TEXT NOT NULL,
					updated_at    TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS task_projects_name_idx ON task_projects(name);
				CREATE TABLE IF NOT EXISTS task_create_requests (
					request_scope   TEXT NOT NULL,
					idempotency_key TEXT NOT NULL,
					request_hash    TEXT NOT NULL,
					response_json   TEXT NOT NULL,
					created_at      TEXT NOT NULL,
					expires_at      TEXT NOT NULL,
					PRIMARY KEY (request_scope, idempotency_key)
				);
				CREATE INDEX IF NOT EXISTS task_create_requests_expiry_idx ON task_create_requests(expires_at);
			`);
			const roots = db
				.prepare("SELECT DISTINCT project_root FROM task_scopes WHERE project_root IS NOT NULL ORDER BY project_root")
				.all() as Array<{
				project_root: string;
			}>;
			const insert = db.prepare(
				"INSERT OR IGNORE INTO task_projects (id, name, aliases_json, project_root, created_at, updated_at) VALUES (?, ?, '[]', ?, ?, ?)",
			);
			for (const row of roots) {
				const now = new Date().toISOString();
				insert.run(randomUUID(), basename(row.project_root) || row.project_root, row.project_root, now, now);
			}
		},
	},
	{
		version: 27,
		name: "task-lifecycle-mutation-receipts",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS task_mutation_requests (
					request_scope   TEXT NOT NULL,
					idempotency_key TEXT NOT NULL,
					receipt_id      TEXT NOT NULL UNIQUE,
					task_id         TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
					operation       TEXT NOT NULL,
					request_hash    TEXT NOT NULL,
					state           TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
					response_json   TEXT,
					created_at      TEXT NOT NULL,
					updated_at      TEXT NOT NULL,
					expires_at      TEXT NOT NULL,
					PRIMARY KEY (request_scope, idempotency_key),
					CHECK ((state = 'pending' AND response_json IS NULL) OR (state = 'completed' AND response_json IS NOT NULL))
				);
				CREATE INDEX IF NOT EXISTS task_mutation_requests_expiry_idx ON task_mutation_requests(expires_at);
				CREATE UNIQUE INDEX IF NOT EXISTS task_mutation_requests_pending_task_operation_idx
					ON task_mutation_requests(task_id, operation) WHERE state = 'pending' AND task_id IS NOT NULL;
			`);
		},
	},
	{
		version: 28,
		name: "artifact-multi-project-scope",
		// See artifact/artifact-scope-store.ts. Replaces the single-project_root shape with an
		// explicit global/projects mode plus a bounded, non-empty many-to-many membership table,
		// keyed by the same registered project ids Tasks already use (task_projects, see version 26)
		// rather than a raw root string -- so a project rename/move never needs a best-effort
		// string rewrite across every artifact scoped to it. Preserves every row: NULL project_root
		// becomes explicit global mode (the column's own new DEFAULT already covers a fresh
		// bootstrap; this branch back-fills it for an upgrading database); a non-NULL project_root
		// becomes projects mode with exactly one membership, registering that root in task_projects
		// first if no Task ever used it either.
		up: (db) => {
			const existing = new Set((db.prepare("PRAGMA table_info(artifact_scopes)").all() as Array<{ name: string }>).map((row) => row.name));
			// True only when migrating a genuinely pre-v28 database. A fixture that bootstraps from
			// the CURRENT SCHEMA text (which already declares this column, in whatever its own current
			// CHECK vocabulary is -- version 29 later widens/renames it from 'global'/'projects' to
			// 'none'/'all'/'explicit') and then only fakes an older user_version to exercise an earlier
			// migration's own path already has the column; forcing this migration's literal 'projects'
			// value into it would violate version 29's tighter CHECK once that has shipped. The
			// membership-table backfill below still always runs regardless (idempotent, and never
			// touches the CHECK-restricted mode column itself) -- version 29's own remap pass detects
			// "has a membership row" directly rather than trusting this flag's own mode literal, so a
			// fixture that skips this exact write still ends up in the correct final 'explicit' state.
			const columnPreexisted = existing.has("mode");
			if (!columnPreexisted) {
				db.exec("ALTER TABLE artifact_scopes ADD COLUMN mode TEXT NOT NULL DEFAULT 'global' CHECK (mode IN ('global', 'projects'))");
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS artifact_scope_projects (
					artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
					project_id   TEXT NOT NULL REFERENCES task_projects(id),
					PRIMARY KEY (artifact_id, project_id)
				);
				CREATE INDEX IF NOT EXISTS artifact_scope_projects_project_idx ON artifact_scope_projects(project_id, artifact_id);
			`);
			const scoped = db.prepare("SELECT artifact_id, project_root FROM artifact_scopes WHERE project_root IS NOT NULL").all() as Array<{
				artifact_id: string;
				project_root: string;
			}>;
			const findProject = db.prepare("SELECT id FROM task_projects WHERE project_root = ?");
			const insertProject = db.prepare(
				"INSERT INTO task_projects (id, name, aliases_json, project_root, created_at, updated_at) VALUES (?, ?, '[]', ?, ?, ?)",
			);
			const setProjectsMode = db.prepare("UPDATE artifact_scopes SET mode = 'projects' WHERE artifact_id = ?");
			const insertMembership = db.prepare("INSERT OR IGNORE INTO artifact_scope_projects (artifact_id, project_id) VALUES (?, ?)");
			for (const row of scoped) {
				const found = findProject.get(row.project_root) as { id: string } | null;
				let projectId = found?.id;
				if (!projectId) {
					projectId = randomUUID();
					const now = new Date().toISOString();
					insertProject.run(projectId, basename(row.project_root) || row.project_root, row.project_root, now, now);
				}
				if (!columnPreexisted) setProjectsMode.run(row.artifact_id);
				insertMembership.run(row.artifact_id, projectId);
			}
		},
	},
	{
		version: 29,
		name: "artifact-scope-tri-state-and-scope-groups",
		// See scope-group/. Adds the nested-scope-group registry (scope_groups/scope_group_members),
		// and replaces artifact_scopes' two-state mode ('global'|'projects') with a real three-state
		// one ('none'|'all'|'explicit') -- 'none' (fully hidden, never applicable) did not exist
		// before this. SQLite has no ALTER TABLE ... CHECK, so artifact_scopes is rebuilt (copy with
		// remapped mode values, drop, rename) rather than altered in place; every row's own
		// artifact_id/project_root/source/assigned_at is preserved byte-for-byte, only `mode`'s
		// values change (global->all, projects->explicit) and its CHECK constraint widens.
		// artifact_scope_projects is folded into the new, kind-neutral artifact_scope_members
		// (adding member_type so a membership row can name a project OR a scope group) --
		// existing project memberships become member_type='project' rows, unchanged in meaning.
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS scope_groups (
					id            TEXT PRIMARY KEY,
					name          TEXT NOT NULL,
					aliases_json  TEXT NOT NULL DEFAULT '[]',
					created_at    TEXT NOT NULL,
					updated_at    TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS scope_groups_name_idx ON scope_groups(name);
				CREATE TABLE IF NOT EXISTS scope_group_members (
					group_id     TEXT NOT NULL REFERENCES scope_groups(id) ON DELETE CASCADE,
					member_type  TEXT NOT NULL CHECK (member_type IN ('project', 'group')),
					member_id    TEXT NOT NULL,
					PRIMARY KEY (group_id, member_type, member_id)
				);
				CREATE INDEX IF NOT EXISTS scope_group_members_group_idx ON scope_group_members(group_id);
				CREATE INDEX IF NOT EXISTS scope_group_members_member_idx ON scope_group_members(member_type, member_id);
			`);
			// Guarded by whether the OLD artifact_scope_projects table still exists, the same class of
			// concern version 16's/note-events' own comments cover: a fixture that bootstraps from the
			// CURRENT SCHEMA text (which already declares artifact_scopes/artifact_scope_members in
			// their POST-this-migration shape) and then only fakes an older user_version to exercise an
			// earlier migration's own path must not attempt to rebuild a table that's already correctly
			// shaped -- rebuilding it again with a CASE mode remap over already-new mode values ('all'/
			// 'explicit') would violate the new CHECK, since those aren't 'global'/'projects' either.
			const oldTableExists =
				db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifact_scope_projects'").get() != null;
			if (!oldTableExists) return;
			db.exec(`
				CREATE TABLE artifact_scopes_v29 (
					artifact_id   TEXT PRIMARY KEY REFERENCES artifacts(id),
					project_root  TEXT,
					mode          TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('none', 'all', 'explicit')),
					source        TEXT NOT NULL CHECK (source IN ('cwd', 'explicit', 'unscoped')),
					assigned_at   TEXT NOT NULL
				);
				-- Keyed off real membership-row existence, not the old mode literal: v28's own write of
				-- that literal is itself conditionally skipped (see its own comment) when replaying
				-- against a fixture that already has this column in a later, tightened CHECK shape --
				-- membership rows are still always backfilled unconditionally either way, so checking
				-- for one directly is correct in every case, historical or fixture-simulated alike.
				INSERT INTO artifact_scopes_v29 (artifact_id, project_root, mode, source, assigned_at)
					SELECT s.artifact_id, s.project_root,
						CASE
							WHEN EXISTS (SELECT 1 FROM artifact_scope_projects p WHERE p.artifact_id = s.artifact_id) THEN 'explicit'
							WHEN s.mode = 'global' THEN 'all'
							WHEN s.mode = 'projects' THEN 'explicit'
							ELSE s.mode
						END,
						s.source, s.assigned_at
					FROM artifact_scopes s;
				DROP TABLE artifact_scopes;
				ALTER TABLE artifact_scopes_v29 RENAME TO artifact_scopes;
				CREATE INDEX IF NOT EXISTS artifact_scopes_project_idx ON artifact_scopes(project_root, artifact_id);

				CREATE TABLE IF NOT EXISTS artifact_scope_members (
					artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
					member_type  TEXT NOT NULL CHECK (member_type IN ('project', 'group')),
					member_id    TEXT NOT NULL,
					PRIMARY KEY (artifact_id, member_type, member_id)
				);
				INSERT INTO artifact_scope_members (artifact_id, member_type, member_id)
					SELECT artifact_id, 'project', project_id FROM artifact_scope_projects;
				DROP TABLE artifact_scope_projects;
				CREATE INDEX IF NOT EXISTS artifact_scope_members_member_idx ON artifact_scope_members(member_type, member_id, artifact_id);
			`);
		},
	},
	{
		version: 30,
		name: "discuss-quiz",
		// See domain/discussion.ts. Nullable, purely additive columns, same pattern as version 16/19's
		// own discuss-options/discuss-option-descriptions migrations -- a round with no quiz (the
		// overwhelming majority) simply stores NULL in all six. quiz_correct_options/quiz_explanation
		// are the hidden answer (a posing round) -- deliberately never selected by discussion_rounds'
		// general-purpose read queries, only by SQLiteDiscussionRoundStore's own dedicated
		// resolvePendingQuizAnswer. quiz_result_* is the graded outcome (an answering round, safe to
		// read generally since it only exists after submission). Guarded per-column (SQLite has no
		// `ADD COLUMN IF NOT EXISTS`), the same already-bootstrapped-fixture concern version 9's comment
		// covers.
		up: (db) => {
			const existing = new Set(
				(db.prepare("PRAGMA table_info(discussion_rounds)").all() as Array<{ name: string }>).map((row) => row.name),
			);
			const columns = [
				["quiz", "INTEGER"],
				["quiz_correct_options", "TEXT"],
				["quiz_explanation", "TEXT"],
				["quiz_result_correct", "INTEGER"],
				["quiz_result_correct_options", "TEXT"],
				["quiz_result_explanation", "TEXT"],
			] as const;
			for (const [column, type] of columns) {
				if (!existing.has(column)) db.exec(`ALTER TABLE discussion_rounds ADD COLUMN ${column} ${type}`);
			}
		},
	},
];

/**
 * Adapts Papyrus's own Db/inTransaction to vehicle-server's storage-agnostic
 * SqliteMigrationRunner port, so its runMigrations engine (written against bun:sqlite's
 * concrete Database) runs unmodified against Papyrus's dual-runtime Db abstraction instead.
 */
export function dbMigrationRunner(db: Db): SqliteMigrationRunner<Db> {
	return {
		raw: db,
		userVersion: () => schemaVersion(db),
		setUserVersion: (version) => db.exec(`PRAGMA user_version = ${version}`),
		transaction: (fn) => inTransaction(db, fn),
	};
}

export function migrateDb(db: Db): MigrationResult {
	const from = schemaVersion(db);
	if (from > SQLITE_SCHEMA_VERSION) {
		throw new Error(`database schema ${from} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (from === SQLITE_SCHEMA_VERSION) return { from, to: from, applied: [] };
	if (from < 1) throw new Error(`no explicit migration path from database schema ${from}`);
	const applied: string[] = [];

	// Deliberately NOT a hand-enumerated allow-list of valid `from` values (e.g. "from !== 1 &&
	// ... && from !== 7"): a real, latent bug was found here while adding the v10->v11 step --
	// that enumeration was never extended when the v8->v9 and v9->v10 steps were added, so
	// migrating any already-deployed database sitting at schema 8, 9, or 10 (including the real
	// production database at the time this was found) would have thrown "no explicit migration
	// path" before ever reaching the migration chain below. Checked dynamically after the chain
	// runs instead: if schemaVersion(db) hasn't reached LEGACY_MIGRATION_CHAIN_TARGET_VERSION once
	// every `schemaVersion(db) === N` step below has had its chance to fire, `from` was never a
	// valid starting point (a genuine gap in the chain) -- structurally cannot drift out of sync
	// the way a separate, parallel enumeration did.
	//
	// Guarded by `from < LEGACY_MIGRATION_CHAIN_TARGET_VERSION`: a database already at or past
	// that version (only reachable once FUTURE_MIGRATIONS below has entries) must skip this
	// entire frozen chain, not merely fail to match any of its branches -- entering it and
	// falling through to the final gap check would otherwise misreport a database correctly
	// mid-way through FUTURE_MIGRATIONS as "no explicit migration path".
	if (from < LEGACY_MIGRATION_CHAIN_TARGET_VERSION)
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
			if (schemaVersion(db) === 5) {
				db.exec(`
				INSERT OR IGNORE INTO relation_names VALUES ('reply_to','Append-only message replies to another message in the same thread');
				INSERT OR IGNORE INTO relation_names VALUES ('discusses','Message or turn concerns a verified artifact');
				CREATE TABLE discourse_threads (
					store_id TEXT NOT NULL, forum_id TEXT NOT NULL, topic_id TEXT NOT NULL, thread_id TEXT NOT NULL,
					artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
					PRIMARY KEY (store_id, forum_id, topic_id, thread_id)
				);
				CREATE TABLE discourse_posts (
					store_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL,
					artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id), operation_id TEXT NOT NULL,
					command_json TEXT NOT NULL, forum_id TEXT NOT NULL, topic_id TEXT NOT NULL, thread_id TEXT NOT NULL,
					author_id TEXT NOT NULL, content_json TEXT NOT NULL, timestamp INTEGER NOT NULL,
					correlation_id TEXT, causation_id TEXT, reply_to_post_id TEXT, references_json TEXT NOT NULL,
					question_type TEXT CHECK (question_type IN ('question', 'answer')), response_id TEXT, target_id TEXT,
					PRIMARY KEY (store_id, id), UNIQUE (store_id, operation_id), UNIQUE (store_id, sequence)
				);
				CREATE INDEX discourse_posts_thread_idx ON discourse_posts(store_id, forum_id, topic_id, thread_id, sequence);
				CREATE TABLE discourse_events (
					store_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
					PRIMARY KEY (store_id, sequence)
				);
				CREATE TABLE discourse_cursors (
					store_id TEXT NOT NULL, consumer_id TEXT NOT NULL, sequence INTEGER NOT NULL,
					PRIMARY KEY (store_id, consumer_id)
				);
				CREATE TABLE discourse_projection_cursors (
					store_id TEXT NOT NULL, projection_id TEXT NOT NULL, sequence INTEGER NOT NULL,
					PRIMARY KEY (store_id, projection_id)
				);
				CREATE TRIGGER discourse_threads_artifact_type BEFORE INSERT ON discourse_threads
				WHEN NOT EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND kind = 'doc' AND subtype = 'context-thread')
				BEGIN SELECT RAISE(ABORT, 'discourse thread artifact must be a context-thread Doc'); END;
				CREATE TRIGGER discourse_posts_artifact_type BEFORE INSERT ON discourse_posts
				WHEN NOT EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND kind = 'doc' AND subtype = 'context-message')
				BEGIN SELECT RAISE(ABORT, 'discourse post artifact must be a context-message Doc'); END;
				CREATE TRIGGER discourse_artifact_type_immutable BEFORE UPDATE OF kind, subtype ON artifacts
				WHEN (EXISTS (SELECT 1 FROM discourse_threads WHERE artifact_id = OLD.id) AND (NEW.kind != 'doc' OR NEW.subtype != 'context-thread'))
				  OR (EXISTS (SELECT 1 FROM discourse_posts WHERE artifact_id = OLD.id) AND (NEW.kind != 'doc' OR NEW.subtype != 'context-message'))
				BEGIN SELECT RAISE(ABORT, 'discourse Context Mesh artifact type is immutable'); END;
				PRAGMA user_version = 6;
			`);
				applied.push("discourse-context-mesh");
			}
			if (schemaVersion(db) === 6) {
				db.exec(`
				CREATE TABLE artifact_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					artifact_id TEXT NOT NULL REFERENCES artifacts(id),
					occurred_at TEXT NOT NULL,
					event_type TEXT NOT NULL,
					actor TEXT NOT NULL,
					source TEXT NOT NULL,
					session_id TEXT,
					from_status TEXT,
					to_status TEXT,
					relation TEXT,
					related_id TEXT,
					event_schema_version INTEGER NOT NULL DEFAULT 1
				);
				CREATE INDEX artifact_events_artifact_idx ON artifact_events(artifact_id, occurred_at, id);
				CREATE INDEX artifact_events_related_idx ON artifact_events(related_id, occurred_at, id);
				CREATE INDEX artifact_events_actor_idx ON artifact_events(actor, occurred_at, id);
				CREATE INDEX artifact_events_session_idx ON artifact_events(session_id, occurred_at, id);
				CREATE TRIGGER artifact_events_no_update BEFORE UPDATE ON artifact_events
				BEGIN SELECT RAISE(ABORT, 'artifact_events are append-only'); END;
				CREATE TRIGGER artifact_events_no_delete BEFORE DELETE ON artifact_events
				BEGIN SELECT RAISE(ABORT, 'artifact_events are append-only'); END;
				PRAGMA user_version = 7;
			`);
				applied.push("artifact-event-log");
			}
			if (schemaVersion(db) === 7) {
				db.exec(`
				CREATE TABLE task_focus_v7 (
					scope TEXT PRIMARY KEY,
					task_id TEXT NOT NULL REFERENCES artifacts(id),
					status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
					pause_reason TEXT,
					updated_at TEXT NOT NULL
				);
				INSERT INTO task_focus_v7 SELECT scope, task_id, status, pause_reason, updated_at FROM task_focus;
				DROP TABLE task_focus;
				ALTER TABLE task_focus_v7 RENAME TO task_focus;
				PRAGMA user_version = 8;
			`);
				applied.push("task-focus-session-scope");
			}
			if (schemaVersion(db) === 8) {
				// IF NOT EXISTS here, unlike earlier migration branches: a fully-bootstrapped
				// :memory: fixture (used by unrelated tests that only roll user_version back to
				// simulate an older *file* database) already has every table the current bootstrap
				// DDL declares, this one included -- so this branch must be safe to run whether or
				// not that already happened, not assume a truly-old database created it first.
				db.exec(`
				CREATE TABLE IF NOT EXISTS graph_projection_checkpoints (
					producer_id    TEXT PRIMARY KEY,
					last_sequence  INTEGER NOT NULL,
					last_batch_id  TEXT NOT NULL,
					applied_at     TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS graph_projection_identities (
					producer_id   TEXT NOT NULL,
					external_id   TEXT NOT NULL,
					artifact_id   TEXT NOT NULL REFERENCES artifacts(id),
					PRIMARY KEY (producer_id, external_id)
				);
				CREATE INDEX IF NOT EXISTS graph_projection_identities_artifact_idx ON graph_projection_identities(artifact_id);
				PRAGMA user_version = 9;
			`);
				applied.push("graph-projection-protocol");
			}
			if (schemaVersion(db) === 9) {
				db.exec(`
				CREATE TABLE IF NOT EXISTS artifact_scopes (
					artifact_id   TEXT PRIMARY KEY REFERENCES artifacts(id),
					project_root  TEXT,
					source        TEXT NOT NULL CHECK (source IN ('cwd', 'explicit', 'unscoped')),
					assigned_at   TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS artifact_scopes_project_idx ON artifact_scopes(project_root, artifact_id);
				PRAGMA user_version = 10;
			`);
				applied.push("docs-rules-skills-project-scope");
			}
			if (schemaVersion(db) === 10) {
				db.exec(`
				CREATE TABLE IF NOT EXISTS log_sources (
					id            TEXT PRIMARY KEY,
					label         TEXT NOT NULL,
					project_root  TEXT,
					created_at    TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS log_entries (
					id            TEXT PRIMARY KEY,
					source_id     TEXT NOT NULL REFERENCES log_sources(id),
					occurred_at   TEXT NOT NULL,
					level         TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
					message       TEXT NOT NULL,
					truncated     INTEGER NOT NULL DEFAULT 0,
					fields_json   TEXT NOT NULL DEFAULT '{}',
					operation_id  TEXT NOT NULL,
					session_id    TEXT,
					UNIQUE (source_id, operation_id)
				);
				CREATE INDEX IF NOT EXISTS log_entries_source_idx ON log_entries(source_id, occurred_at, id);
				CREATE TRIGGER IF NOT EXISTS log_entries_no_update BEFORE UPDATE ON log_entries
				BEGIN SELECT RAISE(ABORT, 'log_entries are immutable once written; retention trimming is the only supported deletion path'); END;
				PRAGMA user_version = 11;
			`);
				applied.push("log-domain");
			}
			if (schemaVersion(db) === 11) {
				// Removes Discourse's Papyrus-embedded storage entirely: confirmed zero rows in every
				// discourse_* table and zero Docs carrying the reserved context-thread/context-message
				// subtypes in the real production database before this was written -- Discourse's real
				// home is now the standalone @danypops/discourse package plus host adapters, and
				// Papyrus's own copy never had a single real caller since it was built. IF EXISTS
				// throughout: a database that never actually reached the v5->v6 discourse-context-mesh
				// step in the first place (e.g. a test fixture that starts partway through the chain)
				// must not fail here just because there was nothing to remove.
				db.exec(`
				DROP TRIGGER IF EXISTS discourse_artifact_type_immutable;
				DROP TRIGGER IF EXISTS discourse_posts_artifact_type;
				DROP TRIGGER IF EXISTS discourse_threads_artifact_type;
				DROP INDEX IF EXISTS discourse_posts_thread_idx;
				DROP TABLE IF EXISTS discourse_projection_cursors;
				DROP TABLE IF EXISTS discourse_cursors;
				DROP TABLE IF EXISTS discourse_events;
				DROP TABLE IF EXISTS discourse_posts;
				DROP TABLE IF EXISTS discourse_threads;
				DELETE FROM relation_names WHERE name IN ('reply_to', 'discusses');
				PRAGMA user_version = 12;
			`);
				applied.push("remove-discourse");
			}
			if (schemaVersion(db) === 12) {
				// See domain/session-identity.ts and verify-caller-identity-behind-papyrus-mutation-
				// attribution-koxt: first-touch capability binding for session_id, the one place it is
				// behavior-affecting today (Task Focus). Purely additive -- a session_id that never
				// registers here behaves exactly as before.
				db.exec(`
				CREATE TABLE IF NOT EXISTS session_identities (
					session_id    TEXT PRIMARY KEY,
					secret_hash   TEXT NOT NULL,
					registered_at TEXT NOT NULL,
					last_seen_at  TEXT NOT NULL
				);
				PRAGMA user_version = 13;
			`);
				applied.push("session-identity");
			}
			if (schemaVersion(db) !== LEGACY_MIGRATION_CHAIN_TARGET_VERSION)
				throw new Error(`no explicit migration path from database schema ${from}`);
		});

	// Guarded by length: runMigrations treats an empty migrations array's "target version" as
	// 0 (see its own sorted.at(-1) ?? 0), which would misreport a database the legacy chain
	// already advanced past 0 as a downgrade. FUTURE_MIGRATIONS is empty only when there is
	// nothing beyond LEGACY_MIGRATION_CHAIN_TARGET_VERSION to apply -- exactly the case where
	// skipping the call is correct, not merely convenient.
	if (FUTURE_MIGRATIONS.length > 0) {
		const beforeFuture = schemaVersion(db);
		runMigrations(dbMigrationRunner(db), [...FUTURE_MIGRATIONS]);
		const afterFuture = schemaVersion(db);
		for (const migration of FUTURE_MIGRATIONS) {
			if (migration.version > beforeFuture && migration.version <= afterFuture) applied.push(migration.name);
		}
	}

	if (schemaVersion(db) !== SQLITE_SCHEMA_VERSION) throw new Error(`no explicit migration path from database schema ${from}`);
	ensureCoreLedger(db, true);
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
	else if (current === SQLITE_SCHEMA_VERSION) ensureCoreLedger(db, true);
	db.exec("PRAGMA optimize=0x10002");
	return db;
}
