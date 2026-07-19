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
import type { Artifact } from "../../src/domain/artifact.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import { formatMetadata } from "./artifact-format.ts";
import { callService } from "./service-client.ts";
import { registerFacadeTools } from "./facade-tools.ts";
import type { TaskGraph } from "../../src/task-service.ts";
import { buildTaskWidgetProjection } from "./task-widget.ts";

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

class TaskOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: any | undefined;
	private snapshot: TaskGraph = { nodes: [], rootIds: [] };

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	async refresh(): Promise<void> {
		try {
			this.snapshot = await callService<Record<string, unknown>, TaskGraph>("tasks.graph", { limit: 500 });
		} catch {
			this.snapshot = { nodes: [], rootIds: [] };
		}
		this.render();
	}

	private render(): void {
		if (!this.uiCtx) return;

		// Hide widget when no tasks
		if (this.snapshot.nodes.length === 0) {
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
		const projection = buildTaskWidgetProjection(this.snapshot);
		if (projection.total === 0) return [];

		if (projection.activeTotal === 0) {
			return [truncateToWidth(theme.bold("Tasks · no active tasks · /tasks"), width, "…")];
		}

		const lines = [
			truncateToWidth(
				theme.bold(`Tasks · ${GLYPHS.active!(theme)} ${projection.activeTotal} active`),
				width,
				"…",
			),
		];
		for (const row of projection.active) {
			const hierarchy = row.depth === 0
				? row.hasActiveChildren ? "▾" : "·"
				: `${"  ".repeat(row.depth)}↳`;
			lines.push(truncateToWidth(`  ${hierarchy} ${GLYPHS.active!(theme)} ${row.task.title}`, width, "…"));
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
	registerFacadeTools(pi);

	// ── Low-level graph-store tools ────────────────────────────────────

	pi.registerTool({
		name: "papyrus_create",
		label: "Papyrus Create",
		description:
			"Create a graph artifact. KINDS: doc (knowledge — specs, decisions, research), " +
			"task (work — with gates/checklists in extra), rule (governance — when doing X, follow Y; " +
			"active rules inject into the system prompt), skill (procedural — when using X do A,B,C). " +
			"RULE extra: {condition, action, severity: 'block'|'warn'|'info'}. " +
			"TASK extra: {gates: [{type:'file-exists'|'contains'|'command'|'test', target, expect}], checklist: {'criterion': {proof: [{type:'file'|'symbol'|'code'|'test'|'command'|'artifact'|'url', target, expect}]}}}. " +
			"SKILL extra: {trigger, steps: [...], tools: [...]}. " +
			"Templates are skills with subtype='artifact-template' and extra {targetKind, defaults, required}; pass template_id to instantiate.",
		parameters: Type.Object({
			kind: Type.Optional(Type.String({ description: "doc | task | rule | skill; optional when template_id supplies targetKind" })),
			title: Type.Optional(Type.String({ description: "required unless supplied by template defaults" })),
			status: Type.Optional(Type.String({ description: "default: first registered for kind" })),
			subtype: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			template_id: Type.Optional(Type.String({ description: "skill/artifact-template id whose defaults and requirements apply" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const a = await callService<Record<string, unknown>, Artifact>("artifact.create", params);
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
				const rows = await callService<Record<string, unknown>, Artifact[]>("artifact.query", { ...params, limit: params.limit ?? 50 });
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
			"RELATIONS: references, implements, follows, depends_on, documents, blocks, supersedes, relates_to, gates, triggers, contains, part_of. " +
			"ACTIONS: link (from+relation+to), tree (id → bounded BFS subgraph), status (id+status → lifecycle).",
		parameters: Type.Object({
			action: Type.String({ description: "link | tree | status" }),
			from: Type.Optional(Type.String()),
			relation: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			depth: Type.Optional(Type.Number({ description: "tree traversal depth; bounded by a hard ceiling" })),
			max_nodes: Type.Optional(Type.Number({ description: "tree node cap; bounded by a hard ceiling" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				if (params.action === "link") {
					await callService("graph.link", { from: params.from!, relation: params.relation!, to: params.to! });
					return text(`Linked ${params.from} --${params.relation}--> ${params.to}`);
				}
				if (params.action === "tree") {
					const root = params.id ?? params.from;
					if (!root) return text("Missing id for tree");
					const a = await callService<Record<string, unknown>, Artifact | null>("graph.tree", {
						id: root,
						depth: params.depth,
						max_nodes: params.max_nodes,
					});
					if (!a) return text(`Artifact ${root} not found`);
					const edges = (a as any).edges ?? [];
					if (edges.length === 0) return text(`${a.title} — no edges`);
					return text(
						`Subgraph from ${a.title} (${edges.length} edges):\n\n${edges.map((e: any) => `  ${e.from} --${e.relation}--> ${e.to}`).join("\n")}`,
						{ edges },
					);
				}
				if (params.action === "status") {
					const a = await callService<Record<string, unknown>, Artifact | null>("graph.status", { id: params.id!, status: params.status! });
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
			depth: Type.Optional(Type.Number({ description: "edge traversal depth" })),
			max_nodes: Type.Optional(Type.Number({ description: "maximum traversed nodes" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const a = await callService<Record<string, unknown>, Artifact | null>("artifact.show", {
					id: params.id,
					tree: true,
					depth: params.depth,
					max_nodes: params.max_nodes,
				});
				if (!a) return text(`Artifact ${params.id} not found`);
				let out = `${a.id} [${a.kind}|${a.status}]\n${a.title}\n\n${a.body}`;
				if (Object.keys(a.extra).length > 0) {
					out += `\n\nMetadata:\n${formatMetadata(a.extra).map((line) => `  ${line}`).join("\n")}`;
				}
				if ((a as any).edges?.length) {
					out += `\n\nEdges:\n${(a as any).edges.map((e: any) => `  ${e.from} --${e.relation}--> ${e.to}`).join("\n")}`;
				}
				if (params.run_gates) {
					const results = await callService<Record<string, unknown>, GateResult[]>("gates.run", { id: params.id });
					out += `\n\nGates:\n${results.map((g: any) => `  ${g.passed ? "✓" : "✗"} ${g.gate.type}: ${g.gate.target} — ${g.output}`).join("\n")}`;
				}
				return text(out, { artifact: a });
			} catch (e) {
				return text(`papyrus_show failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	// ── Interactive artifact browsers ──────────────────────────────────

	// Lazy imports keep TUI components out of non-interactive startup paths.
	const [tasksModule, docsModule, rulesModule, skillsModule] = await Promise.all([
		import("./tasks.ts"),
		import("./docs.ts"),
		import("./rules.ts"),
		import("./skills.ts"),
	]);
	let overlay: TaskOverlay | undefined;

	pi.registerCommand("tasks", {
		description: "Browse and manage Papyrus tasks (interactive)",
		handler: async (_args, ctx) => {
			await tasksModule.showTasks(ctx);
			await overlay?.refresh();
		},
	});
	pi.registerCommand("docs", {
		description: "Browse and manage Papyrus documents (interactive)",
		handler: async (_args, ctx) => { await docsModule.showDocs(ctx); },
	});
	pi.registerCommand("rules", {
		description: "Browse, preview, and toggle Papyrus rules (interactive)",
		handler: async (_args, ctx) => { await rulesModule.showRules(ctx); },
	});
	pi.registerCommand("skills", {
		description: "Browse and invoke Papyrus skills and templates (interactive)",
		handler: async (_args, ctx) => { await skillsModule.showSkills(ctx); },
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
			const [rules, summary] = await Promise.all([
				callService<Record<string, unknown>, Array<Pick<Artifact, "title" | "body" | "extra">>>("rules.injectable", {}),
				callService<Record<string, unknown>, string | null>("tasks.context", {}),
			]);
			let prompt = event.systemPrompt ?? "";
			if (rules.length > 0) {
				const block = rules.map(rulesModule.ruleInjectionPreview).join("\n");
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
