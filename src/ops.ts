/**
 * ops.ts — typed operations over the Papyrus DB.
 * Enforces the schema protocol (kinds, statuses, relations) via FK + app validation.
 */
import { createRequire } from "node:module";
import type { Db } from "./db.ts";
import { inTransaction } from "./db.ts";

const require_ = createRequire(import.meta.url);

export interface Artifact {
	id: string;
	kind: string;
	title: string;
	status: string;
	subtype: string;
	body: string;
	labels: string[];
	extra: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	edges?: { from: string; relation: string; to: string }[];
}

export interface CreateInput {
	kind: string;
	title: string;
	status?: string;
	body?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	id?: string;
	subtype?: string;
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 60) + "-" + Math.random().toString(36).slice(2, 6);
}

function defaultStatusFor(db: Db, kind: string): string {
	// First-inserted status per kind (seed order defines the default)
	const row = db.prepare("SELECT name FROM statuses WHERE kind = ? ORDER BY rowid LIMIT 1").get(kind) as { name: string } | null;
	return row?.name ?? "draft";
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

export function createArtifact(db: Db, input: CreateInput): Artifact {
	const id = input.id ?? slugify(input.title);
	const status = input.status ?? defaultStatusFor(db, input.kind);
	const now = new Date().toISOString();
	const labels = JSON.stringify(input.labels ?? []);
	const extra = JSON.stringify(input.extra ?? {});
	const subtype = input.subtype ?? "";
	inTransaction(db, () => {
		const stmt = db.prepare(
			"INSERT INTO artifacts (id, kind, title, status, subtype, body, labels, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		stmt.run(id, input.kind, input.title, status, subtype, input.body ?? "", labels, extra, now, now);
	});
	return getArtifact(db, id)!;
}

export function getArtifact(db: Db, id: string, opts?: { tree?: boolean }): Artifact | null {
	const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> | null;
	if (!row) return null;
	const art = rowToArtifact(row);
	if (opts?.tree) {
		// BFS from the root artifact through all edges
		const visited = new Set<string>([id]);
		const queue = [id];
		const allEdges = db.prepare('SELECT from_id AS "from", relation, to_id AS "to" FROM edges').all() as { from: string; relation: string; to: string }[];
		const reachable = new Set<string>([id]);
		// Build adjacency from all edges
		const adj = new Map<string, { from: string; relation: string; to: string }[]>();
		for (const e of allEdges) {
			if (!adj.has(e.from)) adj.set(e.from, []);
			adj.get(e.from)!.push(e);
			if (!adj.has(e.to)) adj.set(e.to, []);
			adj.get(e.to)!.push(e);
		}
		while (queue.length) {
			const cur = queue.shift()!;
			for (const e of adj.get(cur) ?? []) {
				const other = e.from === cur ? e.to : e.from;
				if (!reachable.has(other)) {
					reachable.add(other);
					queue.push(other);
				}
			}
		}
		art.edges = allEdges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
	}
	return art;
}

export function queryArtifacts(db: Db, filter: {
	kind?: string;
	status?: string;
	text?: string;
	labels?: string[];
	limit?: number;
}): Artifact[] {
	let sql = "SELECT * FROM artifacts";
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (filter.kind) { conditions.push("kind = ?"); params.push(filter.kind); }
	if (filter.status) { conditions.push("status = ?"); params.push(filter.status); }
	if (filter.text) { conditions.push("(title LIKE ? OR body LIKE ?)"); params.push(`%${filter.text}%`, `%${filter.text}%`); }
	if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
	sql += " ORDER BY updated_at DESC";
	if (filter.limit) sql += ` LIMIT ${Math.floor(filter.limit)}`;
	const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
	return rows.map(rowToArtifact);
}

export function linkArtifacts(db: Db, fromId: string, relation: string, toId: string): void {
	const fromArt = getArtifact(db, fromId);
	const toArt = getArtifact(db, toId);
	if (!fromArt || !toArt) throw new Error("artifact not found");
	// Relation name must be registered (FK on edges.relation enforces this too)
	const allowed = db.prepare("SELECT 1 FROM relation_names WHERE name = ?").get(relation);
	if (!allowed) throw new Error(`unknown relation "${relation}" — register it first`);
	inTransaction(db, () => {
		db.prepare("INSERT OR IGNORE INTO edges (from_id, relation, to_id) VALUES (?, ?, ?)").run(fromId, relation, toId);
	});
}

export interface Gate { type: "file-exists" | "command" | "contains" | "test"; target: string; expect?: string }
export interface GateResult { gate: Gate; passed: boolean; output: string }

export function updateStatus(db: Db, id: string, status: string): Artifact | null {
	const art = getArtifact(db, id);
	if (!art) return null;
	// Validate status is registered for this kind
	const allowed = db.prepare("SELECT 1 FROM statuses WHERE kind = ? AND name = ?").get(art.kind, status);
	if (!allowed) throw new Error(`status "${status}" not registered for kind "${art.kind}"`);
	const now = new Date().toISOString();
	inTransaction(db, () => {
		db.prepare("UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
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
				const { readFileSync } = require_("node:fs");
				try {
					const content = readFileSync(gate.target, "utf-8");
					const found = gate.expect ? content.includes(gate.expect) : content.length > 0;
					return { gate, passed: found, output: found ? "found" : `"${gate.expect ?? ""}" not found` };
				} catch {
					return { gate, passed: false, output: "file not readable" };
				}
			}
			case "command": {
				const { execSync } = require_("node:child_process");
				try {
					const output = execSync(gate.target, { encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
					const passed = gate.expect ? output.includes(gate.expect) : true;
					return { gate, passed, output: output.slice(0, 200) };
				} catch (e) {
					return { gate, passed: false, output: e instanceof Error ? e.message.slice(0, 200) : "command failed" };
				}
			}
			case "test": {
				const { execSync } = require_("node:child_process");
				try {
					execSync(`npx vitest run ${gate.target} --reporter=dot`, { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
					return { gate, passed: true, output: "tests passed" };
				} catch (e) {
					return { gate, passed: false, output: e instanceof Error ? e.message.slice(0, 200) : "tests failed" };
				}
			}
			default:
				return { gate, passed: false, output: `unknown gate type: ${String(gate.type)}` };
		}
	});
}

