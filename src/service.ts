import { SERVICE_MAX_BODY_BYTES, SQLITE_SCHEMA_VERSION } from "./constants.ts";
import { VERSION } from "./version.ts";
import { migrateDb, openDb, schemaVersion } from "./db.ts";
import { SQLiteArtifactStore } from "./adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "./adapters/sqlite-gate-runner.ts";
import { SQLiteTaskFocusStore } from "./adapters/sqlite-task-focus-store.ts";
import { SQLiteTaskEventStore } from "./adapters/sqlite-task-event-store.ts";
import { SQLiteTaskScopeStore } from "./adapters/sqlite-task-scope-store.ts";
import type { CreateArtifactInput } from "./domain/artifact.ts";
import type { Checklist } from "./domain/checklist.ts";
import type { TaskEventContext, TaskEventDirection } from "./domain/task-event.ts";
import type { TaskViewMode } from "./domain/task-scope.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { GateRunner } from "./ports/gate-runner.ts";
import type { TaskEventStore } from "./ports/task-event-store.ts";
import type { TaskScopeStore } from "./ports/task-scope-store.ts";
import { projectTaskExecution } from "./task-execution.ts";
import { Tasks, type TaskStatus } from "./task-service.ts";
import {
	createArtifactTemplate,
	createDocument,
	createRule,
	createSkill,
	linkDocument,
	gateTaskWithRule,
	instantiateTemplate,
	listDocuments,
	listRules,
	listInjectableRules,
	listSkills,
	previewRule,
	showDocument,
	showRule,
	showSkill,
	skillInvocation,
	transitionDocument,
	transitionRule,
	transitionSkill,
	type DocumentRelation,
} from "./domain-services.ts";
import { taskContext } from "./task-context.ts";
import { instantiateSkillWorkflow } from "./skill-execution.ts";
import { Notes, type NoteDisposition } from "./note-service.ts";

export const EXPECTED_OPERATION_NAMES = [
	"system.migrate",
	"artifact.create",
	"artifact.query",
	"artifact.show",
	"graph.link",
	"graph.tree",
	"graph.status",
	"gates.run",
	"rules.injectable",
	"tasks.create",
	"tasks.update",
	"tasks.list",
	"tasks.graph",
	"tasks.plan",
	"tasks.show",
	"tasks.history",
	"tasks.scope",
	"tasks.set_scope",
	"tasks.assign_project",
	"tasks.active",
	"tasks.focused",
	"tasks.focus",
	"tasks.pause",
	"tasks.unpause",
	"tasks.clear_focus",
	"tasks.start",
	"tasks.submit",
	"tasks.complete",
	"tasks.run_gates",
	"tasks.set_checklist",
	"tasks.context",
	"tasks.reject",
	"tasks.retry",
	"tasks.cancel",
	"tasks.depend",
	"tasks.contain",
	"docs.create",
	"docs.list",
	"docs.show",
	"docs.activate",
	"docs.archive",
	"docs.reopen",
	"docs.link",
	"notes.capture",
	"notes.list",
	"notes.show",
	"notes.consume",
	"notes.promote",
	"notes.archive",
	"rules.create",
	"rules.list",
	"rules.show",
	"rules.preview",
	"rules.enable",
	"rules.disable",
	"rules.gate",
	"skills.create",
	"skills.create_template",
	"skills.list",
	"skills.show",
	"skills.invoke",
	"skills.run",
	"skills.enable",
	"skills.disable",
	"skills.instantiate",
] as const;

export type OperationName = typeof EXPECTED_OPERATION_NAMES[number];
type OperationInput = Record<string, unknown>;
type OperationHandler = (input: OperationInput) => unknown;

export class UnknownOperationError extends Error {}
export class MigrationRequiredError extends Error {}
export class PayloadTooLargeError extends Error {}

function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalStringArray(input: OperationInput, key: string): string[] | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${key} must be an array of strings`);
	return value as string[];
}

function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

function normalizeCreateInput(input: OperationInput): CreateArtifactInput {
	const { template_id, ...rest } = input;
	return { ...rest, templateId: typeof template_id === "string" ? template_id : undefined } as CreateArtifactInput;
}

export interface SchemaState {
	current: number;
	required: number;
	migrationRequired: boolean;
}

export interface PapyrusService {
	operationNames(): OperationName[];
	schemaState(): SchemaState;
	execute(operation: string, input?: OperationInput): Promise<unknown>;
	checkpoint(): void;
	optimize(): void;
	close(): void;
}

function handlers(
	artifacts: ArtifactStore,
	gates: GateRunner,
	tasks: Tasks,
	notes: Notes,
	events: TaskEventStore,
	scopes: TaskScopeStore,
	migrate: () => unknown,
): Record<OperationName, OperationHandler> {
	const eventContext = (input: OperationInput): TaskEventContext => ({
		actor: optionalString(input, "actor"),
		source: optionalString(input, "source"),
		sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
		reason: optionalString(input, "reason"),
	});
	const eventContextFor = (input: OperationInput, source: string): TaskEventContext => {
		const context = eventContext(input);
		return { ...context, source: context.source ?? source };
	};
	const artifactFilter = (input: OperationInput) => ({
		status: optionalString(input, "status"),
		text: optionalString(input, "text"),
		limit: optionalNumber(input, "limit"),
	});
	const taskFilter = (input: OperationInput) => ({
		...artifactFilter(input),
		projectRoot: string(input, "project_root"),
		scope: optionalString(input, "scope") as TaskViewMode | undefined,
		rootTaskId: optionalString(input, "root_task_id"),
	});
	return {
		"system.migrate": () => migrate(),
		"artifact.create": (input) => {
			const normalized = normalizeCreateInput(input);
			if (normalized.kind === "doc" && normalized.subtype === "note") throw new Error("note creation requires notes.capture");
			if (normalized.kind !== "task") return artifacts.create(normalized);
			return tasks.create({
				id: normalized.id,
				title: string(input, "title"),
				body: normalized.body,
				subtype: normalized.subtype,
				status: normalized.status as TaskStatus | undefined,
				labels: normalized.labels,
				extra: normalized.extra,
				templateId: normalized.templateId,
				projectRoot: string(input, "project_root"),
				projectSource: "cwd",
			}, eventContextFor(input, "artifact-api"));
		},
		"artifact.query": (input) => artifacts.query(input),
		"artifact.show": (input) => artifacts.get(string(input, "id"), {
			tree: input["tree"] === true,
			depth: optionalNumber(input, "depth"),
			maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
		}),
		"graph.link": (input) => {
			const from = string(input, "from");
			const relation = string(input, "relation");
			const to = string(input, "to");
			if (relation === "depends_on" && artifacts.get(from)?.kind === "task" && artifacts.get(to)?.kind === "task") {
				tasks.depend(from, to);
			} else {
				artifacts.link({ from, relation, to });
			}
			return { ok: true };
		},
		"graph.tree": (input) => artifacts.get(string(input, "id"), {
			tree: true,
			depth: optionalNumber(input, "depth"),
			maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
		}),
		"graph.status": (input) => {
			const id = string(input, "id");
			const artifact = artifacts.get(id);
			if (artifact?.kind === "task") throw new Error("task lifecycle changes require a tasks.* operation so history and review invariants are preserved");
			if (artifact?.kind === "doc" && artifact.subtype === "note") throw new Error("note lifecycle changes require a notes.* operation so disposition provenance is preserved");
			return artifacts.setStatus(id, string(input, "status"));
		},
		"gates.run": (input) => {
			const id = string(input, "id");
			return artifacts.get(id)?.kind === "task"
				? tasks.runGates(id, eventContextFor(input, "gates-api"))
				: gates.runAsync(id);
		},
		"rules.injectable": (input) => listInjectableRules(artifacts, tasks.active(taskFilter(input))?.id)
			.map(({ id, title, body, extra }) => ({ id, title, body, extra })),
		"tasks.create": (input) => tasks.create({
			title: string(input, "title"),
			body: optionalString(input, "body"),
			status: optionalString(input, "status") as TaskStatus | undefined,
			labels: input["labels"] as string[] | undefined,
			extra: input["extra"] as Record<string, unknown> | undefined,
			gates: input["gates"] as Parameters<Tasks["create"]>[0]["gates"],
			checklist: input["checklist"] as Checklist | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
			parentId: optionalString(input, "parent_id") ?? optionalString(input, "parentId"),
			dependsOn: (input["depends_on"] ?? input["dependsOn"]) as string[] | undefined,
			projectRoot: string(input, "project_root"),
			projectSource: "cwd",
		}, eventContext(input)),
		"tasks.update": (input) => tasks.update(string(input, "id"), {
			...(input["title"] !== undefined ? { title: optionalString(input, "title")! } : {}),
			...(input["body"] !== undefined ? { body: optionalString(input, "body")! } : {}),
			...(input["labels"] !== undefined ? { labels: optionalStringArray(input, "labels")! } : {}),
			...(input["status"] !== undefined ? { status: string(input, "status") as "todo" } : {}),
		}, eventContext(input)),
		"tasks.list": (input) => tasks.list(taskFilter(input)),
		"tasks.graph": (input) => tasks.graph(taskFilter(input)),
		"tasks.plan": (input) => projectTaskExecution(tasks.graph(taskFilter(input))),
		"tasks.show": (input) => tasks.show(string(input, "id")),
		"tasks.history": (input) => tasks.history(string(input, "id"), {
			limit: optionalNumber(input, "limit"),
			cursor: optionalNumber(input, "cursor"),
			direction: optionalString(input, "direction") as TaskEventDirection | undefined,
		}),
		"tasks.scope": (input) => tasks.scopeSelection(string(input, "project_root")),
		"tasks.set_scope": (input) => tasks.setView(
			string(input, "project_root"),
			string(input, "scope") as TaskViewMode,
			optionalString(input, "root_task_id"),
		),
		"tasks.assign_project": (input) => tasks.assignProject(
			string(input, "id"),
			string(input, "project_root"),
			eventContext(input),
		),
		"tasks.active": (input) => tasks.active(taskFilter(input)),
		"tasks.focused": (input) => tasks.focused(taskFilter(input)),
		"tasks.focus": (input) => tasks.focus(string(input, "id"), eventContext(input)),
		"tasks.pause": (input) => tasks.pauseFocus(eventContext(input)),
		"tasks.unpause": (input) => tasks.unpauseFocus(eventContext(input)),
		"tasks.clear_focus": (input) => tasks.clearFocus(eventContext(input)),
		"tasks.start": (input) => tasks.transition(string(input, "id"), "start", eventContext(input)),
		"tasks.submit": (input) => tasks.transition(string(input, "id"), "submit", eventContext(input)),
		"tasks.complete": (input) => tasks.completeAsync(string(input, "id"), eventContext(input)),
		"tasks.run_gates": (input) => tasks.runGates(string(input, "id"), eventContext(input)),
		"tasks.set_checklist": (input) => tasks.setChecklist(string(input, "id"), input["checklist"] as Checklist),
		"tasks.context": (input) => taskContext(artifacts, tasks.active()?.id, new Set(tasks.list(taskFilter(input)).map((task) => task.id))),
		"tasks.reject": (input) => tasks.transition(string(input, "id"), "reject", eventContext(input)),
		"tasks.retry": (input) => tasks.transition(string(input, "id"), "retry", eventContext(input)),
		"tasks.cancel": (input) => tasks.transition(string(input, "id"), "cancel", eventContext(input)),
		"tasks.depend": (input) => tasks.depend(string(input, "id"), string(input, "dependency_id")),
		"tasks.contain": (input) => tasks.contain(string(input, "parent_id"), string(input, "child_id")),
		"docs.create": (input) => createDocument(artifacts, {
			title: string(input, "title"), body: optionalString(input, "body"), subtype: optionalString(input, "subtype"),
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
		}),
		"docs.list": (input) => listDocuments(artifacts, artifactFilter(input)),
		"docs.show": (input) => showDocument(artifacts, string(input, "id")),
		"docs.activate": (input) => transitionDocument(artifacts, string(input, "id"), "activate"),
		"docs.archive": (input) => transitionDocument(artifacts, string(input, "id"), "archive"),
		"docs.reopen": (input) => transitionDocument(artifacts, string(input, "id"), "reopen"),
		"docs.link": (input) => linkDocument(artifacts, string(input, "id"), string(input, "relation") as DocumentRelation, string(input, "target_id")),
		"notes.capture": (input) => notes.capture({
			body: string(input, "body"), title: optionalString(input, "title"), projectRoot: string(input, "project_root"),
			actor: optionalString(input, "actor"), source: optionalString(input, "source"), sessionId: optionalString(input, "session_id"),
		}),
		"notes.list": (input) => notes.list({
			projectRoot: string(input, "project_root"), status: optionalString(input, "status") as "draft" | "active" | "archived" | undefined,
			text: optionalString(input, "text"), limit: optionalNumber(input, "limit"),
		}),
		"notes.show": (input) => notes.show(string(input, "id"), string(input, "project_root")),
		"notes.consume": (input) => notes.consume(string(input, "id"), {
			projectRoot: string(input, "project_root"), actor: optionalString(input, "actor"), source: optionalString(input, "source"),
			sessionId: optionalString(input, "session_id"), reason: optionalString(input, "reason"),
		}),
		"notes.promote": (input) => notes.promote(string(input, "id"), string(input, "target_id"), {
			projectRoot: string(input, "project_root"), actor: optionalString(input, "actor"), source: optionalString(input, "source"),
			sessionId: optionalString(input, "session_id"), reason: optionalString(input, "reason"),
		}),
		"notes.archive": (input) => notes.archive(string(input, "id"), {
			projectRoot: string(input, "project_root"), disposition: string(input, "disposition") as NoteDisposition,
			actor: optionalString(input, "actor"), source: optionalString(input, "source"), sessionId: optionalString(input, "session_id"),
			reason: optionalString(input, "reason"),
		}),
		"rules.create": (input) => createRule(artifacts, {
			title: string(input, "title"), body: optionalString(input, "body"), condition: optionalString(input, "condition"),
			action: optionalString(input, "rule_action") ?? optionalString(input, "governance_action"),
			severity: optionalString(input, "severity") as "block" | "warn" | "info" | undefined,
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
		}),
		"rules.list": (input) => listRules(artifacts, artifactFilter(input)),
		"rules.show": (input) => showRule(artifacts, string(input, "id")),
		"rules.preview": (input) => previewRule(artifacts, string(input, "id")),
		"rules.enable": (input) => transitionRule(artifacts, string(input, "id"), "enable"),
		"rules.disable": (input) => transitionRule(artifacts, string(input, "id"), "disable"),
		"rules.gate": (input) => gateTaskWithRule(artifacts, string(input, "id"), string(input, "task_id")),
		"skills.create": (input) => createSkill(artifacts, {
			title: string(input, "title"), body: optionalString(input, "body"), trigger: optionalString(input, "trigger"),
			steps: input["steps"] as string[] | undefined, tools: input["tools"] as string[] | undefined,
			definition: input["definition"],
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
		}),
		"skills.create_template": (input) => createArtifactTemplate(artifacts, {
			title: string(input, "title"), targetKind: string(input, "target_kind"), defaults: input["defaults"] as Record<string, unknown> | undefined,
			required: input["required"] as string[] | undefined, body: optionalString(input, "body"), labels: input["labels"] as string[] | undefined,
		}),
		"skills.list": (input) => listSkills(artifacts, artifactFilter(input)),
		"skills.show": (input) => showSkill(artifacts, string(input, "id")),
		"skills.invoke": (input) => skillInvocation(artifacts, string(input, "id")),
		"skills.run": (input) => instantiateSkillWorkflow(artifacts, string(input, "id"), {
			runId: optionalString(input, "run_id") ?? optionalString(input, "runId"),
			arguments: input["arguments"] as Record<string, unknown> | undefined,
		}, { events, scopes, projectRoot: string(input, "project_root"), context: eventContextFor(input, "skill-run") }),
		"skills.enable": (input) => transitionSkill(artifacts, string(input, "id"), "enable"),
		"skills.disable": (input) => transitionSkill(artifacts, string(input, "id"), "disable"),
		"skills.instantiate": (input) => {
			const templateId = string(input, "template_id");
			const template = artifacts.get(templateId);
			if (template?.extra["targetKind"] !== "task") return instantiateTemplate(artifacts, templateId, normalizeCreateInput(input));
			return tasks.create({
				title: optionalString(input, "title") as string,
				body: optionalString(input, "body"),
				status: optionalString(input, "status") as TaskStatus | undefined,
				labels: input["labels"] as string[] | undefined,
				extra: input["extra"] as Record<string, unknown> | undefined,
				templateId,
				projectRoot: string(input, "project_root"),
				projectSource: "cwd",
			}, eventContextFor(input, "template-instantiation"));
		},
	};
}

export function createPapyrusService(path: string): PapyrusService {
	const db = openDb(path);
	const artifacts = new SQLiteArtifactStore(db);
	const gates = new SQLiteGateRunner(db);
	const focus = new SQLiteTaskFocusStore(db);
	const events = new SQLiteTaskEventStore(db);
	const scopes = new SQLiteTaskScopeStore(db);
	const tasks = new Tasks(artifacts, gates, focus, events, scopes);
	const notes = new Notes(artifacts);
	const registry = handlers(artifacts, gates, tasks, notes, events, scopes, () => migrateDb(db));
	const state = (): SchemaState => {
		const current = schemaVersion(db);
		return { current, required: SQLITE_SCHEMA_VERSION, migrationRequired: current !== SQLITE_SCHEMA_VERSION };
	};
	return {
		operationNames: () => [...EXPECTED_OPERATION_NAMES],
		schemaState: state,
		async execute(operation, input = {}) {
			const handler = registry[operation as OperationName];
			if (!handler) throw new UnknownOperationError(`unknown operation "${operation}"`);
			if (operation !== "system.migrate" && state().migrationRequired) {
				throw new MigrationRequiredError("database migration required; run `papyrus migrate task-focus`");
			}
			return handler(input);
		},
		checkpoint: () => { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); },
		optimize: () => { db.exec("PRAGMA optimize"); },
		close: () => {
			db.exec("PRAGMA optimize");
			db.close();
		},
	};
}

function json(value: unknown, init?: ResponseInit): Response {
	return Response.json(value, init);
}

async function readOperationBody(request: Request): Promise<{ op?: unknown; input?: unknown }> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > SERVICE_MAX_BODY_BYTES) {
		throw new PayloadTooLargeError(`request exceeds ${SERVICE_MAX_BODY_BYTES} bytes`);
	}
	if (!request.body) return {};
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > SERVICE_MAX_BODY_BYTES) {
			await reader.cancel();
			throw new PayloadTooLargeError(`request exceeds ${SERVICE_MAX_BODY_BYTES} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return JSON.parse(new TextDecoder().decode(bytes)) as { op?: unknown; input?: unknown };
}

export function createApp(deps: { service: PapyrusService; token: string }): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (request.headers.get("authorization") !== `Bearer ${deps.token}`) {
				return json({ error: "missing or invalid bearer token" }, { status: 401 });
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return json({ ok: true, version: VERSION, schema: deps.service.schemaState() });
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return json({ operations: deps.service.operationNames() });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				try {
					const body = await readOperationBody(request);
					if (typeof body.op !== "string") return json({ error: "op is required" }, { status: 400 });
					const input = body.input === undefined ? {} : body.input;
					if (typeof input !== "object" || input === null || Array.isArray(input)) {
						return json({ error: "input must be an object" }, { status: 400 });
					}
					return json({ result: await deps.service.execute(body.op, input as OperationInput) });
				} catch (error) {
					const status = error instanceof PayloadTooLargeError ? 413 : error instanceof UnknownOperationError ? 404 : 400;
					return json({ error: error instanceof Error ? error.message : String(error) }, { status });
				}
			}
			return json({ error: "not found" }, { status: 404 });
		},
	};
}
