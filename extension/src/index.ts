/**
 * pi-papyrus — native Pi extension for the Papyrus graph store.
 *
 * Four tools (create/query/graph/show) + rule injection (before_agent_start)
 * + session-start widget. In-process SQLite (dual-runtime).
 *
 * Rules with status "active" are injected into the system prompt on every
 * agent turn — Papyrus IS the structured, cross-referenced AGENTS.md.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function dbPath(): string {
	const xdg = process.env["XDG_DATA_HOME"] || `${process.env["HOME"]}/.local/share`;
	return `${xdg}/papyrus/papyrus.db`;
}

async function withDb<T>(fn: (db: any) => T): Promise<T> {
	const { openDb } = await import("../../src/db.ts");
	const db = openDb(dbPath());
	try { return fn(db); } finally { db.close(); }
}

function text(t: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

export default async function (pi: ExtensionAPI) {
	const { createArtifact, queryArtifacts, getArtifact, linkArtifacts, runGates, updateStatus, injectableRules } =
		await import("../../src/ops.ts");

	// ── Tools ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "papyrus_create",
		label: "Papyrus Create",
		description:
			"Create a graph artifact. KINDS: doc (knowledge — specs, decisions, research), " +
			"task (work — with gates/checklists in extra), rule (governance — when doing X, follow Y; " +
			"active rules inject into the system prompt), skill (procedural — when using X do A,B,C). " +
			"RULE extra: {condition, action, severity: 'block'|'warn'|'info'}. " +
			"TASK extra: {gates: [{type:'file-exists'|'contains'|'command'|'test', target, expect}], checklist: ['item']} " +
			"SKILL extra: {trigger, steps: [...], tools: [...]}.",
		parameters: Type.Object({
			kind: Type.String({ description: "doc | task | rule | skill" }),
			title: Type.String(),
			status: Type.Optional(Type.String({ description: "default: draft/pending/active/active" })),
			subtype: Type.Optional(Type.String({ description: "doc: knowledge|spec|decision|design; task: goal|step" })),
			body: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const a = await withDb((db) => createArtifact(db, params));
				return text(`Created ${a.id} [${a.kind}|${a.status}] ${a.title}`, { id: a.id });
			} catch (e) {
				return text(`papyrus_create failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	pi.registerTool({
		name: "papyrus_query",
		label: "Papyrus Query",
		description: "Query artifacts by kind, status, or full-text search.",
		parameters: Type.Object({
			kind: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			text: Type.Optional(Type.String({ description: "substring across title and body" })),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const rows = await withDb((db) => queryArtifacts(db, { ...params, limit: params.limit ?? 50 }));
				if (rows.length === 0) return text("No artifacts found.");
				const lines = rows.map((r: any, i: number) => `${i + 1}. ${r.id} [${r.kind}|${r.status}] ${r.title}`);
				return text(`${rows.length} artifact(s):\n\n${lines.join("\n")}`, { rows });
			} catch (e) {
				return text(`papyrus_query failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	pi.registerTool({
		name: "papyrus_graph",
		label: "Papyrus Graph",
		description:
			"Link artifacts with typed edges (any kind → any kind), or view the subgraph from an artifact. " +
			"RELATIONS: references, implements, follows, depends_on, documents, blocks, supersedes, relates_to, gates, triggers. " +
			"ACTIONS: link (from+relation+to), tree (id → BFS subgraph), status (id+status → update lifecycle).",
		parameters: Type.Object({
			action: Type.String({ description: "link | tree | status" }),
			from: Type.Optional(Type.String()),
			relation: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			id: Type.Optional(Type.String({ description: "artifact ID (tree, status)" })),
			status: Type.Optional(Type.String({ description: "new status (status action)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				if (params.action === "link") {
					await withDb((db) => linkArtifacts(db, params.from!, params.relation!, params.to!));
					return text(`Linked ${params.from} --${params.relation}--> ${params.to}`);
				}
				if (params.action === "tree") {
					const root = params.id ?? params.from;
					if (!root) return text("Missing id for tree");
					const a = await withDb((db) => getArtifact(db, root, { tree: true }));
					if (!a) return text(`Artifact ${root} not found`);
					const edges = (a as any).edges ?? [];
					if (edges.length === 0) return text(`${a.title} — no edges`);
					return text(`Subgraph from ${a.title} (${edges.length} edges):\n\n` +
						edges.map((e: any) => `  ${e.from} --${e.relation}--> ${e.to}`).join("\n"), { edges });
				}
				if (params.action === "status") {
					const a = await withDb((db) => updateStatus(db, params.id!, params.status!));
					if (!a) return text(`Artifact ${params.id} not found`);
					return text(`Updated ${a.id} → [${a.status}]`, { artifact: a });
				}
				return text(`Unknown action: ${params.action}. Use 'link', 'tree', or 'status'.`);
			} catch (e) {
				return text(`papyrus_graph failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	pi.registerTool({
		name: "papyrus_show",
		label: "Papyrus Show",
		description: "Show one artifact with body, edges, and optionally run its gates.",
		parameters: Type.Object({
			id: Type.String(),
			run_gates: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const a = await withDb((db) => getArtifact(db, params.id, { tree: true }));
				if (!a) return text(`Artifact ${params.id} not found`);
				let out = `${a.id} [${a.kind}|${a.status}]\n${a.title}\n\n${a.body}`;
				if ((a as any).edges?.length) {
					out += `\n\nEdges:\n${(a as any).edges.map((e: any) => `  ${e.from} --${e.relation}--> ${e.to}`).join("\n")}`;
				}
				if (params.run_gates) {
					const results = await withDb((db) => runGates(db, params.id));
					out += `\n\nGates:\n${results.map((g: any) => `  ${g.passed ? "✓" : "✗"} ${g.gate.type}: ${g.gate.target} — ${g.output}`).join("\n")}`;
				}
				return text(out, { artifact: a });
			} catch (e) {
				return text(`papyrus_show failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	// ── Rule injection: Papyrus IS the structured AGENTS.md ────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		try {
			const rules = await withDb((db) => injectableRules(db));
			if (rules.length === 0) return;
			const block = rules.map((r) => {
				const cond = r.extra["condition"] ? ` (when: ${r.extra["condition"]})` : "";
				return `• ${r.title}${cond}\n  ${r.body || r.extra["action"] || ""}`;
			}).join("\n");
			return {
				systemPrompt: (event.systemPrompt ?? "") + `\n\n## Active rules (Papyrus)\n\n${block}\n`,
			};
		} catch {
			// DB not ready — no rules to inject
		}
	});

	// ── Widget: artifact count on session start ────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const count = await withDb((db) => db.prepare("SELECT COUNT(*) AS c FROM artifacts").get());
			const n = (count as { c: number })?.c ?? 0;
			ctx.ui.setWidget("pi-papyrus", [
				ctx.ui.theme.bold("Papyrus"),
				ctx.ui.theme.fg("dim", `${n} artifact(s) in the graph`),
			], { placement: "aboveEditor" });
		} catch {
			// DB not created yet
		}
	});
}
