/**
 * pi-papyrus — native Pi extension for the Papyrus graph store.
 *
 * Tools: papyrus_query/graph/show (low-level), plus one native tool per domain (docs/rules/skills/playbooks/tasks/discuss/notes).
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
	TASK_WIDGET_POLL_INTERVAL_MS,
} from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { GateResult } from "../../src/domain/gate.ts";
import { formatMetadata } from "./artifact-format.ts";
import { callService } from "./service-client.ts";
import { registerDomainTools, resolveNameFields } from "./domain-tools.ts";
import { ensureTypingCourtesyTracking, isLiveAskPending } from "./discuss-ask-view.ts";
import { PLAYBOOK_BRIDGE_MAX_PLAYBOOKS, registerPlaybookBridge } from "./playbook-bridge.ts";
import type { TaskGraph, TaskStatus } from "../../src/task-service.ts";
import { ActiveTaskContinuation, automaticPauseReason, shouldResumeFocusOnHumanInput, type ActiveTaskMarker } from "./active-task-continuation.ts";
import { buildTaskWidgetProjection, type TaskWidgetProjection } from "./task-widget.ts";
import { TASK_STATUS_PRESENTATION, taskTreeConnector } from "./task-presentation.ts";
import { buildContextInjection } from "./context-injection-telemetry.ts";
import { buildContextBreakdown, buildMessageHistoryTree, buildTaskItemTree, computeContextBudget, computeRuleBudget, DEFAULT_RESERVE_TOKENS, type ContextSegmentItem, type SessionEntryLike, type SessionTreeNodeLike } from "./context-budget.ts";
import { buildBasePromptItems } from "./base-prompt-breakdown.ts";
import { showContextView } from "./context-view.ts";
import { emitTaskFocusEvent, setTaskFocusEventBus } from "./task-focus-events.ts";
import { cacheSessionSecret, forgetSessionSecret, sessionSecretField } from "./session-identity.ts";
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

function artifactTextLabel(artifact: Artifact): string {
	return `[${artifact.kind}|${artifact.status}] ${artifact.title}`;
}

function artifactTextLines(artifacts: readonly Artifact[]): string[] {
	const titleCounts = new Map<string, number>();
	for (const artifact of artifacts) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return artifacts.map((artifact) => titleCounts.get(artifact.title)! > 1
		? `${artifactTextLabel(artifact)} (${artifact.id})`
		: artifactTextLabel(artifact));
}

/** Resolves graph protocol ids into model-facing names; equal titles retain ids only to disambiguate. */
async function artifactNamesById(ids: readonly string[]): Promise<Map<string, string>> {
	const uniqueIds = [...new Set(ids)];
	const artifacts = (await Promise.all(uniqueIds.map((id) => callService<Record<string, unknown>, Artifact | null>("artifact.show", { id })))).filter((artifact): artifact is Artifact => artifact !== null);
	const titleCounts = new Map<string, number>();
	for (const artifact of artifacts) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return new Map(artifacts.map((artifact) => [artifact.id, titleCounts.get(artifact.title)! > 1 ? `${artifact.title} (${artifact.id})` : artifact.title]));
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

export class TaskOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: any | undefined;
	private snapshot: TaskGraph = { nodes: [], rootIds: [] };
	private projectRoot: string | undefined;
	private sessionId: string | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;

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

	/**
	 * Never throws: called from several pi.on(...) handlers, some of which (session_compact,
	 * session_tree, tool_execution_end) don't wrap it themselves -- Pi's event emitter does not
	 * guarantee catching a handler's rejection, so an unguarded throw here would become an
	 * unhandled rejection at the call site instead of a stability issue contained to this widget.
	 */
	async refresh(): Promise<void> {
		if (!this.projectRoot) return;
		try {
			this.snapshot = await callService<Record<string, unknown>, TaskGraph>("tasks.graph", { limit: 500, project_root: this.projectRoot, session_id: this.sessionId });
		} catch {
			this.snapshot = { nodes: [], rootIds: [] };
		}
		try {
			this.render();
		} catch {
			// A rendering bug must not crash the extension host over a best-effort status widget.
		}
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

	/**
	 * Fallback for a Task mutation no event announces -- the CLI run directly from a shell, or
	 * a second concurrent Pi session against the same daemon. Idempotent: a second call is a
	 * no-op rather than starting a competing timer.
	 */
	startPolling(intervalMs: number = TASK_WIDGET_POLL_INTERVAL_MS): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => { void this.refresh(); }, intervalMs);
	}

	stopPolling(): void {
		if (!this.pollTimer) return;
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	dispose(): void {
		this.stopPolling();
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
	registerPlaybookBridge(pi);
	let contextInjectionSequence = 0;
	const contextInjectionProducerId = randomUUID();
	let previousContextInjectionFingerprint: string | undefined;
	let logTurnSequence = 0;
	// Cached from the most recent before_agent_start observation: Pi's own base system prompt
	// is only ever visible transiently inside that hook's event.systemPrompt, so /context
	// reuses the size buildContextInjection already computes every turn rather than going
	// without it entirely. basePromptItems is the structural sub-breakdown built from the same
	// event's systemPromptOptions field ("Extensions can inspect this to understand what Pi
	// loaded without re-discovering resources", per Pi's own doc comment) -- no new hook, no new
	// risk, just reading a field before_agent_start already hands over.
	let lastObservedBasePromptTokens: number | null = null;
	let lastObservedBasePromptItems: ContextSegmentItem[] = [];
	const taskContinuation = new ActiveTaskContinuation({
		maxTurns: TASK_DRIVER_MAX_TURNS,
		maxUnchangedTurns: TASK_DRIVER_MAX_UNCHANGED_TURNS,
	});

	const driveActiveTasks = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		// ctx.isIdle() means "not streaming a model response" -- it reads true while a live discuss
		// ask is still genuinely pending, blocked on the human. Queuing a "continue the active task"
		// nudge here would start a second, concurrent turn reasoning about the very Discussion this
		// live ask is already resolving. See discuss-ask-view.ts's isLiveAskPending() doc comment.
		if (isLiveAskPending()) return;
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
					...sessionSecretField(sessionId),
				});
				emitTaskFocusEvent({ taskId: paused.artifact.id, sessionId, status: "paused" });
				if (ctx.hasUI) ctx.ui.notify(`Papyrus task driving paused: ${decision.reason}. Human input resumes it automatically.`, "warning");
			}
		} catch {
			// The daemon may be unavailable during startup, reload, or shutdown.
		}
	};

	// ── Post-mortem AND live: every settled turn, log a real context-usage snapshot ────
	// Deliberately lean (real usage + budget numbers only, no full segment breakdown --
	// that stays /context's job on demand) so this stays cheap enough to run every turn:
	// no extra daemon round-trips beyond the one logs.append call, no session tree walk.
	const PI_SESSION_CONTEXT_LOG_SOURCE = "pi-session-context";
	const logSessionContextSnapshot = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const usage = ctx.getContextUsage?.();
			if (!usage || usage.tokens === null) return; // nothing real to report yet (e.g. before the first assistant turn, or right after compaction)
			const totalTokens = usage.tokens;
			const sessionId = ctx.sessionManager.getSessionId();
			const effectiveBudget = Math.max(0, usage.contextWindow - DEFAULT_RESERVE_TOKENS);
			const percentOfBudget = effectiveBudget > 0 ? Math.round((totalTokens / effectiveBudget) * 1000) / 10 : null;
			await callService("logs.append", {
				source_id: PI_SESSION_CONTEXT_LOG_SOURCE,
				source_label: "Pi session context usage",
				project_root: ctx.cwd,
				level: "info",
				message: `context usage: ${totalTokens} tok / ${effectiveBudget} tok budget (${percentOfBudget}%)`,
				operation_id: `${sessionId}:${++logTurnSequence}`,
				session_id: sessionId,
				fields: { totalTokens, contextWindow: usage.contextWindow, effectiveBudget, percentOfBudget },
			});
		} catch {
			// The daemon may be unavailable during startup, reload, or shutdown -- a missed
			// snapshot is not worth surfacing to the user, matching every other best-effort
			// per-turn daemon call in this extension.
		}
	};

	// ── Low-level graph-store tools ────────────────────────────────────

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
				const lines = artifactTextLines(rows).map((line, index) => `${index + 1}. ${line}`);
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
			"Link artifacts with typed edges (any kind → any kind), view subgraph, or read the mutation event log. " +
			"RELATIONS: references, implements, follows, depends_on, documents, blocks, supersedes, relates_to, gates, triggers, contains, part_of. " +
			"ACTIONS: link (from+relation+to), unlink (from+relation+to — idempotent, no error if already absent; for Task depends_on/contains prefer the tasks tool's undepend/uncontain), " +
			"tree (id → bounded BFS subgraph), " +
			"history (who did what, when — requires id, actor, or session_id). " +
			"status (id+status) exists at the protocol level but is refused for every kind with its own lifecycle (Doc/Rule/Skill/Playbook/Task/Note all reject it) -- use that kind's own domain tool for status changes (docs.activate, rules.enable, tasks.start, etc), never this. " +
			"PREFER `from_name`/`to_name` over `from`/`to` for link/unlink -- both are backend implementation details, resolved from name automatically, searching across every kind since either end of an edge can be any artifact.",
		parameters: Type.Object({
			action: Type.String({ description: "link | unlink | tree | status | history" }),
			from: Type.Optional(Type.String()),
			from_name: Type.Optional(Type.String()),
			relation: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			to_name: Type.Optional(Type.String()),
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
		async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
			try {
				const params: Record<string, unknown> = { ...rawParams };
				if (params.action === "link" || params.action === "unlink") {
					// Kind-agnostic: either end of an edge can be a task, doc, rule, skill, or playbook.
					await resolveNameFields(params, [
						{ nameKey: "from_name", idKey: "from", listOperation: "artifact.query", baseRequest: {} },
						{ nameKey: "to_name", idKey: "to", listOperation: "artifact.query", baseRequest: {} },
					]);
				}
				if (params.action === "link") {
					await callService("graph.link", { from: params.from as string, relation: params.relation as string, to: params.to as string });
					const names = await artifactNamesById([params.from as string, params.to as string]);
					const output = `Linked "${names.get(params.from as string) ?? "unknown artifact"}" --${params.relation}--> "${names.get(params.to as string) ?? "unknown artifact"}"`;
					return text(output, createPreviewDetails("graph.link", "Artifact relationship", output));
				}
				if (params.action === "unlink") {
					const result = await callService<Record<string, unknown>, { removed: boolean }>("graph.unlink", { from: params.from as string, relation: params.relation as string, to: params.to as string });
					const names = await artifactNamesById([params.from as string, params.to as string]);
					const relationship = `"${names.get(params.from as string) ?? "unknown artifact"}" --${params.relation}--> "${names.get(params.to as string) ?? "unknown artifact"}"`;
					const output = result.removed ? `Unlinked ${relationship}` : `No such relationship: ${relationship}`;
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
					const names = await artifactNamesById(edges.flatMap((edge) => [edge.from, edge.to]));
					return text(
						`Subgraph from ${a.title} (${edges.length} edges):\n\n${edges.map((edge) => `  "${names.get(edge.from) ?? "unknown artifact"}" --${edge.relation}--> "${names.get(edge.to) ?? "unknown artifact"}"`).join("\n")}`,
						createGraphDetails("graph.tree", [a], edges),
					);
				}
				if (params.action === "status") {
					const a = await callService<Record<string, unknown>, Artifact | null>("graph.status", { id: params.id!, status: params.status! });
					if (!a) throw new Error(`artifact ${params.id} not found`);
					return text(`Updated "${a.title}" → [${a.status}]`, createArtifactDetails("graph.status", a));
				}
				if (params.action === "history") {
					const page = await callService<Record<string, unknown>, { events: Array<Record<string, unknown>> }>("graph.history", {
						id: params.id, actor: params.actor, session_id: params.session_id, since: params.since, limit: params.limit,
					});
					if (page.events.length === 0) return text("No recorded events.", createPreviewDetails("graph.history", "Mutation event log", "No recorded events."));
					const eventIds = page.events.map((event) => event["artifactId"]).filter((id): id is string => typeof id === "string");
					const names = await artifactNamesById(eventIds);
					const output = page.events.map((event) => `${event["occurredAt"]} "${typeof event["artifactId"] === "string" ? names.get(event["artifactId"]) ?? "unknown artifact" : "unknown artifact"}" ${event["type"]} · ${event["actor"]}/${event["source"]}`).join("\n");
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
				let out = `${artifactTextLabel(a)}\n\n${a.body}`;
				if (Object.keys(a.extra).length > 0) {
					out += `\n\nMetadata:\n${formatMetadata(a.extra).map((line) => `  ${line}`).join("\n")}`;
				}
				if (a.edges?.length) {
					const names = await artifactNamesById(a.edges.flatMap((edge) => [edge.from, edge.to]));
					out += `\n\nEdges:\n${a.edges.map((edge) => `  "${names.get(edge.from) ?? "unknown artifact"}" --${edge.relation}--> "${names.get(edge.to) ?? "unknown artifact"}"`).join("\n")}`;
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
	const [tasksModule, docsModule, notesModule, rulesModule, skillsModule, playbooksModule, discussModule] = await Promise.all([
		import("./tasks.ts"),
		import("./docs.ts"),
		import("./notes.ts"),
		import("./rules.ts"),
		import("./skills.ts"),
		import("./playbooks.ts"),
		import("./discuss.ts"),
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
	pi.registerCommand("playbooks", {
		description: "Browse, edit, and invoke Papyrus playbooks -- trigger/steps guidance an agent reads and follows (interactive)",
		handler: async (_args, ctx) => { await playbooksModule.showPlaybooks(ctx); },
	});
	pi.registerCommand("playbook", {
		description: "Open one Papyrus playbook directly by name (tab-completes active playbook titles) and place its invocation in the editor; no argument opens the full /playbooks browser instead",
		getArgumentCompletions: (argumentPrefix) => playbooksModule.playbookArgumentCompletions(argumentPrefix),
		handler: async (args, ctx) => { await playbooksModule.openPlaybookByName(args, ctx); },
	});
	pi.registerCommand("discuss", {
		description: "Browse Papyrus Discussions and reply, defer, resume, settle, or block/unblock a task (interactive)",
		handler: async (_args, ctx) => { await discussModule.showDiscussions(ctx); },
	});
	pi.registerCommand("context", {
		description: "Structured, per-segment breakdown of the context window: real usage against the model's window, drilling into Papyrus Rules and the Pi-native skill catalog",
		handler: async (_args, ctx) => {
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const [rules, taskGraph] = await Promise.all([
					callService<Record<string, unknown>, Array<Pick<Artifact, "id" | "title" | "body" | "extra">>>("rules.injectable", { project_root: ctx.cwd, session_id: sessionId }),
					callService<Record<string, unknown>, TaskGraph>("tasks.graph", { project_root: ctx.cwd, session_id: sessionId }),
				]);
				const { skills } = computeContextBudget(rules, ctx.cwd);
				const ruleBudget = computeRuleBudget(rules);
				const usage = ctx.getContextUsage?.();
				// Real tree (not just the linear current-branch path): surfaces content sitting in an
				// abandoned /tree branch, which cost real tokens to generate but isn't in context now.
				const tree = ctx.sessionManager.getTree() as SessionTreeNodeLike[];
				// buildContextEntries(), NOT getBranch(): getBranch() returns every raw entry on the
				// current path including everything a real compaction has already summarized away.
				// A session with 3 real compactions confirmed this made "active" message-history
				// tokens overcount the real total by over 13x -- getBranch()'s own docstring already
				// says as much ("Use buildSessionContext() to get the resolved messages for the
				// LLM"); buildContextEntries() is the compaction-aware entry list matching what the
				// LLM actually sees (the latest compaction entry itself, plus kept entries from its
				// firstKeptEntryId onward, plus everything after -- older summarized entries omitted).
				const activeEntryIds = new Set((ctx.sessionManager.buildContextEntries() as SessionEntryLike[]).map((entry) => entry.id));
				const branchEntryIds = new Set((ctx.sessionManager.getBranch() as SessionEntryLike[]).map((entry) => entry.id));
				const messageHistory = buildMessageHistoryTree(tree, activeEntryIds, branchEntryIds);
				const breakdown = buildContextBreakdown({
					totalTokens: usage?.tokens ?? null,
					contextWindow: ctx.model?.contextWindow ?? null,
					ruleBudget,
					taskItems: buildTaskItemTree(taskGraph),
					skills,
					basePromptEstimatedTokens: lastObservedBasePromptTokens,
					basePromptItems: lastObservedBasePromptItems,
					messageHistoryItems: messageHistory.items,
					messageHistoryActiveTokens: messageHistory.activeTokens,
				});
				await showContextView(ctx, breakdown);
			} catch (error) {
				ctx.ui.notify(`Context breakdown failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});

	// ── Task widget (TodoOverlay pattern: factory form, requestRender) ──

	pi.on("session_start", async (_event, ctx) => {
		// Registers this session's identity with the daemon as early as possible -- before any
		// Focus-mutating call could plausibly happen -- shrinking (not eliminating; see
		// domain/session-identity.ts) the first-touch race window. Best-effort: the daemon may be
		// unavailable during startup, and every other Focus-mutating call already tolerates an
		// unregistered/never-armored session_id (opt-in armor), so a missed registration here is
		// not worth surfacing to the user.
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const { secret } = await callService<Record<string, unknown>, { sessionId: string; secret: string }>("session.register", { session_id: sessionId });
			cacheSessionSecret(sessionId, secret);
		} catch {
			// intentionally silent -- see comment above
		}
		if (!ctx.hasUI) return;
		// Attached from session start, not lazily on first ask -- a per-ask listener would only see
		// keystrokes from the moment that tool call happens to begin, missing typing already in
		// progress when it started (the exact case Discuss's typing-courtesy wait protects against).
		ensureTypingCourtesyTracking(ctx.ui);
		overlay ??= new TaskOverlay();
		overlay.setUI(ctx.ui);
		overlay.setProjectRoot(ctx.cwd);
		overlay.setSessionId(ctx.sessionManager.getSessionId());
		await overlay.refresh();
		overlay.startPolling(TASK_WIDGET_POLL_INTERVAL_MS);
	});

	pi.on("session_before_compact", () => { taskContinuation.onCompaction(); });
	pi.on("session_compact", async () => { await overlay?.refresh(); });
	pi.on("session_tree", async () => { await overlay?.refresh(); });
	pi.on("session_shutdown", async (_event, ctx) => {
		overlay?.dispose();
		overlay = undefined;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			await callService("session.release", { session_id: sessionId, ...sessionSecretField(sessionId) });
			forgetSessionSecret(sessionId);
		} catch {
			// intentionally silent -- see session_start's comment above
		}
	});

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
				await callService("tasks.unpause", { actor: "system", source: "task-continuation", reason: "human input resumed automatic task continuation", session_id: sessionId, ...sessionSecretField(sessionId) });
				emitTaskFocusEvent({ taskId: focus.artifact.id, sessionId, status: "unpaused" });
			}
		} catch {
			// The daemon may be unavailable during startup, reload, or shutdown.
		}
	});
	pi.on("agent_start", () => { taskContinuation.onAgentStart(); });
	pi.on("agent_settled", async (_event, ctx) => {
		await driveActiveTasks(ctx);
		await logSessionContextSnapshot(ctx);
	});

	// ── "Are we there yet?" — inject active tasks into every turn ──────
	// The agent sees its open work items every turn. If there are rejected
	// tasks, they're explicitly called out — the agent should address them.

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const [rules, playbooks, summary] = await Promise.all([
				callService<Record<string, unknown>, Array<Pick<Artifact, "title" | "body" | "extra">>>("rules.injectable", { project_root: ctx.cwd, session_id: sessionId }),
				callService<Record<string, unknown>, Array<Pick<Artifact, "title" | "extra">>>("playbooks.list", { status: "active", limit: PLAYBOOK_BRIDGE_MAX_PLAYBOOKS }),
				callService<Record<string, unknown>, string | null>("tasks.context", { project_root: ctx.cwd, session_id: sessionId, verbosity: "summary" }),
			]);
			const injection = buildContextInjection({
				basePrompt: event.systemPrompt ?? "",
				rules,
				playbooks,
				taskSummary: summary,
				observedAt: Date.now(),
				sequence: ++contextInjectionSequence,
				producerId: contextInjectionProducerId,
				previousFingerprint: previousContextInjectionFingerprint,
			});
			previousContextInjectionFingerprint = injection.observation.fingerprint;
			lastObservedBasePromptTokens = Math.ceil(injection.observation.before.characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
			lastObservedBasePromptItems = buildBasePromptItems(event.systemPromptOptions, injection.observation.before.characters);
			pi.events.emit(PAPYRUS_CONTEXT_INJECTION_CHANNEL, injection.observation);
			if (injection.prompt !== (event.systemPrompt ?? "")) return { systemPrompt: injection.prompt };
		} catch {
			// DB not ready
		}
	});
}
