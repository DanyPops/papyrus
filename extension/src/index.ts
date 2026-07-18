/**
 * pi-papyrus — native Pi extension for the Papyrus graph store.
 *
 * Tools: papyrus_create/query/graph/show.
 * Command: /tasks (interactive task panel).
 * Widget: persistent task status above editor (rpiv-todo pattern).
 * Injection: active rules + open tasks appended to system prompt every turn.
 *             "Are we there yet?" — the agent sees its open work items.
 */
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { dbPath } from "../../src/constants.ts";
import type { Db } from "../../src/db.ts";
import { taskContextFromDb } from "./task-context.ts";

async function withDb<T>(fn: (db: Db) => T): Promise<T> {
	const { openDb } = await import("../../src/db.ts");
	const db = openDb(dbPath());
	try { return fn(db); } finally { db.close(); }
}

function text(t: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

// ---------------------------------------------------------------------------
// Task widget (TodoOverlay pattern from rpiv-todo: factory form, requestRender)
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, (theme: Theme) => string> = {
	pending:   (t) => t.fg("dim", "○"),
	active:    (t) => t.fg("warning", "●"),
	done:      (t) => t.fg("success", "■"),
	failed:    (t) => t.fg("error", "▲"),
};

const WIDGET_KEY = "pi-papyrus";
const MAX_WIDGET_LINES = 12;

interface TaskSnapshot {
	id: string;
	title: string;
	status: string;
}

class TaskOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: any | undefined;
	private snapshot: TaskSnapshot[] = [];

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	async refresh(): Promise<void> {
		try {
			const rows: TaskSnapshot[] = await withDb((db: any) =>
				db.prepare("SELECT id, title, status FROM artifacts WHERE kind = 'task' ORDER BY updated_at DESC").all()
			);
			this.snapshot = rows;
		} catch {
			this.snapshot = [];
		}
		this.render();
	}

	private render(): void {
		if (!this.uiCtx) return;

		// Hide widget when no tasks
		if (this.snapshot.length === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui: any, theme: Theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderLines(theme, width),
						invalidate: () => {
							// Theme changed — force re-registration
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender?.();
		}
	}

	private renderLines(theme: Theme, width: number): string[] {
		const visible = this.snapshot.filter((t) => t.status !== "deleted");
		if (visible.length === 0) return [];

		const lines: string[] = [];
		const counts: Record<string, number> = {};
		for (const t of visible) counts[t.status] = (counts[t.status] ?? 0) + 1;
		const summary = ["pending", "active", "done", "failed"]
			.filter((s) => (counts[s] ?? 0) > 0)
			.map((s) => `${GLYPHS[s]?.(theme) ?? s} ${counts[s]}`)
			.join(" · ");
		lines.push(truncateToWidth(theme.bold(`Tasks · ${summary}`), width, "…"));

		// Show active tasks + next pending (capped at MAX_WIDGET_LINES)
		const active = visible.filter((t) => t.status === "active");
		const pending = visible.filter((t) => t.status === "pending");
		const show = [...active, ...pending.slice(0, Math.max(0, MAX_WIDGET_LINES - active.length - 1))];
		for (const t of show) {
			const glyph = GLYPHS[t.status]?.(theme) ?? "?";
			lines.push(truncateToWidth(`  ${glyph} ${t.title}`, width, "…"));
		}

		return lines;
	}

	dispose(): void {
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

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
			"TASK extra: {gates: [{type:'file-exists'|'contains'|'command'|'test', target, expect}], checklist: ['item']}. " +
			"SKILL extra: {trigger, steps: [...], tools: [...]}.",
		parameters: Type.Object({
			kind: Type.String({ description: "doc | task | rule | skill" }),
			title: Type.String(),
			status: Type.Optional(Type.String({ description: "default: first registered for kind" })),
			subtype: Type.Optional(Type.String()),
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
			"Link artifacts with typed edges (any kind → any kind), view subgraph, or update status. " +
			"RELATIONS: references, implements, follows, depends_on, documents, blocks, supersedes, relates_to, gates, triggers. " +
			"ACTIONS: link (from+relation+to), tree (id → BFS subgraph), status (id+status → lifecycle).",
		parameters: Type.Object({
			action: Type.String({ description: "link | tree | status" }),
			from: Type.Optional(Type.String()),
			relation: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
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
					return text(
						`Subgraph from ${a.title} (${edges.length} edges):\n\n${edges.map((e: any) => `  ${e.from} --${e.relation}--> ${e.to}`).join("\n")}`,
						{ edges },
					);
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

	// ── /tasks command ─────────────────────────────────────────────────

	// Lazy import: showTasks uses ctx.ui.custom which needs pi-tui at runtime
	const { showTasks } = await import("./tasks.ts");
	let overlay: TaskOverlay | undefined;

	pi.registerCommand("tasks", {
		description: "Browse and manage Papyrus tasks (interactive)",
		handler: async (_args, ctx) => {
			await showTasks(ctx);
			await overlay?.refresh();
		},
	});

	// ── Task widget (TodoOverlay pattern: factory form, requestRender) ──

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		overlay ??= new TaskOverlay();
		overlay.setUI(ctx.ui);
		await overlay.refresh();
	});

	pi.on("session_compact", async () => { await overlay?.refresh(); });
	pi.on("session_tree", async () => { await overlay?.refresh(); });
	pi.on("session_shutdown", async () => { overlay?.dispose(); overlay = undefined; });

	// Update widget after any papyrus tool call
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName.startsWith("papyrus_") || event.toolName === "tasks") {
			await overlay?.refresh();
		}
	});

	// ── "Are we there yet?" — inject active tasks into every turn ──────
	// The agent sees its open work items every turn. If there are failed
	// tasks, they're explicitly called out — the agent should address them.

	pi.on("before_agent_start", async (event, _ctx) => {
		try {
			const [rules, summary] = await withDb((db) => [
				injectableRules(db),
				taskContextFromDb(db),
			]);
			let prompt = event.systemPrompt ?? "";
			if (rules.length > 0) {
				const block = rules.map((r) => {
					const cond = r.extra["condition"] ? ` (when: ${r.extra["condition"]})` : "";
					return `\u2022 ${r.title}${cond}\n  ${r.body || r.extra["action"] || ""}`;
				}).join("\n");
				prompt += `\n\n## Active rules (Papyrus)\n\n${block}\n`;
			}
			if (summary) {
				prompt += `\n\n## Open tasks (Papyrus)\n\n${summary}\n`;
			}
			if (prompt !== (event.systemPrompt ?? "")) {
				return { systemPrompt: prompt };
			}
		} catch {
			// DB not ready
		}
	});
}
