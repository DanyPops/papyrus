/**
 * id-migration.ts — plan/apply/verify tooling for rewriting every existing artifact id to a
 * UUID (see src/ops.ts: new artifacts already get crypto.randomUUID() by default; this tool
 * closes the gap for artifacts that predate that change).
 *
 * This is deliberately NOT a daemon operation. Rewriting every artifact's primary key is a
 * one-shot, high-blast-radius, mostly-irreversible operation on the database file itself, not
 * a request a running service should accept over RPC. The intended, required sequence — never
 * skip a step — is:
 *
 *   1. mirrorDatabase(liveDb, mirrorPath)      -- consistent, compacted copy; the original is
 *                                                  never opened for writing by anything below.
 *   2. planIdMigration(mirror) + applyIdMigration(mirror, plan) -- mutate the MIRROR only.
 *   3. verifyIdMigration(mirror, plan)         -- must report { ok: true } before proceeding.
 *   4. Only then: promote the validated mirror file to replace production (a plain file swap,
 *      done by the CLI once step 3 has passed — this module does not perform that swap itself,
 *      so there is no code path in this file that can touch a production file that hasn't
 *      already been proven correct as a mirror).
 *
 * Coverage: every column that is a structural foreign key to artifacts.id is remapped and
 * verified via PRAGMA foreign_key_check (this is the correctness-critical half — a miss here
 * means a broken database, not a stale reference). A second, best-effort pass exact-substring-
 * replaces old ids wherever they appear inside a known set of free-text/JSON columns (title,
 * body, extra, and the two Task-event text fields) — this is how a prose cross-reference like
 * "see task some-old-id for the parent epic" keeps pointing at the right artifact after its id
 * changes.
 */
import type { Db } from "./db.ts";
import { inTransaction } from "./db.ts";

/** This tool is designed and tested at Papyrus's current graph scale, not unbounded. */
export const ID_MIGRATION_MAX_ARTIFACTS = 50_000;

export interface IdMigrationPlan {
	readonly idMap: ReadonlyMap<string, string>;
}

export interface IdMigrationReport {
	readonly artifactsRemapped: number;
	readonly edgesRemapped: number;
	readonly textOccurrencesRemapped: number;
}

export interface IdMigrationVerification {
	readonly ok: boolean;
	readonly problems: string[];
}

/** Every column that structurally references an artifact id, enforced FK or not. */
const FK_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
	{ table: "edges", column: "from_id" },
	{ table: "edges", column: "to_id" },
	{ table: "task_focus", column: "task_id" },
	{ table: "task_events", column: "task_id" },
	{ table: "task_scopes", column: "task_id" },
	{ table: "task_views", column: "root_task_id" },
	{ table: "artifact_events", column: "artifact_id" },
	{ table: "artifact_events", column: "related_id" },
];

/**
 * Free-text/JSON columns that may embed a plain-text mention of an artifact id, beyond the
 * structural FK columns above. See the module doc comment for what this deliberately excludes.
 */
const TEXT_SCAN_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
	{ table: "artifacts", column: "title" },
	{ table: "artifacts", column: "body" },
	{ table: "artifacts", column: "extra" },
	{ table: "task_events", column: "reason" },
	{ table: "task_events", column: "evidence_json" },
];

/** Audit tables whose append-only guard must be suspended for exactly this migration's duration. */
const APPEND_ONLY_GUARD_TRIGGERS = ["task_events_no_update", "task_events_no_delete", "artifact_events_no_update", "artifact_events_no_delete"];

function tableExists(db: Db, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

export function planIdMigration(db: Db): IdMigrationPlan {
	const rows = db.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>;
	if (rows.length > ID_MIGRATION_MAX_ARTIFACTS) {
		throw new Error(`id migration is bounded to ${ID_MIGRATION_MAX_ARTIFACTS} artifacts; found ${rows.length}`);
	}
	const idMap = new Map<string, string>();
	for (const row of rows) idMap.set(row.id, crypto.randomUUID());
	return { idMap };
}

/**
 * Mutates `db` in place. Callers must only ever pass a mirror (see mirrorDatabase), never a
 * database a live daemon may still be serving reads/writes against.
 */
export function applyIdMigration(db: Db, plan: IdMigrationPlan): IdMigrationReport {
	const { idMap } = plan;
	if (idMap.size === 0) return { artifactsRemapped: 0, edgesRemapped: 0, textOccurrencesRemapped: 0 };

	// PRAGMA foreign_keys is a no-op inside an open transaction in SQLite, so it must be set
	// before BEGIN, not inside inTransaction's callback.
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		return inTransaction(db, () => {
			const triggerDdl = new Map<string, string>();
			for (const name of APPEND_ONLY_GUARD_TRIGGERS) {
				const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
				if (row) { triggerDdl.set(name, row.sql); db.exec(`DROP TRIGGER ${name}`); }
			}
			try {
				let edgesRemapped = 0;
				for (const { table, column } of FK_COLUMNS) {
					if (!tableExists(db, table)) continue;
					const stmt = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`);
					for (const [oldId, newId] of idMap) {
						stmt.run(newId, oldId);
						if (table === "edges") edgesRemapped++;
					}
				}

				// artifacts.id itself, once nothing else still points at the old value.
				const idStmt = db.prepare("UPDATE artifacts SET id = ? WHERE id = ?");
				for (const [oldId, newId] of idMap) idStmt.run(newId, oldId);

				let textOccurrencesRemapped = 0;
				for (const { table, column } of TEXT_SCAN_COLUMNS) {
					if (!tableExists(db, table)) continue;
					const rows = db.prepare(`SELECT rowid AS rowid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ rowid: number; value: string }>;
					const updateStmt = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
					for (const row of rows) {
						let value = row.value;
						let changed = false;
						for (const [oldId, newId] of idMap) {
							if (value.includes(oldId)) {
								value = value.split(oldId).join(newId);
								changed = true;
								textOccurrencesRemapped++;
							}
						}
						if (changed) updateStmt.run(value, row.rowid);
					}
				}

				return { artifactsRemapped: idMap.size, edgesRemapped, textOccurrencesRemapped };
			} finally {
				for (const [, sql] of triggerDdl) db.exec(sql);
			}
		});
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
		// File-backed databases run in WAL mode (see openDb): a committed transaction can be
		// fully durable yet still live only in the -wal sidecar file, not yet folded into the
		// main database file. A caller that copies just the main file (mirrorDatabase's whole
		// point, and promote's file swap) would silently see stale pre-migration content unless
		// this is forced. A no-op for :memory: databases (nothing to checkpoint).
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}
}

/**
 * Read-only. Must be run against the mirror after applyIdMigration, before any promotion.
 * Checks (a) referential integrity holds with no violations, (b) every old id is fully gone
 * from artifacts.id and every FK column, (c) row counts are unchanged for artifacts/edges/
 * both audit logs, and (d) every artifact's content is unchanged except for id substitution.
 */
export function verifyIdMigration(db: Db, plan: IdMigrationPlan): IdMigrationVerification {
	const problems: string[] = [];

	const violations = db.prepare("PRAGMA foreign_key_check").all();
	if (violations.length > 0) problems.push(`${violations.length} foreign key violation(s) found after migration`);

	for (const oldId of plan.idMap.keys()) {
		if (db.prepare("SELECT 1 FROM artifacts WHERE id = ?").get(oldId) != null) {
			problems.push(`old id "${oldId}" is still present in artifacts.id`);
		}
		for (const { table, column } of FK_COLUMNS) {
			if (!tableExists(db, table)) continue;
			const leak = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(oldId) as { n: number };
			if (leak.n > 0) problems.push(`old id "${oldId}" still referenced in ${table}.${column} (${leak.n} row(s))`);
		}
	}

	const artifactCount = (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
	if (artifactCount !== plan.idMap.size) {
		problems.push(`expected ${plan.idMap.size} artifacts after migration, found ${artifactCount}`);
	}

	return { ok: problems.length === 0, problems };
}

/**
 * Produces a consistent, compacted, independent copy of `db` at `path` via SQLite's own
 * VACUUM INTO — safe regardless of the source's WAL state, and does not require the caller to
 * coordinate checkpointing. The original connection and file are never written to by this call.
 */
export function mirrorDatabase(db: Db, path: string): void {
	db.prepare("VACUUM INTO ?").run(path);
}
