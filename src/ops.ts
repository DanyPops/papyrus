/**
 * ops.ts — typed operations over the Papyrus DB.
 * Enforces the schema protocol (kinds, statuses, relations) via FK + app validation.
 */
import { createRequire } from "node:module";
import { exec } from "node:child_process";
import type { Db } from "./db.ts";
import { inTransaction } from "./db.ts";
import { ARTIFACT_TRASH_RETENTION_MS, DEFAULT_STATUS_BY_KIND } from "./constants.ts";
import type { Artifact, ArtifactQuery, CreateArtifactInput, UpdateArtifactInput } from "./domain/artifact.ts";
import type { ArtifactTrashRecord } from "./domain/artifact-trash.ts";
export type { ArtifactTrashRecord } from "./domain/artifact-trash.ts";
import type { Gate, GateResult, GateRunOptions } from "./domain/gate.ts";
import {
	normalizeArtifactEventQuery,
	resolveArtifactEvent,
	type AppendArtifactEvent,
	type ArtifactEvent,
	type ArtifactEventContext,
	type ArtifactEventPage,
	type ArtifactEventQuery,
	type ArtifactEventType,
} from "./domain/artifact-event.ts";
export type { Artifact } from "./domain/artifact.ts";
export type { Gate, GateResult } from "./domain/gate.ts";
export type CreateInput = CreateArtifactInput;
import {
	DEFAULT_GRAPH_DEPTH,
	DEFAULT_GRAPH_MAX_NODES,
	MAX_GRAPH_DEPTH,
	MAX_GRAPH_NODES,
	GATE_COMMAND_TIMEOUT_MS,
	GATE_TEST_TIMEOUT_MS,
	GATE_OUTPUT_LIMIT,
	GATE_MAX_BUFFER_BYTES,
	GATE_FILE_MAX_BYTES,
} from "./constants.ts";

const require_ = createRequire(import.meta.url);

interface ResolvedCreateInput extends CreateInput {
	kind: string;
	title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge object defaults recursively; explicit arrays and scalar values replace defaults. */
function deepMerge(base: unknown, override: unknown): unknown {
	if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : override;
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		merged[key] = key in merged ? deepMerge(merged[key], value) : value;
	}
	return merged;
}

function valueAtPath(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, segment) =>
		isRecord(current) ? current[segment] : undefined, value);
}

function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function resolveCreateInput(db: Db, input: CreateInput): ResolvedCreateInput {
	if (!input.templateId) {
		if (!input.kind) throw new Error("kind is required");
		if (!input.title) throw new Error("title is required");
		return input as ResolvedCreateInput;
	}

	const template = getArtifact(db, input.templateId);
	if (!template) throw new Error(`template "${input.templateId}" not found`);
	if (template.kind !== "skill" || template.subtype !== "artifact-template") {
		throw new Error(`artifact "${input.templateId}" is not an artifact template`);
	}

	const targetKind = template.extra["targetKind"];
	if (typeof targetKind !== "string" || targetKind.length === 0) {
		throw new Error(`template "${input.templateId}" has no targetKind`);
	}
	if (input.kind && input.kind !== targetKind) {
		throw new Error(`template "${input.templateId}" targets kind "${targetKind}", not "${input.kind}"`);
	}

	const defaults = isRecord(template.extra["defaults"]) ? template.extra["defaults"] : {};
	const { templateId: _templateId, ...overrides } = input;
	const merged = deepMerge(defaults, overrides) as CreateInput;
	merged.kind = targetKind;

	const required = Array.isArray(template.extra["required"])
		? template.extra["required"].filter((field): field is string => typeof field === "string")
		: ["title"];
	for (const field of required) {
		if (!isPresent(valueAtPath(merged, field))) {
			throw new Error(`missing required template field "${field}"`);
		}
	}
	if (!merged.title) throw new Error("title is required");
	return merged as ResolvedCreateInput;
}

function defaultStatusFor(db: Db, kind: string): string {
	// Explicit per-kind mapping, never row order -- see DEFAULT_STATUS_BY_KIND's doc comment
	// for the production defect this replaced (row order is not a semantic guarantee).
	const candidate = DEFAULT_STATUS_BY_KIND[kind];
	if (candidate === undefined) throw new Error(`no default status is configured for kind "${kind}"`);
	const exists = db.prepare("SELECT 1 FROM statuses WHERE kind = ? AND name = ?").get(kind, candidate);
	if (!exists) throw new Error(`configured default status "${candidate}" for kind "${kind}" is not a registered status`);
	return candidate;
}

function rowToArtifact(row: Record<string, unknown>): Artifact {
	return {
		id: row["id"] as string,
		kind: row["kind"] as string,
		title: row["title"] as string,
		status: row["status"] as string,
		subtype: (row["subtype"] as string) ?? "",
		body: (row["body"] as string) ?? "",
		labels: JSON.parse((row["labels"] as string) ?? "[]"),
		extra: JSON.parse((row["extra"] as string) ?? "{}"),
		created_at: row["created_at"] as string,
		updated_at: row["updated_at"] as string,
	};
}

/**
 * Appends one immutable row to the generic, kind-agnostic mutation event log.
 * This is the one choke point every ArtifactStore mutation funnels through, so every
 * kind (doc, task, rule, skill) gets an audit trail for free — no domain call site
 * can skip it. See src/domain/artifact-event.ts for why actor/source always default
 * to explicit sentinels rather than a silently blank column.
 */
export function appendArtifactEvent(db: Db, input: AppendArtifactEvent): ArtifactEvent {
	const event = resolveArtifactEvent(input);
	const now = new Date().toISOString();
	let id: number | bigint = 0;
	inTransaction(db, () => {
		const result = db.prepare(`
			INSERT INTO artifact_events (
				artifact_id, occurred_at, event_type, actor, source, session_id,
				from_status, to_status, relation, related_id, event_schema_version
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		`).run(
			event.artifactId,
			now,
			event.type,
			event.actor,
			event.source,
			event.sessionId ?? null,
			event.fromStatus ?? null,
			event.toStatus ?? null,
			event.relation ?? null,
			event.relatedId ?? null,
		);
		id = result.lastInsertRowid;
	});
	return {
		id: Number(id),
		artifactId: event.artifactId,
		occurredAt: now,
		type: event.type,
		actor: event.actor,
		source: event.source,
		...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
		...(event.fromStatus === undefined ? {} : { fromStatus: event.fromStatus }),
		...(event.toStatus === undefined ? {} : { toStatus: event.toStatus }),
		...(event.relation === undefined ? {} : { relation: event.relation }),
		...(event.relatedId === undefined ? {} : { relatedId: event.relatedId }),
		schemaVersion: 1,
	};
}

interface ArtifactEventRow {
	id: number;
	artifact_id: string;
	occurred_at: string;
	event_type: ArtifactEventType;
	actor: string;
	source: string;
	session_id: string | null;
	from_status: string | null;
	to_status: string | null;
	relation: string | null;
	related_id: string | null;
	event_schema_version: 1;
}

function mapArtifactEventRow(row: ArtifactEventRow): ArtifactEvent {
	return {
		id: row.id,
		artifactId: row.artifact_id,
		occurredAt: row.occurred_at,
		type: row.event_type,
		actor: row.actor,
		source: row.source,
		...(row.session_id === null ? {} : { sessionId: row.session_id }),
		...(row.from_status === null ? {} : { fromStatus: row.from_status }),
		...(row.to_status === null ? {} : { toStatus: row.to_status }),
		...(row.relation === null ? {} : { relation: row.relation }),
		...(row.related_id === null ? {} : { relatedId: row.related_id }),
		schemaVersion: row.event_schema_version,
	};
}

/** Bounded query over the generic mutation event log — requires artifactId, actor, or sessionId to stay indexed. */
export function queryArtifactEvents(db: Db, query: ArtifactEventQuery): ArtifactEventPage {
	const { artifactId, actor, sessionId, since, limit, direction, cursor } = normalizeArtifactEventQuery(query);
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (artifactId) { conditions.push("(artifact_id = ? OR related_id = ?)"); params.push(artifactId, artifactId); }
	if (actor) { conditions.push("actor = ?"); params.push(actor); }
	if (sessionId) { conditions.push("session_id = ?"); params.push(sessionId); }
	if (since) { conditions.push("occurred_at >= ?"); params.push(since); }
	const comparator = direction === "desc" ? "<" : ">";
	if (cursor !== undefined) { conditions.push(`id ${comparator} ?`); params.push(cursor); }
	const order = direction === "desc" ? "DESC" : "ASC";
	const rows = db.prepare(`
		SELECT * FROM artifact_events
		WHERE ${conditions.join(" AND ")}
		ORDER BY occurred_at ${order}, id ${order}
		LIMIT ?
	`).all(...params, limit + 1) as ArtifactEventRow[];
	const hasMore = rows.length > limit;
	const events = rows.slice(0, limit).map(mapArtifactEventRow);
	return { events, ...(hasMore ? { nextCursor: events.at(-1)!.id } : {}) };
}

export function createArtifact(db: Db, input: CreateInput, context?: ArtifactEventContext): Artifact {
	const resolved = resolveCreateInput(db, input);
	// id is an opaque backend identity, never derived from title -- a title-derived slug
	// conflated "identity" with "human-readable label" and leaked a bit of randomness into
	// both. crypto.randomUUID() is native to Bun/Node; no dependency needed for this.
	const id = resolved.id ?? crypto.randomUUID();
	const status = resolved.status ?? defaultStatusFor(db, resolved.kind);
	const now = new Date().toISOString();
	const labels = JSON.stringify(resolved.labels ?? []);
	const extra = JSON.stringify(resolved.extra ?? {});
	const subtype = resolved.subtype ?? "";
	inTransaction(db, () => {
		const stmt = db.prepare(
			"INSERT INTO artifacts (id, kind, title, status, subtype, body, labels, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		stmt.run(id, resolved.kind, resolved.title, status, subtype, resolved.body ?? "", labels, extra, now, now);
		appendArtifactEvent(db, { artifactId: id, type: "created", toStatus: status, ...context });
	});
	return getArtifact(db, id)!;
}

export function getArtifact(db: Db, id: string, opts?: { tree?: boolean; depth?: number; maxNodes?: number }): Artifact | null {
	const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> | null;
	if (!row) return null;
	const art = rowToArtifact(row);
	if (opts?.tree) {
		const depthLimit = Math.min(MAX_GRAPH_DEPTH, Math.max(0, Math.floor(opts.depth ?? DEFAULT_GRAPH_DEPTH)));
		const nodeLimit = Math.min(MAX_GRAPH_NODES, Math.max(1, Math.floor(opts.maxNodes ?? DEFAULT_GRAPH_MAX_NODES)));
		const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
		const allEdges = db.prepare('SELECT from_id AS "from", relation, to_id AS "to" FROM edges').all() as { from: string; relation: string; to: string }[];
		const reachable = new Set<string>([id]);
		const adj = new Map<string, { from: string; relation: string; to: string }[]>();
		for (const edge of allEdges) {
			if (!adj.has(edge.from)) adj.set(edge.from, []);
			adj.get(edge.from)!.push(edge);
			if (!adj.has(edge.to)) adj.set(edge.to, []);
			adj.get(edge.to)!.push(edge);
		}
		while (queue.length > 0 && reachable.size < nodeLimit) {
			const current = queue.shift()!;
			if (current.depth >= depthLimit) continue;
			for (const edge of adj.get(current.id) ?? []) {
				const other = edge.from === current.id ? edge.to : edge.from;
				if (reachable.has(other)) continue;
				if (reachable.size >= nodeLimit) break;
				reachable.add(other);
				queue.push({ id: other, depth: current.depth + 1 });
			}
		}
		art.edges = allEdges.filter((edge) => reachable.has(edge.from) && reachable.has(edge.to));
	}
	return art;
}

export function queryArtifacts(db: Db, filter: ArtifactQuery): Artifact[] {
	let sql = "SELECT * FROM artifacts";
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (!filter.includeTrashed) conditions.push("id NOT IN (SELECT artifact_id FROM artifact_trash)");
	if (filter.kind) { conditions.push("kind = ?"); params.push(filter.kind); }
	if (filter.status) { conditions.push("status = ?"); params.push(filter.status); }
	if (filter.statuses) {
		if (filter.statuses.length === 0) return [];
		conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
		params.push(...filter.statuses);
	}
	if (filter.subtype) { conditions.push("subtype = ?"); params.push(filter.subtype); }
	if (filter.excludeSubtype) { conditions.push("subtype != ?"); params.push(filter.excludeSubtype); }
	if (filter.text) { conditions.push("(title LIKE ? OR body LIKE ?)"); params.push(`%${filter.text}%`, `%${filter.text}%`); }
	for (const label of filter.labels ?? []) {
		conditions.push("EXISTS (SELECT 1 FROM json_each(artifacts.labels) WHERE value = ?)");
		params.push(label);
	}
	for (const [key, value] of Object.entries(filter.extraEquals ?? {})) {
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid extra query key "${key}"`);
		conditions.push("json_extract(extra, ?) = ?");
		params.push(`$.${key}`, value);
	}
	if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
	sql += " ORDER BY updated_at DESC";
	if (filter.limit !== undefined) {
		if (!Number.isInteger(filter.limit) || filter.limit < 1) throw new Error("artifact query limit must be a positive integer");
		sql += " LIMIT ?";
		params.push(filter.limit);
	}
	const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
	return rows.map(rowToArtifact);
}

function rowToTrashRecord(row: Record<string, unknown>): ArtifactTrashRecord {
	return {
		artifactId: row["artifact_id"] as string,
		trashedAt: row["trashed_at"] as string,
		purgeAfter: row["purge_after"] as string,
		...(row["reason"] == null ? {} : { reason: row["reason"] as string }),
	};
}

export function getArtifactTrash(db: Db, id: string): ArtifactTrashRecord | null {
	const row = db.prepare("SELECT artifact_id, trashed_at, purge_after, reason FROM artifact_trash WHERE artifact_id = ?").get(id) as Record<string, unknown> | null;
	return row ? rowToTrashRecord(row) : null;
}

export function listArtifactTrash(db: Db): ArtifactTrashRecord[] {
	const rows = db.prepare("SELECT artifact_id, trashed_at, purge_after, reason FROM artifact_trash ORDER BY purge_after ASC").all() as Record<string, unknown>[];
	return rows.map(rowToTrashRecord);
}

/**
 * Moves an artifact to the trash: it becomes ineligible for purge_after ms (see
 * ARTIFACT_TRASH_RETENTION_MS), immediately excluded from queryArtifacts by default, still
 * directly reachable via getArtifact, and fully restorable via restoreArtifact until the
 * daemon's periodic sweep (purgeDueArtifacts) actually deletes it. Re-removing an
 * already-trashed artifact resets its clock rather than erroring -- the same "most recent
 * intent wins" semantics as registerSessionIdentity's rotation.
 *
 * Refuses to trash a Task that is the live Task Focus in any scope: Focus is active,
 * behavior-affecting state, and trashing out from under it would silently discard work a
 * caller is not necessarily looking at right now. No other kind has an analogous "currently
 * in use" signal to check.
 */
export function trashArtifact(db: Db, id: string, options?: { reason?: string; now?: () => string; context?: ArtifactEventContext }): ArtifactTrashRecord {
	const artifact = getArtifact(db, id);
	if (!artifact) throw new Error(`artifact "${id}" not found`);
	const focusedScope = db.prepare("SELECT scope FROM task_focus WHERE task_id = ? LIMIT 1").get(id) as { scope: string } | null;
	if (focusedScope) throw new Error(`artifact "${id}" is the active Task Focus in scope "${focusedScope.scope}"; clear focus before removing it`);
	const now = options?.now ?? (() => new Date().toISOString());
	const trashedAt = now();
	const purgeAfter = new Date(new Date(trashedAt).getTime() + ARTIFACT_TRASH_RETENTION_MS).toISOString();
	const record: ArtifactTrashRecord = { artifactId: id, trashedAt, purgeAfter, ...(options?.reason ? { reason: options.reason } : {}) };
	inTransaction(db, () => {
		db.prepare(`
			INSERT INTO artifact_trash (artifact_id, trashed_at, purge_after, reason) VALUES (?, ?, ?, ?)
			ON CONFLICT (artifact_id) DO UPDATE SET trashed_at = excluded.trashed_at, purge_after = excluded.purge_after, reason = excluded.reason
		`).run(record.artifactId, record.trashedAt, record.purgeAfter, record.reason ?? null);
		appendArtifactEvent(db, { artifactId: id, type: "trashed", ...(options?.context ?? {}) });
	});
	return record;
}

/** Idempotent: restoring an artifact that is not currently trashed is a real no-op, not an error -- mirrors releaseSessionIdentity's idempotence. */
export function restoreArtifact(db: Db, id: string, context?: ArtifactEventContext): { restored: boolean } {
	const wasTrashed = getArtifactTrash(db, id) !== null;
	if (!wasTrashed) return { restored: false };
	inTransaction(db, () => {
		db.prepare("DELETE FROM artifact_trash WHERE artifact_id = ?").run(id);
		appendArtifactEvent(db, { artifactId: id, type: "restored", ...(context ?? {}) });
	});
	return { restored: true };
}

/**
 * Real, cascading, irreversible deletion of every artifact whose purge_after has passed.
 * Never called with anything but the real current time in production -- see daemon.ts's
 * periodic sweep; a directly-injected `now` exists only so tests can exercise this without
 * waiting out ARTIFACT_TRASH_RETENTION_MS for real.
 *
 * Deletes, in FK-safe order, every row across every table that can reference artifacts(id)
 * (see the grep-verified list in domain/artifact-trash.ts's design comment): edges (both
 * directions), task_focus, task_scopes, task_views (by root_task_id), graph_projection_
 * identities, artifact_scopes, then task_events and artifact_events -- the latter two
 * succeed only because the artifact_trash row placed here by trashArtifact still exists
 * with an elapsed purge_after, which is exactly what db.ts's task_events_no_delete /
 * artifact_events_no_delete trigger carve-outs check themselves. Only THEN artifact_trash's
 * own row (it is itself a child of artifacts via a real FK, so it must go before artifacts,
 * but only after the event tables that depend on its continued presence), and artifacts
 * itself last of all. One artifact at a time in its own transaction, so one failure never
 * blocks any other due artifact.
 */
export function purgeDueArtifacts(db: Db, now: () => string = () => new Date().toISOString()): number {
	const nowIso = now();
	const due = (db.prepare("SELECT artifact_id FROM artifact_trash WHERE purge_after <= ?").all(nowIso) as Array<{ artifact_id: string }>).map((row) => row.artifact_id);
	let purged = 0;
	for (const id of due) {
		inTransaction(db, () => {
			db.prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?").run(id, id);
			db.prepare("DELETE FROM task_focus WHERE task_id = ?").run(id);
			db.prepare("DELETE FROM task_scopes WHERE task_id = ?").run(id);
			db.prepare("DELETE FROM task_views WHERE root_task_id = ?").run(id);
			db.prepare("DELETE FROM graph_projection_identities WHERE artifact_id = ?").run(id);
			db.prepare("DELETE FROM artifact_scopes WHERE artifact_id = ?").run(id);
			db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
			db.prepare("DELETE FROM artifact_events WHERE artifact_id = ?").run(id);
			db.prepare("DELETE FROM artifact_trash WHERE artifact_id = ?").run(id);
			db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
		});
		purged += 1;
	}
	return purged;
}

export function linkArtifacts(db: Db, fromId: string, relation: string, toId: string, context?: ArtifactEventContext): void {
	const fromArt = getArtifact(db, fromId);
	const toArt = getArtifact(db, toId);
	if (!fromArt || !toArt) throw new Error("artifact not found");
	// Relation name must be registered (FK on edges.relation enforces this too)
	const allowed = db.prepare("SELECT 1 FROM relation_names WHERE name = ?").get(relation);
	if (!allowed) throw new Error(`unknown relation "${relation}" — register it first`);
	inTransaction(db, () => {
		const existed = db.prepare("SELECT 1 FROM edges WHERE from_id = ? AND relation = ? AND to_id = ?").get(fromId, relation, toId);
		db.prepare("INSERT OR IGNORE INTO edges (from_id, relation, to_id) VALUES (?, ?, ?)").run(fromId, relation, toId);
		if (!existed) {
			appendArtifactEvent(db, { artifactId: fromId, type: "linked", relation, relatedId: toId, ...context });
		}
	});
}

/** Idempotent: removing an already-absent relationship is a no-op that returns false, not an error. */
export function unlinkArtifacts(db: Db, fromId: string, relation: string, toId: string, context?: ArtifactEventContext): boolean {
	let removed = false;
	inTransaction(db, () => {
		const existed = db.prepare("SELECT 1 FROM edges WHERE from_id = ? AND relation = ? AND to_id = ?").get(fromId, relation, toId);
		if (!existed) return;
		db.prepare("DELETE FROM edges WHERE from_id = ? AND relation = ? AND to_id = ?").run(fromId, relation, toId);
		appendArtifactEvent(db, { artifactId: fromId, type: "unlinked", relation, relatedId: toId, ...context });
		removed = true;
	});
	return removed;
}

export function updateArtifactContent(db: Db, id: string, input: UpdateArtifactInput, context?: ArtifactEventContext): Artifact | null {
	const artifact = getArtifact(db, id);
	if (!artifact) return null;
	const now = new Date().toISOString();
	inTransaction(db, () => {
		db.prepare("UPDATE artifacts SET title = ?, body = ?, labels = ?, updated_at = ? WHERE id = ?").run(
			input.title ?? artifact.title,
			input.body ?? artifact.body,
			JSON.stringify(input.labels ?? artifact.labels),
			now,
			id,
		);
		appendArtifactEvent(db, { artifactId: id, type: "updated", ...context });
	});
	return getArtifact(db, id);
}

export function updateStatus(db: Db, id: string, status: string, context?: ArtifactEventContext): Artifact | null {
	const art = getArtifact(db, id);
	if (!art) return null;
	// Validate status is registered for this kind
	const allowed = db.prepare("SELECT 1 FROM statuses WHERE kind = ? AND name = ?").get(art.kind, status);
	if (!allowed) throw new Error(`status "${status}" not registered for kind "${art.kind}"`);
	const now = new Date().toISOString();
	inTransaction(db, () => {
		db.prepare("UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
		appendArtifactEvent(db, { artifactId: id, type: "status_changed", fromStatus: art.status, toStatus: status, ...context });
	});
	return getArtifact(db, id);
}

export function updateExtra(db: Db, id: string, extra: Record<string, unknown>, context?: ArtifactEventContext): Artifact | null {
	if (!getArtifact(db, id)) return null;
	const now = new Date().toISOString();
	inTransaction(db, () => {
		db.prepare("UPDATE artifacts SET extra = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(extra), now, id);
		appendArtifactEvent(db, { artifactId: id, type: "extra_set", ...context });
	});
	return getArtifact(db, id);
}

/** Active rules with inject metadata — for before_agent_start system prompt injection. */
export function injectableRules(db: Db): Array<{ id: string; title: string; body: string; extra: Record<string, unknown> }> {
	const rows = db.prepare("SELECT * FROM artifacts WHERE kind = 'rule' AND status = 'active' ORDER BY updated_at DESC").all() as Record<string, unknown>[];
	return rows.map((row) => {
		const art = rowToArtifact(row);
		return { id: art.id, title: art.title, body: art.body, extra: art.extra };
	});
}

function readBoundedGateFile(path: string): string {
	const { readFileSync, statSync } = require_("node:fs");
	if (statSync(path).size > GATE_FILE_MAX_BYTES) throw new Error(`file exceeds ${GATE_FILE_MAX_BYTES} bytes`);
	return readFileSync(path, "utf-8") as string;
}

export function runGates(db: Db, artifactId: string): GateResult[] {
	const art = getArtifact(db, artifactId);
	if (!art) throw new Error("artifact not found");
	const gates = (art.extra["gates"] as Gate[]) ?? [];
	return gates.map((gate) => {
		switch (gate.type) {
			case "file-exists": {
				const { existsSync } = require_("node:fs");
				const exists = existsSync(gate.target);
				return { gate, passed: exists, output: exists ? "exists" : "not found" };
			}
			case "contains": {
				try {
					const content = readBoundedGateFile(gate.target);
					const found = gate.expect ? content.includes(gate.expect) : content.length > 0;
					return { gate, passed: found, output: found ? "found" : `"${gate.expect ?? ""}" not found` };
				} catch {
					return { gate, passed: false, output: "file not readable" };
				}
			}
			case "command": {
				const { execSync } = require_("node:child_process");
				try {
					const output = execSync(gate.target, { encoding: "utf-8", timeout: GATE_COMMAND_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] }).trim();
					const passed = gate.expect ? output.includes(gate.expect) : true;
					return { gate, passed, output: output.slice(0, GATE_OUTPUT_LIMIT) };
				} catch (e) {
					return { gate, passed: false, output: e instanceof Error ? e.message.slice(0, GATE_OUTPUT_LIMIT) : "command failed" };
				}
			}
			case "test": {
				const { execSync } = require_("node:child_process");
				try {
					execSync(`npx vitest run ${gate.target} --reporter=dot`, { encoding: "utf-8", timeout: GATE_TEST_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
					return { gate, passed: true, output: "tests passed" };
				} catch (e) {
					return { gate, passed: false, output: e instanceof Error ? e.message.slice(0, GATE_OUTPUT_LIMIT) : "tests failed" };
				}
			}
			default:
				return { gate, passed: false, output: `unknown gate type: ${String(gate.type)}` };
		}
	});
}

function executeGateCommand(command: string, timeout: number): Promise<{ passed: boolean; output: string }> {
	return new Promise((resolve) => {
		exec(command, { encoding: "utf8", timeout, maxBuffer: GATE_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr}`.trim().slice(0, GATE_OUTPUT_LIMIT);
			resolve({
				passed: error === null,
				output: output || (error ? error.message.slice(0, GATE_OUTPUT_LIMIT) : "ok"),
			});
		});
	});
}

function runNonProcessGate(gate: Gate): GateResult {
	if (gate.type === "file-exists") {
		const { existsSync } = require_("node:fs");
		const exists = existsSync(gate.target);
		return { gate, passed: exists, output: exists ? "exists" : "not found" };
	}
	if (gate.type === "contains") {
		try {
			const content = readBoundedGateFile(gate.target);
			const found = gate.expect ? content.includes(gate.expect) : content.length > 0;
			return { gate, passed: found, output: found ? "found" : `"${gate.expect ?? ""}" not found` };
		} catch {
			return { gate, passed: false, output: "file not readable" };
		}
	}
	return { gate, passed: false, output: `unknown gate type: ${String(gate.type)}` };
}

/** Gate runner for daemon request paths; subprocess gates never block the event loop. */
export async function runGatesAsync(db: Db, artifactId: string, options: GateRunOptions = {}): Promise<GateResult[]> {
	const art = getArtifact(db, artifactId);
	if (!art) throw new Error("artifact not found");
	const gates = (art.extra["gates"] as Gate[]) ?? [];
	const results: GateResult[] = [];
	for (const gate of gates) {
		const remainingMs = options.deadlineMs === undefined ? undefined : options.deadlineMs - Date.now();
		if (remainingMs !== undefined && remainingMs <= 0) {
			results.push({ gate, passed: false, output: "gate runtime deadline exceeded" });
			continue;
		}
		if (gate.type === "command" || gate.type === "test") {
			const command = gate.type === "test" ? `npx vitest run ${gate.target} --reporter=dot` : gate.target;
			const configuredTimeout = gate.type === "test" ? GATE_TEST_TIMEOUT_MS : GATE_COMMAND_TIMEOUT_MS;
			const timeout = remainingMs === undefined ? configuredTimeout : Math.max(1, Math.min(configuredTimeout, remainingMs));
			const executed = await executeGateCommand(command, timeout);
			results.push({
				gate,
				passed: executed.passed && (gate.expect ? executed.output.includes(gate.expect) : true),
				output: executed.output,
			});
		} else {
			results.push(runNonProcessGate(gate));
		}
	}
	return results;
}

