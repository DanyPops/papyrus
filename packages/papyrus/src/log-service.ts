import { randomUUID } from "node:crypto";
import {
	boundMessage,
	LOG_QUERY_MAX_ENTRIES,
	LOG_RETENTION_MAX_ENTRIES_PER_SOURCE,
	meetsLevel,
	validateAppendLogEntryCommand,
	type AppendLogEntryCommand,
	type AppendLogEntryResult,
	type LogEntryPage,
	type LogQuery,
} from "./domain/log-entry.ts";
import type { LogStore } from "./ports/log-store.ts";

export class Logs {
	constructor(private readonly store: LogStore) {}

	append(command: AppendLogEntryCommand): AppendLogEntryResult {
		validateAppendLogEntryCommand(command);
		this.store.ensureSource(command.sourceId, command.sourceLabel ?? command.sourceId, command.projectRoot ?? null);
		const existing = this.store.findEntryByOperationId(command.sourceId, command.operationId);
		if (existing) return { entry: existing, replayed: true };

		const { message, truncated } = boundMessage(command.message);
		const entry = {
			id: randomUUID(),
			sourceId: command.sourceId,
			occurredAt: command.occurredAt ?? new Date().toISOString(),
			level: command.level,
			message,
			truncated,
			fields: command.fields ?? {},
			operationId: command.operationId,
			sessionId: command.sessionId,
		};
		this.store.insertEntry(entry);
		this.store.trimSource(command.sourceId, LOG_RETENTION_MAX_ENTRIES_PER_SOURCE);
		return { entry, replayed: false };
	}

	/**
	 * `since` given: this is a live-tail/polling cursor -- return the OLDEST entries in the
	 * window so a caller can advance its cursor without skipping any, at the cost of not yet
	 * seeing the very latest (call again with a later `since` to keep catching up).
	 * `since` omitted: this is a post-mortem browse -- return the MOST RECENT entries,
	 * matching `tail -n`'s familiar behavior.
	 */
	query(query: LogQuery): LogEntryPage {
		const limit = Math.min(query.limit ?? LOG_QUERY_MAX_ENTRIES, LOG_QUERY_MAX_ENTRIES);
		const matching = this.store.entriesForSource(query.sourceId)
			.filter((entry) => query.since === undefined || entry.occurredAt > query.since)
			.filter((entry) => query.level === undefined || meetsLevel(entry.level, query.level));

		if (matching.length <= limit) return { entries: matching, truncated: false };
		const windowed = query.since !== undefined ? matching.slice(0, limit) : matching.slice(matching.length - limit);
		return { entries: windowed, truncated: true };
	}
}
