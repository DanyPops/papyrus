/**
 * domain/log-entry.ts — the `log` domain: structured, timestamped event records from any
 * source (an external adapter, a live session/context-window snapshot, later maybe
 * Papyrus's own operations), captured for both post-mortem review and live tailing.
 *
 * Deliberately NOT an Artifact kind (see the "match durable output to the right artifact
 * kind" Rule): a log entry has no lifecycle/status, is not individually curated, and the
 * corpus is naturally unbounded/continuously growing -- the opposite of what belongs in the
 * bounded, curated Artifact graph. Retention (LOG_RETENTION_MAX_ENTRIES_PER_SOURCE) is a
 * first-class concern here in a way it deliberately is NOT for the permanent
 * artifact_events/task_events audit trails: logs are meant to be rotated, not kept forever.
 *
 * Mirrors the (since-removed; see Doc "ConversationJournal design record") ConversationJournal
 * domain's own discipline (idempotency via a caller-constructed composite operationId,
 * explicit non-silent truncation) since both are append-only, externally-sourced record
 * streams -- but logs have no reply structure and do carry a
 * retention policy, which a durable conversation record deliberately does not.
 */

export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export const LOG_SOURCE_ID_MAX_LENGTH = 256;
export const LOG_MESSAGE_MAX_CHARACTERS = 4000;
/** Bound on the serialized JSON size of an entry's structured fields. */
export const LOG_FIELDS_MAX_CHARACTERS = 8000;
export const LOG_QUERY_MAX_ENTRIES = 500;
/** Oldest entries beyond this count (per source) are trimmed on every append -- see the module comment on why logs are retained, not kept forever. */
export const LOG_RETENTION_MAX_ENTRIES_PER_SOURCE = 5000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface LogSource {
	readonly id: string;
	readonly label: string;
	readonly projectRoot: string | null;
	readonly createdAt: string;
}

export interface LogEntry {
	readonly id: string;
	readonly sourceId: string;
	readonly occurredAt: string;
	readonly level: LogLevel;
	readonly message: string;
	/** True when message was cut to LOG_MESSAGE_MAX_CHARACTERS -- never silently. */
	readonly truncated: boolean;
	readonly fields: JsonValue;
	/**
	 * Idempotency key. Must be a composite the caller constructs (e.g. `${sessionId}:${turn}`),
	 * never a bare upstream id alone -- a source's own local ids are commonly unique only
	 * within one recording run, not globally, matching the same operationId discipline
	 * established by the (since-removed) ConversationJournal domain and the concrete case
	 * it generalizes from (Pi's /tree lessons).
	 */
	readonly operationId: string;
	readonly sessionId?: string;
}

export interface AppendLogEntryCommand {
	readonly sourceId: string;
	/** Used only the first time this sourceId is seen; ignored on every later append to the same source. */
	readonly sourceLabel?: string;
	readonly projectRoot?: string | null;
	readonly level: LogLevel;
	readonly message: string;
	readonly fields?: JsonValue;
	readonly operationId: string;
	readonly sessionId?: string;
	/** Caller-supplied for post-mortem/backfilled entries with a real historical timestamp; defaults to now for live entries. */
	readonly occurredAt?: string;
}

export interface AppendLogEntryResult {
	readonly entry: LogEntry;
	/** True when this exact operationId was already logged and this call was a safe no-op replay. */
	readonly replayed: boolean;
}

export interface LogQuery {
	readonly sourceId: string;
	/** ISO timestamp, exclusive lower bound -- the live-tail/polling cursor. */
	readonly since?: string;
	/** A floor, not an exact match: "warning" returns warning and error, matching conventional log-level filters. */
	readonly level?: LogLevel;
	readonly limit?: number;
}

export interface LogEntryPage {
	readonly entries: readonly LogEntry[];
	/** True when more entries exist beyond this page -- never silently drop the remainder without saying so. */
	readonly truncated: boolean;
}

function requireBounded(value: string, label: string, maxLength: number): string {
	if (value.length === 0) throw new Error(`${label} is required`);
	if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
	return value;
}

export function validateAppendLogEntryCommand(command: AppendLogEntryCommand): void {
	requireBounded(command.sourceId, "sourceId", LOG_SOURCE_ID_MAX_LENGTH);
	requireBounded(command.operationId, "operationId", LOG_SOURCE_ID_MAX_LENGTH * 2);
	if (command.message.length === 0) throw new Error("message is required");
	if (!(LOG_LEVELS as readonly string[]).includes(command.level)) throw new Error(`level must be one of ${LOG_LEVELS.join(", ")}`);
	const fieldsSize = command.fields === undefined ? 0 : JSON.stringify(command.fields).length;
	if (fieldsSize > LOG_FIELDS_MAX_CHARACTERS) throw new Error(`fields exceeds ${LOG_FIELDS_MAX_CHARACTERS} characters when serialized`);
}

/** Applies the explicit truncation bound. Never silently drops the truncation fact -- callers must surface `truncated`. */
export function boundMessage(message: string): { message: string; truncated: boolean } {
	if (message.length <= LOG_MESSAGE_MAX_CHARACTERS) return { message, truncated: false };
	return { message: message.slice(0, LOG_MESSAGE_MAX_CHARACTERS), truncated: true };
}

const LEVEL_SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

/** True when `level` meets or exceeds `minimum` -- LogQuery.level is a floor, not an exact match. */
export function meetsLevel(level: LogLevel, minimum: LogLevel): boolean {
	return LEVEL_SEVERITY[level] >= LEVEL_SEVERITY[minimum];
}
