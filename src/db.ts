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

export function inTransaction<T>(db: Db, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
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
`;

const SEED_SQL = `
INSERT OR IGNORE INTO kinds VALUES ('doc','Knowledge — what we know (specs, decisions, research, designs)');
INSERT OR IGNORE INTO kinds VALUES ('task','Work — what we are doing (goals, steps, checklists)');
INSERT OR IGNORE INTO kinds VALUES ('rule','Governance — when doing X, follow Y');
INSERT OR IGNORE INTO kinds VALUES ('skill','Parameterized workflow bundle — inputs and templates load tasks, rules, and docs');
INSERT OR IGNORE INTO statuses VALUES ('draft','doc');
INSERT OR IGNORE INTO statuses VALUES ('active','doc');
INSERT OR IGNORE INTO statuses VALUES ('archived','doc');
INSERT OR IGNORE INTO statuses VALUES ('pending','task');
INSERT OR IGNORE INTO statuses VALUES ('active','task');
INSERT OR IGNORE INTO statuses VALUES ('done','task');
INSERT OR IGNORE INTO statuses VALUES ('failed','task');
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

function migrate(db: Db): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
	let version = row.user_version;
	if (version > SQLITE_SCHEMA_VERSION) {
		throw new Error(`database schema ${version} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (version < 1) {
		inTransaction(db, () => {
			db.exec(SCHEMA);
			db.exec(SEED_SQL);
			db.exec("PRAGMA user_version = 1");
		});
		version = 1;
	}
	if (version !== SQLITE_SCHEMA_VERSION) {
		throw new Error(`missing migration from schema ${version} to ${SQLITE_SCHEMA_VERSION}`);
	}
}

export function openDb(path: string): Db {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = IS_BUN ? new DatabaseCtor(path, { create: true }) : new DatabaseCtor(path);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	migrate(db);
	db.exec("PRAGMA optimize=0x10002");
	return db;
}
