/**
 * pi-papyrus — native Pi extension for the Papyrus graph store.
 *
 * Tools: papyrus_create/query/graph/show.
 * Command: /tasks (interactive task panel).
 * Widget: persistent task status above editor (rpiv-todo pattern).
 * Injection: active rules + open tasks appended to system prompt every turn.
 *             "Are we there yet?" — the agent sees its open work items.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	TASK_DRIVER_MAX_TURNS,
	TASK_DRIVER_MAX_UNCHANGED_TURNS,
	PAPYRUS_CONTEXT_INJECTION_CHANNEL,
} from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import { formatMetadata } from "./artifact-format.ts";
import { callService } from "./service-client.ts";
import { registerDomainTools } from "./domain-tools.ts";
import type { TaskGraph, TaskStatus } from "../../src/task-service.ts";
import { ActiveTaskContinuation, automaticPauseReason, shouldResumeFocusOnHumanInput, type ActiveTaskMarker } from "./active-task-continuation.ts";
import { buildTaskWidgetProjection, type TaskWidgetProjection } from "./task-widget.ts";
import { TASK_STATUS_PRESENTATION, taskTreeConnector } from "./task-presentation.ts";
import { buildContextInjection } from "./context-injection-telemetry.ts";

function text(t: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

// ---------------------------------------------------------------------------
// Task widget (TodoOverlay pattern from rpiv-todo: factory form, requestRender)
// ---------------------------------------------------------------------------

const WIDGET_KEY = "pi-papyrus";

export function renderTaskWidgetLines(theme: Theme, projection: TaskWidgetProjection, width: number): string[] {
	if (projection.openTotal === 0) return [];
	const lines: string[] = [theme.fg("muted", `Tasks · ${projection.scopeLabel}`)];
	for (let index = 0; index < projection.rows.length; index++) {
		const row = projection.rows[index]!;
		const laterSibling = projection.rows.slice(index + 1).some((candidate) => candidate.depth === row.depth);
		const hierarchy = taskTreeConnector({ depth: row.depth, hasChildren: row.hasOpenChildren, hasLaterSibling: laterSibling });
		const focus = row.active ? theme.fg("accent", row.focusStatus === "paused" ? "Ⅱ" : "▶") : " ";
		const presentation = TASK_STATUS_PRESENTATION[row.task.status as TaskStatus];
		const glyph = presentation ? theme.fg(presentation.color, presentation.glyph) : theme.fg("muted", "?");
		lines.push(truncateToWidth(`${focus} ${hierarchy} ${glyph} ${row.task.title}`, width, "…"));
	}
	return lines;
}

class TaskOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: any | undefined;
	private snapshot: TaskGraph = { nodes: [], rootIds: [] };
	private projectRoot: string | undefined;

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	setProjectRoot(projectRoot: string): void { this.projectRoot = projectRoot; }

	async refresh(): Promise<void> {
		if (!this.projectRoot) return;
		try {
			this.snapshot = await callService<Record<string, unknown>, TaskGraph>("tasks.graph", { limit: 500, project_root: this.projectRoot });
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
		return renderTaskWidgetLines(theme, buildTaskWidgetProjection(this.snapshot), width);
	}

	dispose(): void {
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.projectRoot = undefined;
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	registerDomainTools(pi);
	let contextInjectionSequence = 0;
	const contextInjectionProducerId = randomUUID();
	let previousContextInjectionFingerprint: string | undefined;
	const taskContinuation = new ActiveTaskContinuation({
		maxTurns: TASK_DRIVER_MAX_TURNS,
		maxUnchangedTurns: TASK_DRIVER_MAX_UNCHANGED_TURNS,
	});

	const driveActiveTasks = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		try {
			const active = await callService<Record<string, unknown>, ActiveTaskMarker | null>("tasks.active", { project_root: ctx.cwd });
			const decision = taskContinuation.evaluate(active, {
				idle: ctx.isIdle(),
				pendingMessages: ctx.hasPendingMessages(),
			});
			if (decision.action === "continue" && decision.prompt) {
				pi.sendMessage({
					customType: "papyrus-task-continuation",
					content: decision.prompt,
					display: false,
				}, { triggerTurn: true, deliverAs: "nextTurn" });
			} else if (decision.action === "pause") {
				await callService("tasks.pause", {
					actor: "system",
					source: "task-continuation",
					reason: automaticPauseReason(decision.reason),
				});
				if (ctx.hasUI) ctx.ui.notify(`Papyrus task driving paused: ${decision.reason}. Human input resumes it automatically.`, "warning");
			}
		} catch {
			// The daemon may be unavailable during startup, reload, or shutdown.
		}
	};

	// ── Low-level graph-store tools ────────────────────────────────────

	pi.registerTool({
		name: "papyrus_create",
		label: "Papyrus Create",
		description:
			"Create a graph artifact. KINDS: doc (knowledge — specs, decisions, research), " +
			"task (work — with gates/checklists in extra), rule (governance — when doing X, follow Y; " +
			"active rules inject into the system prompt), skill (parameterized workflow bundle — validated inputs render connected Tasks, Rules, and Docs). " +
			"RULE extra: {condition, action, severity: 'block'|'warn'|'info'}. " +
			"TASK extra: {gates: [{type:'file-exists'|'contains'|'command'|'test', target, expect}], checklist: {'criterion': {proof: [{type:'file'|'symbol'|'code'|'test'|'command'|'artifact'|'url', target, expect}]}}}. " +
			"Legacy SKILL extra: {trigger, steps: [...], tools: [...]}. Workflow Skill schemas are versioned separately. " +
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
			project_root: Type.Optional(Type.String({ description: "required for Tasks; defaults to Pi cwd" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const a = await callService<Record<string, unknown>, Artifact>("artifact.create", {
					...params,
					...(params.kind === "task" ? { project_root: params.project_root ?? ctx.cwd } : {}),
				});
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
	const [tasksModule, docsModule, notesModule, rulesModule, skillsModule] = await Promise.all([
		import("./tasks.ts"),
		import("./docs.ts"),
		import("./notes.ts"),
		import("./rules.ts"),
		import("./skills.ts"),
	]);
	let overlay: TaskOverlay | undefined;

	pi.registerCommand("tasks", {
		description: "Browse and manage Papyrus tasks (interactive)",
		handler: async (_args, ctx) => {
			overlay?.setProjectRoot(ctx.cwd);
			await tasksModule.showTasks(ctx);
			await overlay?.refresh();
		},
	});
	pi.registerCommand("docs", {
		description: "Browse and manage Papyrus documents (interactive)",
		handler: async (_args, ctx) => { await docsModule.showDocs(ctx); },
	});
	pi.registerCommand("note", {
		description: "Capture a deferred request directly in Papyrus",
		handler: async (args, ctx) => { await notesModule.captureNote(args, ctx); },
	});
	pi.registerCommand("notes", {
		description: "Browse and triage the project Notes inbox",
		handler: async (_args, ctx) => { await notesModule.showNotes(ctx); },
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
		overlay.setProjectRoot(ctx.cwd);
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

	// ── Keep driving active work after Pi has exhausted built-in continuations ──
	// agent_settled is intentionally later than agent_end: Pi guarantees that
	// retry, compaction retry, and queued follow-up processing have finished.

	pi.on("input", async (event) => {
		if (event.source === "extension") return;
		taskContinuation.onHumanInput();
		try {
			const focus = await callService<Record<string, never>, { status: string; pauseReason?: string } | null>("tasks.focused", {});
			if (focus && shouldResumeFocusOnHumanInput(focus.status, focus.pauseReason)) {
				await callService("tasks.unpause", { actor: "system", source: "task-continuation", reason: "human input resumed automatic task continuation" });
			}
		} catch {
			// The daemon may be unavailable during startup, reload, or shutdown.
		}
	});
	pi.on("agent_start", () => { taskContinuation.onAgentStart(); });
	pi.on("agent_settled", async (_event, ctx) => { await driveActiveTasks(ctx); });

	// ── "Are we there yet?" — inject active tasks into every turn ──────
	// The agent sees its open work items every turn. If there are rejected
	// tasks, they're explicitly called out — the agent should address them.

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const [rules, summary] = await Promise.all([
				callService<Record<string, unknown>, Array<Pick<Artifact, "title" | "body" | "extra">>>("rules.injectable", { project_root: ctx.cwd }),
				callService<Record<string, unknown>, string | null>("tasks.context", { project_root: ctx.cwd }),
			]);
			const injection = buildContextInjection({
				basePrompt: event.systemPrompt ?? "",
				rules,
				taskSummary: summary,
				observedAt: Date.now(),
				sequence: ++contextInjectionSequence,
				producerId: contextInjectionProducerId,
				previousFingerprint: previousContextInjectionFingerprint,
			});
			previousContextInjectionFingerprint = injection.observation.fingerprint;
			pi.events.emit(PAPYRUS_CONTEXT_INJECTION_CHANNEL, injection.observation);
			if (injection.prompt !== (event.systemPrompt ?? "")) return { systemPrompt: injection.prompt };
		} catch {
			// DB not ready
		}
	});
}
