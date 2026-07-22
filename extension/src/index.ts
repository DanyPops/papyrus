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
	CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN,
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
import { buildContextBreakdown, computeContextBudget, computeRuleBudget, estimateMessageHistoryTokens, type SessionBranchEntryLike } from "./context-budget.ts";
import { showContextView } from "./context-view.ts";
import { emitTaskFocusEvent, setTaskFocusEventBus } from "./task-focus-events.ts";
import { renderPapyrusToolCall, renderPapyrusToolResult } from "./tool-rendering/index.ts";
import {
	createArtifactDetails,
	createArtifactListDetails,
	createGraphDetails,
	createModelContent,
	createPreviewDetails,
} from "./tool-rendering/render-model.ts";

function text(value: string, details: unknown = {}) {
	const modelContent = createModelContent(value);
	return { content: [{ type: "text" as const, text: modelContent.text }], details };
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
		// Task containment is a DAG: a task with more than one parent is only ever shown once in
		// this bounded tree (under whichever parent this walk reached first). Flag it rather than
		// silently hiding that it also lives elsewhere -- see /tasks graph's composition view for
		// the full multi-parent picture.
		const multiParent = row.parentCount > 1 ? theme.fg("dim", ` ⥂${row.parentCount}`) : "";
		lines.push(truncateToWidth(`${focus} ${hierarchy} ${glyph} ${row.task.title}${multiParent}`, width, "…"));
	}
	return lines;
}

class TaskOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: any | undefined;
	private snapshot: TaskGraph = { nodes: [], rootIds: [] };
	private projectRoot: string | undefined;
	private sessionId: string | undefined;

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	setProjectRoot(projectRoot: string): void { this.projectRoot = projectRoot; }
	// Scopes the widget's "active" glyph to this Pi session's own Focus, so a second
	// concurrent agent's focused task never shows as active in this session's widget.
	setSessionId(sessionId: string): void { this.sessionId = sessionId; }

	async refresh(): Promise<void> {
		if (!this.projectRoot) return;
		try {
			this.snapshot = await callService<Record<string, unknown>, TaskGraph>("tasks.graph", { limit: 500, project_root: this.projectRoot, session_id: this.sessionId });
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
		this.sessionId = undefined;
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	setTaskFocusEventBus(pi);
	registerDomainTools(pi);
	let contextInjectionSequence = 0;
	const contextInjectionProducerId = randomUUID();
	let previousContextInjectionFingerprint: string | undefined;
	// Cached from the most recent before_agent_start observation: Pi's own base system prompt
	// is only ever visible transiently inside that hook's event.systemPrompt, so /context
	// reuses the size buildContextInjection already computes every turn rather than going
	// without it entirely.
	let lastObservedBasePromptTokens: number | null = null;
	const taskContinuation = new ActiveTaskContinuation({
		maxTurns: TASK_DRIVER_MAX_TURNS,
		maxUnchangedTurns: TASK_DRIVER_MAX_UNCHANGED_TURNS,
	});

	const driveActiveTasks = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const active = await callService<Record<string, unknown>, ActiveTaskMarker | null>("tasks.active", { project_root: ctx.cwd, session_id: sessionId });
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
				const paused = await callService<Record<string, unknown>, { artifact: Artifact; status: string }>("tasks.pause", {
					actor: "system",
					source: "task-continuation",
					reason: automaticPauseReason(decision.reason),
					session_id: sessionId,
				});
				emitTaskFocusEvent({ taskId: paused.artifact.id, sessionId, status: "paused" });
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
		renderCall(args, theme) { return renderPapyrusToolCall("Create artifact", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const a = await callService<Record<string, unknown>, Artifact>("artifact.create", {
					...params,
					...(params.kind === "task" ? { project_root: params.project_root ?? ctx.cwd } : {}),
				});
				return text(`Created ${a.id} [${a.kind}|${a.status}] ${a.title}`, createArtifactDetails("artifact.create", a));
			} catch (e) {
				throw new Error(`papyrus_create failed: ${e instanceof Error ? e.message : e}`);
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
		renderCall(args, theme) { return renderPapyrusToolCall("Query artifacts", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const rows = await callService<Record<string, unknown>, Artifact[]>("artifact.query", { ...params, limit: params.limit ?? 50 });
				if (rows.length === 0) return text("No artifacts found.", createArtifactListDetails("artifact.query", rows));
				const lines = rows.map((row, index) => `${index + 1}. ${row.id} [${row.kind}|${row.status}] ${row.title}`);
				return text(`${rows.length} artifact(s):\n\n${lines.join("\n")}`, createArtifactListDetails("artifact.query", rows));
			} catch (e) {
				throw new Error(`papyrus_query failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	pi.registerTool({
		name: "papyrus_graph",
		label: "Papyrus Graph",
		description:
			"Link artifacts with typed edges (any kind → any kind), view subgraph, update status, or read the mutation event log. " +
			"RELATIONS: references, implements, follows, depends_on, documents, blocks, supersedes, relates_to, gates, triggers, contains, part_of. " +
			"ACTIONS: link (from+relation+to), unlink (from+relation+to — idempotent, no error if already absent; for Task depends_on/contains prefer the tasks tool's undepend/uncontain), " +
			"tree (id → bounded BFS subgraph), status (id+status → lifecycle), " +
			"history (who did what, when — requires id, actor, or session_id).",
		parameters: Type.Object({
			action: Type.String({ description: "link | unlink | tree | status | history" }),
			from: Type.Optional(Type.String()),
			relation: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			depth: Type.Optional(Type.Number({ description: "tree traversal depth; bounded by a hard ceiling" })),
			max_nodes: Type.Optional(Type.Number({ description: "tree node cap; bounded by a hard ceiling" })),
			actor: Type.Optional(Type.String({ description: "history: filter by actor" })),
			session_id: Type.Optional(Type.String({ description: "history: filter by session" })),
			since: Type.Optional(Type.String({ description: "history: RFC3339 lower bound" })),
			limit: Type.Optional(Type.Number({ description: "history: bounded page size" })),
		}),
		renderCall(args, theme) { return renderPapyrusToolCall("Artifact graph", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				if (params.action === "link") {
					await callService("graph.link", { from: params.from!, relation: params.relation!, to: params.to! });
					const output = `Linked ${params.from} --${params.relation}--> ${params.to}`;
					return text(output, createPreviewDetails("graph.link", "Artifact relationship", output));
				}
				if (params.action === "unlink") {
					const result = await callService<Record<string, unknown>, { removed: boolean }>("graph.unlink", { from: params.from!, relation: params.relation!, to: params.to! });
					const output = result.removed ? `Unlinked ${params.from} --${params.relation}--> ${params.to}` : `No such relationship: ${params.from} --${params.relation}--> ${params.to}`;
					return text(output, createPreviewDetails("graph.unlink", "Artifact relationship", output));
				}
				if (params.action === "tree") {
					const root = params.id ?? params.from;
					if (!root) throw new Error("missing id for tree");
					const a = await callService<Record<string, unknown>, Artifact | null>("graph.tree", {
						id: root,
						depth: params.depth,
						max_nodes: params.max_nodes,
					});
					if (!a) throw new Error(`artifact ${root} not found`);
					const edges = a.edges ?? [];
					if (edges.length === 0) return text(`${a.title} — no edges`, createGraphDetails("graph.tree", [a], []));
					return text(
						`Subgraph from ${a.title} (${edges.length} edges):\n\n${edges.map((edge: any) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`,
						createGraphDetails("graph.tree", [a], edges),
					);
				}
				if (params.action === "status") {
					const a = await callService<Record<string, unknown>, Artifact | null>("graph.status", { id: params.id!, status: params.status! });
					if (!a) throw new Error(`artifact ${params.id} not found`);
					return text(`Updated ${a.id} → [${a.status}]`, createArtifactDetails("graph.status", a));
				}
				if (params.action === "history") {
					const page = await callService<Record<string, unknown>, { events: Array<Record<string, unknown>> }>("graph.history", {
						id: params.id, actor: params.actor, session_id: params.session_id, since: params.since, limit: params.limit,
					});
					if (page.events.length === 0) return text("No recorded events.", createPreviewDetails("graph.history", "Mutation event log", "No recorded events."));
					const output = page.events.map((event) => `${event["occurredAt"]} ${event["artifactId"]} ${event["type"]} · ${event["actor"]}/${event["source"]}`).join("\n");
					return text(output, createPreviewDetails("graph.history", "Mutation event log", output));
				}
				throw new Error(`unknown action: ${params.action}; use link, tree, status, or history`);
			} catch (e) {
				throw new Error(`papyrus_graph failed: ${e instanceof Error ? e.message : e}`);
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
		renderCall(args, theme) { return renderPapyrusToolCall("Show artifact", args, theme); },
		renderResult(result, options, theme, context) { return renderPapyrusToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const a = await callService<Record<string, unknown>, Artifact | null>("artifact.show", {
					id: params.id,
					tree: true,
					depth: params.depth,
					max_nodes: params.max_nodes,
				});
				if (!a) throw new Error(`artifact ${params.id} not found`);
				let out = `${a.id} [${a.kind}|${a.status}]\n${a.title}\n\n${a.body}`;
				if (Object.keys(a.extra).length > 0) {
					out += `\n\nMetadata:\n${formatMetadata(a.extra).map((line) => `  ${line}`).join("\n")}`;
				}
				if (a.edges?.length) {
					out += `\n\nEdges:\n${a.edges.map((edge) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`;
				}
				if (params.run_gates) {
					const results = await callService<Record<string, unknown>, GateResult[]>("gates.run", { id: params.id });
					out += `\n\nGates:\n${results.map((gate) => `  ${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n")}`;
				}
				return text(out, createArtifactDetails("artifact.show", a));
			} catch (e) {
				throw new Error(`papyrus_show failed: ${e instanceof Error ? e.message : e}`);
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
			overlay?.setSessionId(ctx.sessionManager.getSessionId());
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
	pi.registerCommand("context", {
		description: "Structured, per-segment breakdown of the context window: real usage against the model's window, drilling into Papyrus Rules and the Pi-native skill catalog",
		handler: async (_args, ctx) => {
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const [rules, openTasks] = await Promise.all([
					callService<Record<string, unknown>, Array<Pick<Artifact, "id" | "title" | "body" | "extra">>>("rules.injectable", { project_root: ctx.cwd, session_id: sessionId }),
					callService<Record<string, unknown>, Artifact[]>("tasks.list", { project_root: ctx.cwd, session_id: sessionId, limit: 200 }),
				]);
				const { skills } = computeContextBudget(rules, ctx.cwd);
				const ruleBudget = computeRuleBudget(rules);
				const usage = ctx.getContextUsage?.();
				const branch = ctx.sessionManager.getBranch() as unknown as SessionBranchEntryLike[];
				// Sized individually (title+body) so the Tasks segment can be drilled into like Rules
				// and Skills; this is a per-task approximation, not a byte-identical reproduction of
				// tasks.context's own current/next/rejected selection and rendering.
				const taskItems = openTasks
					.filter((task) => task.status !== "done" && task.status !== "canceled")
					.map((task) => ({ label: task.title, estimatedTokens: Math.ceil((task.title.length + task.body.length) / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) }));
				const breakdown = buildContextBreakdown({
					totalTokens: usage?.tokens ?? null,
					contextWindow: ctx.model?.contextWindow ?? null,
					ruleBudget,
					taskItems,
					skills,
					basePromptEstimatedTokens: lastObservedBasePromptTokens,
					messageHistoryEstimatedTokens: estimateMessageHistoryTokens(branch),
				});
				await showContextView(ctx, breakdown);
			} catch (error) {
				ctx.ui.notify(`Context breakdown failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});

	// ── Task widget (TodoOverlay pattern: factory form, requestRender) ──

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		overlay ??= new TaskOverlay();
		overlay.setUI(ctx.ui);
		overlay.setProjectRoot(ctx.cwd);
		overlay.setSessionId(ctx.sessionManager.getSessionId());
		await overlay.refresh();
	});

	pi.on("session_before_compact", () => { taskContinuation.onCompaction(); });
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

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		taskContinuation.onHumanInput();
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const focus = await callService<Record<string, unknown>, { artifact: Artifact; status: string; pauseReason?: string } | null>("tasks.focused", { session_id: sessionId });
			if (focus && shouldResumeFocusOnHumanInput(focus.status, focus.pauseReason)) {
				await callService("tasks.unpause", { actor: "system", source: "task-continuation", reason: "human input resumed automatic task continuation", session_id: sessionId });
				emitTaskFocusEvent({ taskId: focus.artifact.id, sessionId, status: "unpaused" });
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
			const sessionId = ctx.sessionManager.getSessionId();
			const [rules, summary] = await Promise.all([
				callService<Record<string, unknown>, Array<Pick<Artifact, "title" | "body" | "extra">>>("rules.injectable", { project_root: ctx.cwd, session_id: sessionId }),
				callService<Record<string, unknown>, string | null>("tasks.context", { project_root: ctx.cwd, session_id: sessionId }),
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
			lastObservedBasePromptTokens = Math.ceil(injection.observation.before.characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
			pi.events.emit(PAPYRUS_CONTEXT_INJECTION_CHANNEL, injection.observation);
			if (injection.prompt !== (event.systemPrompt ?? "")) return { systemPrompt: injection.prompt };
		} catch {
			// DB not ready
		}
	});
}
