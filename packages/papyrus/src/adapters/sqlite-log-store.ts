import type { Db } from "../db.ts";
import type { JsonValue, LogEntry, LogLevel, LogSource } from "../domain/log-entry.ts";
import type { LogStore } from "../ports/log-store.ts";

interface SourceRow {
	id: string;
	label: string;
	project_root: string | null;
	created_at: string;
}

interface EntryRow {
	id: string;
	source_id: string;
	occurred_at: string;
	level: string;
	message: string;
	truncated: number;
	fields_json: string;
	operation_id: string;
	session_id: string | null;
}

function toSource(row: SourceRow): LogSource {
	return { id: row.id, label: row.label, projectRoot: row.project_root, createdAt: row.created_at };
}

function toEntry(row: EntryRow): LogEntry {
	return {
		id: row.id,
		sourceId: row.source_id,
		occurredAt: row.occurred_at,
		level: row.level as LogLevel,
		message: row.message,
		truncated: row.truncated === 1,
		fields: JSON.parse(row.fields_json) as JsonValue,
		operationId: row.operation_id,
		sessionId: row.session_id ?? undefined,
	};
}

export class SQLiteLogStore implements LogStore {
	constructor(private readonly db: Db) {}

	ensureSource(sourceId: string, label: string, projectRoot: string | null): LogSource {
		const existing = this.db.prepare("SELECT id, label, project_root, created_at FROM log_sources WHERE id = ?").get(sourceId) as SourceRow | undefined;
		if (existing) return toSource(existing);
		const createdAt = new Date().toISOString();
		this.db.prepare("INSERT INTO log_sources (id, label, project_root, created_at) VALUES (?, ?, ?, ?)").run(sourceId, label, projectRoot, createdAt);
		return { id: sourceId, label, projectRoot, createdAt };
	}

	findEntryByOperationId(sourceId: string, operationId: string): LogEntry | undefined {
		const row = this.db.prepare(
			"SELECT id, source_id, occurred_at, level, message, truncated, fields_json, operation_id, session_id FROM log_entries WHERE source_id = ? AND operation_id = ?",
		).get(sourceId, operationId) as EntryRow | undefined;
		return row ? toEntry(row) : undefined;
	}

	insertEntry(entry: LogEntry): void {
		this.db.prepare(
			`INSERT INTO log_entries (id, source_id, occurred_at, level, message, truncated, fields_json, operation_id, session_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			entry.id, entry.sourceId, entry.occurredAt, entry.level, entry.message,
			entry.truncated ? 1 : 0, JSON.stringify(entry.fields), entry.operationId, entry.sessionId ?? null,
		);
	}

	entriesForSource(sourceId: string): readonly LogEntry[] {
		const rows = this.db.prepare(
			"SELECT id, source_id, occurred_at, level, message, truncated, fields_json, operation_id, session_id FROM log_entries WHERE source_id = ? ORDER BY occurred_at, id",
		).all(sourceId) as EntryRow[];
		return rows.map(toEntry);
	}

	trimSource(sourceId: string, maxEntries: number): number {
		const countRow = this.db.prepare("SELECT COUNT(*) as count FROM log_entries WHERE source_id = ?").get(sourceId) as { count: number };
		const excess = countRow.count - maxEntries;
		if (excess <= 0) return 0;
		this.db.prepare(
			`DELETE FROM log_entries WHERE id IN (
				SELECT id FROM log_entries WHERE source_id = ? ORDER BY occurred_at, id LIMIT ?
			)`,
		).run(sourceId, excess);
		return excess;
	}
}
