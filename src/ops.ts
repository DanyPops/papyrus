/**
 * ops.ts — typed operations over the Papyrus DB.
 * Enforces the schema protocol (kinds, statuses, relations) via FK + app validation.
 */
import { createRequire } from "node:module";
import { exec } from "node:child_process";
import type { Db } from "./db.ts";
import { inTransaction } from "./db.ts";
import type { Artifact, CreateArtifactInput } from "./domain/artifact.ts";
import type { Gate, GateResult } from "./domain/gate.ts";
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
	const resolved = resolveCreateInput(db, input);
	const id = resolved.id ?? slugify(resolved.title);
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

export function updateExtra(db: Db, id: string, extra: Record<string, unknown>): Artifact | null {
	if (!getArtifact(db, id)) return null;
	const now = new Date().toISOString();
	inTransaction(db, () => {
		db.prepare("UPDATE artifacts SET extra = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(extra), now, id);
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
		const { readFileSync } = require_("node:fs");
		try {
			const content = readFileSync(gate.target, "utf-8");
			const found = gate.expect ? content.includes(gate.expect) : content.length > 0;
			return { gate, passed: found, output: found ? "found" : `"${gate.expect ?? ""}" not found` };
		} catch {
			return { gate, passed: false, output: "file not readable" };
		}
	}
	return { gate, passed: false, output: `unknown gate type: ${String(gate.type)}` };
}

/** Gate runner for daemon request paths; subprocess gates never block the event loop. */
export async function runGatesAsync(db: Db, artifactId: string): Promise<GateResult[]> {
	const art = getArtifact(db, artifactId);
	if (!art) throw new Error("artifact not found");
	const gates = (art.extra["gates"] as Gate[]) ?? [];
	const results: GateResult[] = [];
	for (const gate of gates) {
		if (gate.type === "command" || gate.type === "test") {
			const command = gate.type === "test" ? `npx vitest run ${gate.target} --reporter=dot` : gate.target;
			const timeout = gate.type === "test" ? GATE_TEST_TIMEOUT_MS : GATE_COMMAND_TIMEOUT_MS;
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

