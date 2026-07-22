import type { LogEntry, LogSource } from "../domain/log-entry.ts";

/**
 * Persistence port for the `log` domain. Deliberately minimal, matching
 * ConversationJournalStore's own split: this is dumb storage (idempotency-key lookup,
 * insert, bounded-at-the-service-layer reads) plus one operation the store must own because
 * only it knows real row counts -- retention trimming.
 */
export interface LogStore {
	ensureSource(sourceId: string, label: string, projectRoot: string | null): LogSource;
	findEntryByOperationId(sourceId: string, operationId: string): LogEntry | undefined;
	insertEntry(entry: LogEntry): void;
	/** All entries for one source, chronological (oldest first), unbounded at the store layer -- the service applies query bounds/filters. */
	entriesForSource(sourceId: string): readonly LogEntry[];
	/** Deletes the oldest entries for a source beyond `maxEntries`, returning how many were removed -- retention enforcement, not a general delete capability. */
	trimSource(sourceId: string, maxEntries: number): number;
}
