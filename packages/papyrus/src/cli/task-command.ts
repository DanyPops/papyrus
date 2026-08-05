import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { TASK_EXECUTION_MAX_NODES } from "../constants.ts";
import type { GateResult } from "../domain/gate.ts";
import type { OperationName } from "../service.ts";
import type { TaskExecutionPlan } from "../task/task-execution.ts";
import type { TaskBlockage, TaskCompletion } from "../task/task-service.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type TaskClient = Pick<PapyrusClient, "call">;

interface TaskContext extends CommandContext {
	readonly client: TaskClient;
	readonly json: boolean;
	readonly projectRoot: string;
}

type CliTaskLease = {
	taskId: string;
	owner: string;
	token: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
};
type CliCompletion = Omit<TaskCompletion, "artifact" | "blocked"> & {
	artifact: CliArtifact;
	blocked: Array<Omit<TaskBlockage, "artifact"> & { artifact: CliArtifact }>;
	gates: GateResult[];
};

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("value must be a JSON string array");
	return parsed as string[];
}

function parseObject(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("value must be a JSON object");
	return parsed as Record<string, unknown>;
}

function parseArray(value: string): unknown[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) throw new Error("value must be a JSON array");
	return parsed;
}

function render(this: TaskContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

function planText(plan: TaskExecutionPlan): string {
	const byId = new Map(plan.nodes.map((node) => [node.id, node]));
	const lines = ["Execution order:"];
	plan.layers.forEach((layer, index) => {
		lines.push(`  Layer ${index + 1}:`);
		for (const id of layer) {
			const node = byId.get(id);
			lines.push(node ? `    [${node.state}] ${node.id} ${node.title}` : `    [unknown] ${id}`);
		}
	});
	if (plan.layers.length === 0) lines.push("  (no tasks)");
	if (plan.cycleIds.length > 0) lines.push(`  Invalid cycle: ${plan.cycleIds.join(", ")}`);
	return lines.join("\n");
}

// -- Focus --------------------------------------------------------------------------------

const activeCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string }) {
		const active = await this.client.call<Record<string, unknown>, CliArtifact | null>("tasks.active", {
			project_root: this.projectRoot,
			session_id: flags.sessionId,
		});
		render.call(this, active, active ? `Active: ${artifactLabel(active)}` : "No active task.");
	},
	parameters: {
		flags: { sessionId: { brief: "Scope Focus to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
	},
	docs: { brief: "The current active Task" },
});

const focusedCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string }) {
		const focus = await this.client.call<Record<string, unknown>, { artifact: CliArtifact; status: "active" | "paused" } | null>(
			"tasks.focused",
			{ project_root: this.projectRoot, session_id: flags.sessionId },
		);
		render.call(this, focus, focus ? `Focused (${focus.status}): ${artifactLabel(focus.artifact)}` : "No focused task.");
	},
	parameters: {
		flags: { sessionId: { brief: "Scope Focus to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
	},
	docs: { brief: "The current focused Task and its focus status" },
});

function buildPauseUnpauseCommand(action: "pause" | "unpause") {
	return buildCommand({
		func: async function (this: TaskContext, flags: { sessionId?: string; sessionSecret?: string }) {
			const focus = await this.client.call<Record<string, unknown>, { artifact: CliArtifact; status: string }>(
				`tasks.${action}` as OperationName,
				{ actor: "user", source: "cli", session_id: flags.sessionId, session_secret: flags.sessionSecret },
			);
			render.call(this, focus, `Focused (${focus.status}): ${artifactLabel(focus.artifact)}`);
		},
		parameters: {
			flags: {
				sessionId: { brief: "Scope Focus to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true },
				sessionSecret: {
					brief: "Required once the session is registered",
					kind: "parsed",
					parse: String,
					placeholder: "secret",
					optional: true,
				},
			},
		},
		docs: { brief: `${action === "pause" ? "Pause" : "Resume"} the active Task Focus` },
	});
}

const clearFocusCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string; sessionSecret?: string }) {
		const cleared = await this.client.call<Record<string, unknown>, { cleared: boolean }>("tasks.clear_focus", {
			actor: "user",
			source: "cli",
			session_id: flags.sessionId,
			session_secret: flags.sessionSecret,
		});
		render.call(this, cleared, cleared.cleared ? "Task focus cleared." : "No focused task.");
	},
	parameters: {
		flags: {
			sessionId: { brief: "Scope Focus to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true },
			sessionSecret: {
				brief: "Required once the session is registered",
				kind: "parsed",
				parse: String,
				placeholder: "secret",
				optional: true,
			},
		},
	},
	docs: { brief: "Clear the active Task Focus" },
});

const reapStaleFocusCommand = buildCommand({
	func: async function (this: TaskContext) {
		const reaped = await this.client.call<Record<string, unknown>, { removed: number }>("tasks.reap_stale_focus", {});
		render.call(this, reaped, `Reaped ${reaped.removed} stale Focus scope(s).`);
	},
	parameters: { flags: {} },
	docs: { brief: "Reap stale Focus scopes" },
});

const focusCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string; sessionSecret?: string }, id: string) {
		const active = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.focus", {
			id,
			actor: "user",
			source: "cli",
			session_id: flags.sessionId,
			session_secret: flags.sessionSecret,
		});
		render.call(this, active, `Active: ${artifactLabel(active)}`);
	},
	parameters: {
		flags: {
			sessionId: { brief: "Scope Focus to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true },
			sessionSecret: {
				brief: "Required once the session is registered",
				kind: "parsed",
				parse: String,
				placeholder: "secret",
				optional: true,
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Set the active Task Focus to this Task" },
});

// -- Leases ---------------------------------------------------------------------------------

const claimCommand = buildCommand({
	func: async function (this: TaskContext, flags: { owner: string; ttlMs?: number; note?: string }, id: string) {
		const lease = await this.client.call<Record<string, unknown>, CliTaskLease>("tasks.claim", {
			id,
			owner: flags.owner,
			ttl_ms: flags.ttlMs,
			note: flags.note,
		});
		render.call(this, lease, `Claimed by "${lease.owner}" until ${lease.leaseExpiresAt} (token ${lease.token}).`);
	},
	parameters: {
		flags: {
			owner: { brief: "Lease owner", kind: "parsed", parse: String, placeholder: "owner" },
			ttlMs: { brief: "Lease time-to-live in milliseconds", kind: "parsed", parse: numberParser, optional: true },
			note: { brief: "Freeform note", kind: "parsed", parse: String, placeholder: "text", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Claim this Task's lease" },
});

const heartbeatLeaseCommand = buildCommand({
	func: async function (this: TaskContext, flags: { owner: string; token: string; ttlMs?: number }, id: string) {
		const lease = await this.client.call<Record<string, unknown>, CliTaskLease>("tasks.heartbeat_lease", {
			id,
			owner: flags.owner,
			token: flags.token,
			ttl_ms: flags.ttlMs,
		});
		render.call(this, lease, `Renewed until ${lease.leaseExpiresAt}.`);
	},
	parameters: {
		flags: {
			owner: { brief: "Lease owner", kind: "parsed", parse: String, placeholder: "owner" },
			token: { brief: "Lease token from claim", kind: "parsed", parse: String, placeholder: "token" },
			ttlMs: { brief: "New time-to-live in milliseconds", kind: "parsed", parse: numberParser, optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Extend this Task's lease" },
});

const releaseLeaseCommand = buildCommand({
	func: async function (this: TaskContext, flags: { owner: string; token: string }, id: string) {
		const released = await this.client.call<Record<string, unknown>, { released: boolean }>("tasks.release_lease", {
			id,
			owner: flags.owner,
			token: flags.token,
		});
		render.call(this, released, released.released ? "Lease released." : "No live lease to release.");
	},
	parameters: {
		flags: {
			owner: { brief: "Lease owner", kind: "parsed", parse: String, placeholder: "owner" },
			token: { brief: "Lease token from claim", kind: "parsed", parse: String, placeholder: "token" },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Release this Task's lease" },
});

const leaseCommand = buildCommand({
	func: async function (this: TaskContext, _flags: Record<string, never>, id: string) {
		const lease = await this.client.call<Record<string, unknown>, CliTaskLease | null>("tasks.lease", { id });
		render.call(this, lease, lease ? `Leased by "${lease.owner}" until ${lease.leaseExpiresAt}.` : "No live lease.");
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show this Task's current lease" },
});

const reapStaleLeasesCommand = buildCommand({
	func: async function (this: TaskContext) {
		const reaped = await this.client.call<Record<string, unknown>, { removed: number }>("tasks.reap_stale_leases", {});
		render.call(this, reaped, `Reaped ${reaped.removed} expired lease(s).`);
	},
	parameters: { flags: {} },
	docs: { brief: "Reap expired leases" },
});

// -- Events -------------------------------------------------------------------------------

const eventFeedCommand = buildCommand({
	func: async function (this: TaskContext, flags: { cursor?: number; limit?: number; eventTypesJson?: string[] }) {
		const page = await this.client.call<
			Record<string, unknown>,
			{ events: Array<{ id: string; occurredAt: string; taskId: string; type: string }> }
		>("tasks.event_feed", { cursor: flags.cursor, limit: flags.limit, event_types: flags.eventTypesJson });
		render.call(
			this,
			page,
			page.events.length === 0
				? "No events."
				: page.events.map((event) => `${event.id} ${event.occurredAt} ${event.taskId} ${event.type}`).join("\n"),
		);
	},
	parameters: {
		flags: {
			cursor: { brief: "Pagination cursor", kind: "parsed", parse: numberParser, optional: true },
			limit: { brief: "Maximum events to return", kind: "parsed", parse: numberParser, optional: true },
			eventTypesJson: {
				brief: "JSON string array of event types to filter by",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
		},
	},
	docs: { brief: "Feed of raw Task lifecycle events across every task" },
});

// -- CRUD -----------------------------------------------------------------------------------

const createCommand = buildCommand({
	func: async function (
		this: TaskContext,
		flags: {
			title: string;
			body?: string;
			status?: string;
			labelsJson?: string[];
			extraJson?: Record<string, unknown>;
			gatesJson?: unknown[];
			checklistJson?: Record<string, unknown>;
			templateId?: string;
			parentId?: string;
			dependsOnJson?: string[];
			sessionId?: string;
		},
	) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.create", {
			title: flags.title,
			body: flags.body,
			status: flags.status,
			labels: flags.labelsJson,
			extra: flags.extraJson,
			gates: flags.gatesJson,
			checklist: flags.checklistJson,
			template_id: flags.templateId,
			parent_id: flags.parentId,
			depends_on: flags.dependsOnJson,
			project_root: this.projectRoot,
			actor: "user",
			source: "cli",
			session_id: flags.sessionId,
		});
		render.call(this, artifact, `Created task: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {
			title: { brief: "Task title", kind: "parsed", parse: String, placeholder: "text" },
			body: { brief: "Task body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			status: { brief: "Initial status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			extraJson: { brief: "JSON object of extra fields", kind: "parsed", parse: parseObject, placeholder: "json", optional: true },
			gatesJson: { brief: "JSON array of gate definitions", kind: "parsed", parse: parseArray, placeholder: "json", optional: true },
			checklistJson: { brief: "JSON object checklist", kind: "parsed", parse: parseObject, placeholder: "json", optional: true },
			templateId: { brief: "Template to instantiate from", kind: "parsed", parse: String, placeholder: "id", optional: true },
			parentId: { brief: "Parent task id", kind: "parsed", parse: String, placeholder: "id", optional: true },
			dependsOnJson: {
				brief: "JSON string array of prerequisite task ids",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			sessionId: {
				brief: "Attribute this creation to one agent session",
				kind: "parsed",
				parse: String,
				placeholder: "id",
				optional: true,
			},
		},
	},
	docs: { brief: "Create a Task" },
});

const listCommand = buildCommand({
	func: async function (
		this: TaskContext,
		flags: {
			status?: string;
			text?: string;
			limit?: number;
			labelsJson?: string[];
			scope?: "project" | "graph" | "all";
			rootTaskId?: string;
			sessionId?: string;
		},
	) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("tasks.list", {
			status: flags.status,
			text: flags.text,
			limit: flags.limit,
			labels: flags.labelsJson,
			project_root: this.projectRoot,
			scope: flags.scope,
			root_task_id: flags.rootTaskId,
			session_id: flags.sessionId,
		});
		render.call(this, rows, rows.length === 0 ? "No tasks found." : rows.map((row) => artifactLabel(row)).join("\n"));
	},
	parameters: {
		flags: {
			status: { brief: "Filter by status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			text: { brief: "Substring match against title/body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum tasks to return", kind: "parsed", parse: numberParser, optional: true },
			labelsJson: {
				brief: "JSON string array of labels to filter by",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			scope: { brief: "project|graph|all", kind: "enum", values: ["project", "graph", "all"], optional: true },
			rootTaskId: { brief: "Root task id, required with graph scope", kind: "parsed", parse: String, placeholder: "id", optional: true },
			sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true },
		},
	},
	docs: { brief: "List Tasks" },
});

const showCommand = buildCommand({
	func: async function (this: TaskContext, _flags: Record<string, never>, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.show", { id });
		render.call(this, artifact, `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show one Task" },
});

const runGatesCommand = buildCommand({
	func: async function (this: TaskContext, _flags: Record<string, never>, id: string) {
		const results = await this.client.call<Record<string, unknown>, GateResult[]>("tasks.run_gates", { id, actor: "user", source: "cli" });
		render.call(
			this,
			results,
			results.length === 0
				? "No gates configured."
				: results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n"),
		);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Run a Task's configured gates without transitioning its status" },
});

const setChecklistCommand = buildCommand({
	func: async function (this: TaskContext, flags: { checklistJson: Record<string, unknown> }, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.set_checklist", {
			id,
			checklist: flags.checklistJson,
		});
		render.call(this, artifact, `Updated checklist: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: { checklistJson: { brief: "JSON object checklist", kind: "parsed", parse: parseObject, placeholder: "json" } },
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Task's evidence-bearing checklist" },
});

const setGatesCommand = buildCommand({
	func: async function (this: TaskContext, flags: { gatesJson: unknown[] }, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.set_gates", { id, gates: flags.gatesJson });
		render.call(this, artifact, `Updated gates: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: { gatesJson: { brief: "JSON array of gate definitions", kind: "parsed", parse: parseArray, placeholder: "json" } },
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Task's gate commands" },
});

const contextCommand = buildCommand({
	func: async function (this: TaskContext, flags: { scope?: "project" | "graph" | "all"; rootTaskId?: string; sessionId?: string }) {
		const summary = await this.client.call<Record<string, unknown>, string | null>("tasks.context", {
			project_root: this.projectRoot,
			scope: flags.scope,
			root_task_id: flags.rootTaskId,
			session_id: flags.sessionId,
		});
		render.call(this, summary, summary ?? "No open tasks.");
	},
	parameters: {
		flags: {
			scope: { brief: "project|graph|all", kind: "enum", values: ["project", "graph", "all"], optional: true },
			rootTaskId: { brief: "Root task id, required with graph scope", kind: "parsed", parse: String, placeholder: "id", optional: true },
			sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true },
		},
	},
	docs: { brief: "The full plan-reconciliation context" },
});

function buildContainmentCommand(operation: OperationName, human: (artifact: CliArtifact, second: string) => string, brief: string) {
	return buildCommand({
		func: async function (this: TaskContext, flags: { reason?: string; sessionId?: string }, parentId: string, childId: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(operation, {
				parent_id: parentId,
				child_id: childId,
				actor: "user",
				source: "cli",
				reason: flags.reason,
				session_id: flags.sessionId,
			});
			render.call(this, artifact, human(artifact, childId));
		},
		parameters: {
			flags: {
				reason: { brief: "Why this change was made", kind: "parsed", parse: String, placeholder: "text", optional: true },
				sessionId: {
					brief: "Attribute this change to one agent session",
					kind: "parsed",
					parse: String,
					placeholder: "id",
					optional: true,
				},
			},
			positional: {
				kind: "tuple",
				parameters: [
					{ brief: "Parent task id", parse: String, placeholder: "parent-id" },
					{ brief: "Child task id", parse: String, placeholder: "child-id" },
				],
			},
		},
		docs: { brief },
	});
}

const updateCommand = buildCommand({
	func: async function (
		this: TaskContext,
		flags: { title?: string; body?: string; labelsJson?: string[]; status?: string; reason?: string },
		id: string,
	) {
		if (flags.status !== undefined && flags.status !== "todo")
			throw new Error("tasks update --status only supports todo for accidental creation recovery");
		const recovering = flags.status === "todo";
		if (flags.title === undefined && flags.body === undefined && flags.labelsJson === undefined && !recovering)
			throw new Error("tasks update requires --title, --body, --labels-json, or --status todo");
		if (recovering && !flags.reason?.trim()) throw new Error("tasks update --status requires --reason");
		if (flags.reason !== undefined && !recovering) throw new Error("tasks update --reason requires --status todo");
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.update", {
			id,
			title: flags.title,
			body: flags.body,
			labels: flags.labelsJson,
			...(recovering ? { status: flags.status } : {}),
			reason: flags.reason,
			actor: "user",
			source: "cli",
		});
		render.call(this, artifact, `Updated: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {
			title: { brief: "New title", kind: "parsed", parse: String, placeholder: "text", optional: true },
			body: { brief: "New body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			status: {
				brief: "Only 'todo', to recover from an accidental terminal state",
				kind: "parsed",
				parse: String,
				placeholder: "status",
				optional: true,
			},
			reason: { brief: "Required alongside --status todo", kind: "parsed", parse: String, placeholder: "text", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Recover an accidentally-terminal task, or change its title/body/labels" },
});

const historyCommand = buildCommand({
	func: async function (this: TaskContext, _flags: Record<string, never>, id: string) {
		const page = await this.client.call<
			{ id: string; direction: "desc" },
			{
				events: Array<{
					occurredAt: string;
					type: string;
					fromStatus?: string;
					toStatus?: string;
					actor: string;
					source: string;
					reason?: string;
				}>;
			}
		>("tasks.history", { id, direction: "desc" });
		render.call(
			this,
			page,
			page.events.length === 0
				? `No recorded history for ${id}.`
				: [...page.events]
						.reverse()
						.map(
							(event) =>
								`${event.occurredAt} ${event.type} ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"} · ${event.actor}/${event.source}${event.reason ? ` · ${event.reason}` : ""}`,
						)
						.join("\n"),
		);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Task's append-only lifecycle event history" },
});

const scopeCommand = buildCommand({
	func: async function (this: TaskContext, _flags: Record<string, never>, mode?: string, rootTaskId?: string) {
		if (mode === undefined) {
			const selection = await this.client.call<Record<string, string>, { mode: string; label: string }>("tasks.scope", {
				project_root: this.projectRoot,
			});
			render.call(this, selection, `Task scope: ${selection.label}`);
			return;
		}
		if (mode !== "project" && mode !== "all" && mode !== "graph") throw new Error("tasks scope mode must be project, all, or graph");
		if (mode === "graph" && !rootTaskId) throw new Error("tasks scope graph requires a root task id");
		if (mode !== "graph" && rootTaskId) throw new Error(`tasks scope ${mode} accepts no root task id`);
		const selection = await this.client.call<Record<string, unknown>, { mode: string; label: string }>("tasks.set_scope", {
			project_root: this.projectRoot,
			scope: mode,
			root_task_id: rootTaskId,
		});
		render.call(this, selection, `Task scope: ${selection.label}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "project|all|graph", parse: String, placeholder: "mode", optional: true },
				{ brief: "Root task id, required with graph mode", parse: String, placeholder: "root-task-id", optional: true },
			],
		},
	},
	docs: { brief: "Describe or set the task-view scope" },
});

const assignProjectCommand = buildCommand({
	func: async function (this: TaskContext, _flags: Record<string, never>, id: string, projectRoot?: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.assign_project", {
			id,
			project_root: projectRoot ?? this.projectRoot,
			actor: "user",
			source: "cli",
		});
		render.call(this, artifact, `Project assigned: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Task id", parse: String, placeholder: "id" },
				{ brief: "New project root, defaults to the caller's own", parse: String, placeholder: "project-root", optional: true },
			],
		},
	},
	docs: { brief: "Reassign a Task's project root" },
});

const graphCommand = buildCommand({
	func: async function (
		this: TaskContext,
		flags: { labelsJson?: string[]; scope?: "project" | "graph" | "all"; rootTaskId?: string; sessionId?: string },
	) {
		const graph = await this.client.call<
			Record<string, unknown>,
			{ nodes: Array<{ dependencyIds: string[]; childIds: string[] }>; rootIds: string[] }
		>("tasks.graph", {
			limit: TASK_EXECUTION_MAX_NODES + 1,
			labels: flags.labelsJson,
			project_root: this.projectRoot,
			scope: flags.scope,
			root_task_id: flags.rootTaskId,
			session_id: flags.sessionId,
		});
		const dependencies = graph.nodes.reduce((count, node) => count + node.dependencyIds.length, 0);
		const children = graph.nodes.reduce((count, node) => count + node.childIds.length, 0);
		render.call(
			this,
			graph,
			`Task graph: ${graph.nodes.length} nodes, ${graph.rootIds.length} roots, ${dependencies} dependencies, ${children} containment edges`,
		);
	},
	parameters: {
		flags: {
			labelsJson: {
				brief: "JSON string array of labels to filter by",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			scope: { brief: "project|graph|all", kind: "enum", values: ["project", "graph", "all"], optional: true },
			rootTaskId: { brief: "Root task id, required with graph scope", kind: "parsed", parse: String, placeholder: "id", optional: true },
			sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true },
		},
	},
	docs: { brief: "The full task graph" },
});

const planCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string }) {
		const plan = await this.client.call<Record<string, unknown>, TaskExecutionPlan>("tasks.plan", {
			project_root: this.projectRoot,
			session_id: flags.sessionId,
		});
		render.call(this, plan, planText(plan));
	},
	parameters: {
		flags: { sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
	},
	docs: { brief: "Layered execution order for the task graph" },
});

const completeCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string }, id: string) {
		const completion = await this.client.call<Record<string, unknown>, CliCompletion>("tasks.complete", {
			id,
			actor: "user",
			source: "cli",
			session_id: flags.sessionId,
		});
		const lines = [`${completion.completed ? "Completed" : "Rejected"}: ${artifactLabel(completion.artifact)}`];
		if (completion.focused) lines.push(`Active: ${artifactLabel(completion.focused)}`);
		if (completion.blocked.length > 0) {
			lines.push(
				`Blocked: ${completion.blocked.map((entry) => `${artifactLabel(entry.artifact)} waits for ${entry.dependencyIds.join(", ")}`).join("; ")}`,
			);
		}
		for (const gate of completion.gates) lines.push(`${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`);
		render.call(this, completion, lines.join("\n"));
	},
	parameters: {
		flags: { sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Run gates and checklist review, then complete" },
});

const startCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string }, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("tasks.start", {
			id,
			actor: "user",
			source: "cli",
			session_id: flags.sessionId,
		});
		render.call(this, artifact, `Started: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: { sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Lifecycle transition: todo -> in-progress" },
});

function buildSimpleTransitionCommand(action: "submit" | "reject" | "retry" | "cancel", brief: string) {
	return buildCommand({
		func: async function (this: TaskContext, flags: { sessionId?: string }, id: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(`tasks.${action}` as OperationName, {
				id,
				actor: "user",
				source: "cli",
				session_id: flags.sessionId,
			});
			render.call(this, artifact, `${action[0]!.toUpperCase()}${action.slice(1)}: ${artifactLabel(artifact)}`);
		},
		parameters: {
			flags: { sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
			positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
		},
		docs: { brief },
	});
}

const cancelSubtreeCommand = buildCommand({
	func: async function (this: TaskContext, flags: { sessionId?: string }, id: string) {
		const outcome = await this.client.call<Record<string, unknown>, { canceled: string[]; skipped: string[] }>("tasks.cancel_subtree", {
			id,
			actor: "user",
			source: "cli",
			session_id: flags.sessionId,
		});
		render.call(
			this,
			outcome,
			`Canceled ${outcome.canceled.length} task(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-terminal` : ""}.`,
		);
	},
	parameters: {
		flags: { sessionId: { brief: "Scope to one agent session", kind: "parsed", parse: String, placeholder: "id", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Task id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Cancel a Task and its whole containment subtree" },
});

function buildDependencyCommand(operation: OperationName, human: (artifact: CliArtifact, second: string) => string, brief: string) {
	return buildCommand({
		func: async function (this: TaskContext, flags: { reason?: string; sessionId?: string }, id: string, dependencyId: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(operation, {
				id,
				dependency_id: dependencyId,
				actor: "user",
				source: "cli",
				reason: flags.reason,
				session_id: flags.sessionId,
			});
			render.call(this, artifact, human(artifact, dependencyId));
		},
		parameters: {
			flags: {
				reason: { brief: "Why this change was made", kind: "parsed", parse: String, placeholder: "text", optional: true },
				sessionId: {
					brief: "Attribute this change to one agent session",
					kind: "parsed",
					parse: String,
					placeholder: "id",
					optional: true,
				},
			},
			positional: {
				kind: "tuple",
				parameters: [
					{ brief: "Task id", parse: String, placeholder: "id" },
					{ brief: "Prerequisite task id", parse: String, placeholder: "prerequisite-id" },
				],
			},
		},
		docs: { brief },
	});
}

const app = buildApplication(
	buildRouteMap({
		routes: {
			active: activeCommand,
			focused: focusedCommand,
			pause: buildPauseUnpauseCommand("pause"),
			unpause: buildPauseUnpauseCommand("unpause"),
			"clear-focus": clearFocusCommand,
			"reap-stale-focus": reapStaleFocusCommand,
			claim: claimCommand,
			"heartbeat-lease": heartbeatLeaseCommand,
			"release-lease": releaseLeaseCommand,
			lease: leaseCommand,
			"reap-stale-leases": reapStaleLeasesCommand,
			"event-feed": eventFeedCommand,
			create: createCommand,
			list: listCommand,
			show: showCommand,
			"run-gates": runGatesCommand,
			"set-checklist": setChecklistCommand,
			"set-gates": setGatesCommand,
			context: contextCommand,
			contain: buildContainmentCommand(
				"tasks.contain",
				(artifact, second) => `Contained: ${second} → ${artifactLabel(artifact)}`,
				"Nest a child Task inside a parent",
			),
			uncontain: buildContainmentCommand(
				"tasks.uncontain",
				(artifact, second) => `Removed ${second} from ${artifactLabel(artifact)}`,
				"Remove a parent/child nesting",
			),
			update: updateCommand,
			history: historyCommand,
			scope: scopeCommand,
			"assign-project": assignProjectCommand,
			focus: focusCommand,
			graph: graphCommand,
			plan: planCommand,
			complete: completeCommand,
			start: startCommand,
			submit: buildSimpleTransitionCommand("submit", "Lifecycle transition: in-progress -> review"),
			reject: buildSimpleTransitionCommand("reject", "Lifecycle transition: review -> rejected"),
			retry: buildSimpleTransitionCommand("retry", "Lifecycle transition: rejected -> in-progress"),
			cancel: buildSimpleTransitionCommand("cancel", "Lifecycle transition to canceled"),
			"cancel-subtree": cancelSubtreeCommand,
			depend: buildDependencyCommand(
				"tasks.depend",
				(artifact, second) => `Dependency added: ${artifactLabel(artifact)} waits for ${second}`,
				"Add a dependency edge",
			),
			undepend: buildDependencyCommand(
				"tasks.undepend",
				(artifact, second) => `Dependency removed: ${artifactLabel(artifact)} no longer waits for ${second}`,
				"Remove a dependency edge",
			),
		},
		docs: { brief: "Task operations" },
	}),
	{ name: "tasks", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runTaskCli(args: string[], client: TaskClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json, projectRoot });
}
