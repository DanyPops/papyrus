import { describe, expect, it } from "bun:test";
import { Logs } from "../src/log-service.ts";
import { LOG_FIELDS_MAX_CHARACTERS, LOG_MESSAGE_MAX_CHARACTERS, LOG_RETENTION_MAX_ENTRIES_PER_SOURCE } from "../src/domain/log-entry.ts";
import type { LogEntry, LogSource } from "../src/domain/log-entry.ts";
import type { LogStore } from "../src/ports/log-store.ts";

class InMemoryLogStore implements LogStore {
	private readonly sources = new Map<string, LogSource>();
	private readonly entries = new Map<string, LogEntry[]>();
	private readonly byOperationId = new Map<string, LogEntry>();

	ensureSource(sourceId: string, label: string, projectRoot: string | null): LogSource {
		const existing = this.sources.get(sourceId);
		if (existing) return existing;
		const source: LogSource = { id: sourceId, label, projectRoot, createdAt: new Date().toISOString() };
		this.sources.set(sourceId, source);
		return source;
	}

	findEntryByOperationId(sourceId: string, operationId: string): LogEntry | undefined {
		const entry = this.byOperationId.get(`${sourceId}:${operationId}`);
		return entry;
	}

	insertEntry(entry: LogEntry): void {
		const list = this.entries.get(entry.sourceId) ?? [];
		list.push(entry);
		this.entries.set(entry.sourceId, list);
		this.byOperationId.set(`${entry.sourceId}:${entry.operationId}`, entry);
	}

	entriesForSource(sourceId: string): readonly LogEntry[] {
		return [...(this.entries.get(sourceId) ?? [])];
	}

	trimSource(sourceId: string, maxEntries: number): number {
		const list = this.entries.get(sourceId) ?? [];
		const excess = list.length - maxEntries;
		if (excess <= 0) return 0;
		const removed = list.splice(0, excess);
		for (const entry of removed) this.byOperationId.delete(`${entry.sourceId}:${entry.operationId}`);
		return excess;
	}
}

function command(overrides: Partial<Parameters<Logs["append"]>[0]> = {}) {
	return {
		sourceId: "pi-session-context",
		level: "info" as const,
		message: "turn settled",
		operationId: "op-1",
		...overrides,
	};
}

describe("Logs.append", () => {
	it("creates the source on first append and reuses it on later appends", () => {
		const logs = new Logs(new InMemoryLogStore());
		const first = logs.append(command({ sourceLabel: "Pi session context" }));
		expect(first.replayed).toBe(false);
		const second = logs.append(command({ operationId: "op-2", sourceLabel: "a different label, ignored" }));
		expect(second.replayed).toBe(false);
		expect(second.entry.sourceId).toBe("pi-session-context");
	});

	it("is idempotent: replaying the same operationId returns the original entry, not a duplicate", () => {
		const logs = new Logs(new InMemoryLogStore());
		const first = logs.append(command());
		const replay = logs.append(command({ message: "a different message, ignored on replay" }));
		expect(replay.replayed).toBe(true);
		expect(replay.entry.id).toBe(first.entry.id);
		expect(replay.entry.message).toBe(first.entry.message);
	});

	it("truncates an over-long message explicitly rather than silently, and reports it", () => {
		const logs = new Logs(new InMemoryLogStore());
		const result = logs.append(command({ message: "x".repeat(LOG_MESSAGE_MAX_CHARACTERS + 500) }));
		expect(result.entry.truncated).toBe(true);
		expect(result.entry.message.length).toBe(LOG_MESSAGE_MAX_CHARACTERS);
	});

	it("rejects fields that exceed the serialized size bound", () => {
		const logs = new Logs(new InMemoryLogStore());
		expect(() => logs.append(command({ fields: { blob: "x".repeat(LOG_FIELDS_MAX_CHARACTERS) } }))).toThrow(/fields exceeds/);
	});

	it("rejects an empty message, an empty sourceId, and an invalid level", () => {
		const logs = new Logs(new InMemoryLogStore());
		expect(() => logs.append(command({ message: "" }))).toThrow(/message is required/);
		expect(() => logs.append(command({ sourceId: "" }))).toThrow(/sourceId is required/);
		expect(() => logs.append(command({ level: "critical" as never }))).toThrow(/level must be one of/);
	});

	it("enforces retention: trims the oldest entries beyond LOG_RETENTION_MAX_ENTRIES_PER_SOURCE on append", () => {
		const store = new InMemoryLogStore();
		const logs = new Logs(store);
		for (let index = 0; index < LOG_RETENTION_MAX_ENTRIES_PER_SOURCE + 10; index++) {
			logs.append(command({ operationId: `op-${index}`, message: `entry ${index}` }));
		}
		const remaining = store.entriesForSource("pi-session-context");
		expect(remaining.length).toBe(LOG_RETENTION_MAX_ENTRIES_PER_SOURCE);
		expect(remaining[0]!.message).toBe("entry 10"); // the oldest 10 were trimmed
		expect(remaining[remaining.length - 1]!.message).toBe(`entry ${LOG_RETENTION_MAX_ENTRIES_PER_SOURCE + 9}`);
	});

	it("defaults occurredAt to now for a live entry, but honors a caller-supplied historical timestamp for post-mortem backfill", () => {
		const logs = new Logs(new InMemoryLogStore());
		const live = logs.append(command());
		expect(new Date(live.entry.occurredAt).getTime()).toBeGreaterThan(Date.now() - 5000);
		const backfilled = logs.append(command({ operationId: "op-old", occurredAt: "2020-01-01T00:00:00.000Z" }));
		expect(backfilled.entry.occurredAt).toBe("2020-01-01T00:00:00.000Z");
	});
});

describe("Logs.query", () => {
	function seed(logs: Logs, count: number, sourceId = "s"): void {
		for (let index = 0; index < count; index++) {
			logs.append(command({ sourceId, operationId: `op-${index}`, message: `entry ${index}`, occurredAt: `2024-01-01T00:00:${String(index).padStart(2, "0")}.000Z` }));
		}
	}

	it("returns all entries untruncated when under the limit", () => {
		const logs = new Logs(new InMemoryLogStore());
		seed(logs, 3);
		const page = logs.query({ sourceId: "s" });
		expect(page.entries.length).toBe(3);
		expect(page.truncated).toBe(false);
	});

	it("without `since`: returns the MOST RECENT entries when over the limit, matching tail -n", () => {
		const logs = new Logs(new InMemoryLogStore());
		seed(logs, 10);
		const page = logs.query({ sourceId: "s", limit: 3 });
		expect(page.truncated).toBe(true);
		expect(page.entries.map((entry) => entry.message)).toEqual(["entry 7", "entry 8", "entry 9"]);
	});

	it("with `since`: returns the OLDEST entries after the cursor when over the limit, so polling never skips entries", () => {
		const logs = new Logs(new InMemoryLogStore());
		seed(logs, 10);
		const page = logs.query({ sourceId: "s", since: "2024-01-01T00:00:00.000Z", limit: 3 });
		expect(page.truncated).toBe(true);
		expect(page.entries.map((entry) => entry.message)).toEqual(["entry 1", "entry 2", "entry 3"]);
	});

	it("filters by level as a floor (warning returns warning and error, not debug/info)", () => {
		const logs = new Logs(new InMemoryLogStore());
		logs.append(command({ sourceId: "lvl", operationId: "d", level: "debug", message: "d" }));
		logs.append(command({ sourceId: "lvl", operationId: "i", level: "info", message: "i" }));
		logs.append(command({ sourceId: "lvl", operationId: "w", level: "warning", message: "w" }));
		logs.append(command({ sourceId: "lvl", operationId: "e", level: "error", message: "e" }));
		const page = logs.query({ sourceId: "lvl", level: "warning" });
		expect(page.entries.map((entry) => entry.message)).toEqual(["w", "e"]);
	});

	it("returns an empty page for a source that has never been appended to, rather than throwing", () => {
		const logs = new Logs(new InMemoryLogStore());
		expect(logs.query({ sourceId: "never-seen" })).toEqual({ entries: [], truncated: false });
	});
});
