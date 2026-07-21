/**
 * db.ts — enforced-schema SQLite store for Papyrus.
 * Dual-runtime: bun:sqlite (Bun) / node:sqlite (Node/pi host).
 * Four kinds (doc/task/rule/skill) are FK-enforced; relations are universal (any→any).
 */
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
CREATE TABLE IF NOT EXISTS discourse_threads (
	store_id      TEXT NOT NULL,
	forum_id      TEXT NOT NULL,
	topic_id      TEXT NOT NULL,
	thread_id     TEXT NOT NULL,
	artifact_id   TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
	PRIMARY KEY (store_id, forum_id, topic_id, thread_id)
);
CREATE TABLE IF NOT EXISTS discourse_posts (
	store_id       TEXT NOT NULL,
	sequence       INTEGER NOT NULL,
	id             TEXT NOT NULL,
	artifact_id    TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
	operation_id   TEXT NOT NULL,
	command_json   TEXT NOT NULL,
	forum_id       TEXT NOT NULL,
	topic_id       TEXT NOT NULL,
	thread_id      TEXT NOT NULL,
	author_id      TEXT NOT NULL,
	content_json   TEXT NOT NULL,
	timestamp      INTEGER NOT NULL,
	correlation_id TEXT,
	causation_id   TEXT,
	reply_to_post_id TEXT,
	references_json TEXT NOT NULL,
	question_type  TEXT CHECK (question_type IN ('question', 'answer')),
	response_id    TEXT,
	target_id      TEXT,
	PRIMARY KEY (store_id, id),
	UNIQUE (store_id, operation_id),
	UNIQUE (store_id, sequence)
);
CREATE INDEX IF NOT EXISTS discourse_posts_thread_idx ON discourse_posts(store_id, forum_id, topic_id, thread_id, sequence);
CREATE TABLE IF NOT EXISTS discourse_events (
	store_id       TEXT NOT NULL,
	sequence       INTEGER NOT NULL,
	event_json     TEXT NOT NULL,
	PRIMARY KEY (store_id, sequence)
);
CREATE TABLE IF NOT EXISTS discourse_cursors (
	store_id       TEXT NOT NULL,
	consumer_id    TEXT NOT NULL,
	sequence       INTEGER NOT NULL,
	PRIMARY KEY (store_id, consumer_id)
);
CREATE TABLE IF NOT EXISTS discourse_projection_cursors (
	store_id       TEXT NOT NULL,
	projection_id  TEXT NOT NULL,
	sequence       INTEGER NOT NULL,
	PRIMARY KEY (store_id, projection_id)
);
CREATE TRIGGER IF NOT EXISTS discourse_threads_artifact_type BEFORE INSERT ON discourse_threads
WHEN NOT EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND kind = 'doc' AND subtype = 'context-thread')
BEGIN SELECT RAISE(ABORT, 'discourse thread artifact must be a context-thread Doc'); END;
CREATE TRIGGER IF NOT EXISTS discourse_posts_artifact_type BEFORE INSERT ON discourse_posts
WHEN NOT EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND kind = 'doc' AND subtype = 'context-message')
BEGIN SELECT RAISE(ABORT, 'discourse post artifact must be a context-message Doc'); END;
CREATE TRIGGER IF NOT EXISTS discourse_artifact_type_immutable BEFORE UPDATE OF kind, subtype ON artifacts
WHEN (EXISTS (SELECT 1 FROM discourse_threads WHERE artifact_id = OLD.id) AND (NEW.kind != 'doc' OR NEW.subtype != 'context-thread'))
  OR (EXISTS (SELECT 1 FROM discourse_posts WHERE artifact_id = OLD.id) AND (NEW.kind != 'doc' OR NEW.subtype != 'context-message'))
BEGIN SELECT RAISE(ABORT, 'discourse Context Mesh artifact type is immutable'); END;
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
BEGIN SELECT RAISE(ABORT, 'artifact_events are append-only'); END;
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
INSERT OR IGNORE INTO relation_names VALUES ('reply_to','Append-only message replies to another message in the same thread');
INSERT OR IGNORE INTO relation_names VALUES ('discusses','Message or turn concerns a verified artifact');
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

function bootstrapEmptyDatabase(db: Db): void {
	const existing = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
		.get();
	if (existing) throw new Error("database schema is unversioned; refusing to migrate existing data during boot");
	inTransaction(db, () => {
		db.exec(SCHEMA);
		db.exec(SEED_SQL);
		db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
	});
}

export function migrateDb(db: Db): MigrationResult {
	const from = schemaVersion(db);
	if (from > SQLITE_SCHEMA_VERSION) {
		throw new Error(`database schema ${from} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (from === SQLITE_SCHEMA_VERSION) return { from, to: from, applied: [] };
	if (from !== 1 && from !== 2 && from !== 3 && from !== 4 && from !== 5 && from !== 6 && from !== 7) throw new Error(`no explicit migration path from database schema ${from}`);
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
	});
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
	db.exec("PRAGMA optimize=0x10002");
	return db;
}
