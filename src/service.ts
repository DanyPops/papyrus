import { SERVICE_MAX_BODY_BYTES, SQLITE_SCHEMA_VERSION } from "./constants.ts";
import { VERSION } from "./version.ts";
import { migrateDb, openDb, schemaVersion } from "./db.ts";
import { SQLiteArtifactStore } from "./adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "./adapters/sqlite-gate-runner.ts";
import { SQLiteDiscourseStore } from "./adapters/sqlite-discourse-store.ts";
import { SQLiteTaskFocusStore } from "./adapters/sqlite-task-focus-store.ts";
import { SQLiteTaskEventStore } from "./adapters/sqlite-task-event-store.ts";
import { SQLiteTaskScopeStore } from "./adapters/sqlite-task-scope-store.ts";
import type { CreateArtifactInput } from "./domain/artifact.ts";
import { DISCOURSE_RELATIONS, isDiscourseSubtype } from "./domain/discourse-store.ts";
import type { TaskEventContext } from "./domain/task-event.ts";
import type { TaskViewMode } from "./domain/task-scope.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { GateRunner } from "./ports/gate-runner.ts";
import type { TaskEventStore } from "./ports/task-event-store.ts";
import type { TaskScopeStore } from "./ports/task-scope-store.ts";
import { Tasks, type TaskStatus } from "./task-service.ts";
import {
	instantiateTemplate,
	listInjectableRules,
} from "./domain-services.ts";
import { Notes, NOTE_SUBTYPE } from "./note-service.ts";
import { OperationRegistry } from "./module-registry.ts";
import { docsOperations } from "./modules/docs.ts";
import { notesOperations } from "./modules/notes.ts";
import { rulesOperations } from "./modules/rules.ts";
import { skillsOperations } from "./modules/skills.ts";
import { tasksOperations } from "./modules/tasks.ts";

export const EXPECTED_OPERATION_NAMES = [
	"system.migrate",
	"discourse.store",
	"artifact.create",
	"artifact.query",
	"artifact.show",
	"graph.link",
	"graph.unlink",
	"graph.tree",
	"graph.status",
	"graph.history",
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
	"tasks.undepend",
	"tasks.contain",
	"tasks.uncontain",
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

function templateSubtype(artifacts: ArtifactStore, templateId: string | undefined): string | undefined {
	if (!templateId) return undefined;
	const defaults = artifacts.get(templateId)?.extra["defaults"];
	if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return undefined;
	const subtype = (defaults as Record<string, unknown>)["subtype"];
	return typeof subtype === "string" ? subtype : undefined;
}

function requireDiscourseStoreForSubtype(subtype: string | undefined): void {
	if (isDiscourseSubtype(subtype)) throw new Error("forum-owned Context Mesh Docs require discourse.store");
}

/** Low-level graph.link/graph.unlink must not bypass the domain invariants that docs.link/notes.* already enforce. */
function requireGraphOperationAllowed(artifacts: ArtifactStore, relation: string, from: string, to: string): void {
	const fromArtifact = artifacts.get(from);
	const toArtifact = artifacts.get(to);
	if (DISCOURSE_RELATIONS.has(relation) || isDiscourseSubtype(fromArtifact?.subtype) || isDiscourseSubtype(toArtifact?.subtype)) {
		throw new Error("forum-owned Context Mesh links require discourse.store");
	}
	if (fromArtifact?.subtype === NOTE_SUBTYPE || toArtifact?.subtype === NOTE_SUBTYPE) {
		throw new Error("note relationships require a notes.* operation so disposition provenance is preserved");
	}
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
	discourse: SQLiteDiscourseStore,
	events: TaskEventStore,
	scopes: TaskScopeStore,
	migrate: () => unknown,
	moduleRegistry: OperationRegistry,
): Record<OperationName, OperationHandler> {
	// Notes is the first module extracted behind the OperationRegistry (src/modules/notes.ts);
	// these six entries stay in this completeness-checked table only as a thin forward so
	// `Record<OperationName, OperationHandler>` still guarantees every operation has an entry
	// at compile time. The actual notes.* logic now lives in the module, not here.
	const forwardToModule = (name: OperationName): OperationHandler => (input) => moduleRegistry.get(name)!.execute(input);
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
		sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
	});
	return {
		"system.migrate": () => migrate(),
		"discourse.store": (input) => discourse.execute(input),
		"artifact.create": (input) => {
			const normalized = normalizeCreateInput(input);
			requireDiscourseStoreForSubtype(normalized.subtype ?? templateSubtype(artifacts, normalized.templateId));
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
			requireGraphOperationAllowed(artifacts, relation, from, to);
			if (relation === "depends_on" && artifacts.get(from)?.kind === "task" && artifacts.get(to)?.kind === "task") {
				tasks.depend(from, to, eventContext(input));
			} else {
				artifacts.link({ from, relation, to }, eventContext(input));
			}
			return { ok: true };
		},
		"graph.unlink": (input) => {
			const from = string(input, "from");
			const relation = string(input, "relation");
			const to = string(input, "to");
			requireGraphOperationAllowed(artifacts, relation, from, to);
			let removed: boolean;
			if (relation === "depends_on" && artifacts.get(from)?.kind === "task" && artifacts.get(to)?.kind === "task") {
				const before = tasks.graph().nodes.find((node) => node.task.id === from)?.dependencyIds.includes(to) ?? false;
				tasks.undepend(from, to, eventContext(input));
				removed = before;
			} else {
				removed = artifacts.unlink({ from, relation, to }, eventContext(input));
			}
			return { removed };
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
			if (isDiscourseSubtype(artifact?.subtype)) throw new Error("forum-owned Context Mesh Docs require discourse.store");
			return artifacts.setStatus(id, string(input, "status"), eventContext(input));
		},
		"graph.history": (input) => artifacts.events({
			artifactId: optionalString(input, "id"),
			actor: optionalString(input, "actor"),
			sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
			since: optionalString(input, "since"),
			limit: optionalNumber(input, "limit"),
			cursor: optionalNumber(input, "cursor"),
			direction: optionalString(input, "direction") as "asc" | "desc" | undefined,
		}),
		"gates.run": (input) => {
			const id = string(input, "id");
			return artifacts.get(id)?.kind === "task"
				? tasks.runGates(id, eventContextFor(input, "gates-api"))
				: gates.runAsync(id);
		},
		"rules.injectable": (input) => listInjectableRules(artifacts, tasks.active(taskFilter(input))?.id)
			.map(({ id, title, body, extra }) => ({ id, title, body, extra })),
		"tasks.create": forwardToModule("tasks.create"),
		"tasks.update": forwardToModule("tasks.update"),
		"tasks.list": forwardToModule("tasks.list"),
		"tasks.graph": forwardToModule("tasks.graph"),
		"tasks.plan": forwardToModule("tasks.plan"),
		"tasks.show": forwardToModule("tasks.show"),
		"tasks.history": forwardToModule("tasks.history"),
		"tasks.scope": forwardToModule("tasks.scope"),
		"tasks.set_scope": forwardToModule("tasks.set_scope"),
		"tasks.assign_project": forwardToModule("tasks.assign_project"),
		"tasks.active": forwardToModule("tasks.active"),
		"tasks.focused": forwardToModule("tasks.focused"),
		"tasks.focus": forwardToModule("tasks.focus"),
		"tasks.pause": forwardToModule("tasks.pause"),
		"tasks.unpause": forwardToModule("tasks.unpause"),
		"tasks.clear_focus": forwardToModule("tasks.clear_focus"),
		"tasks.start": forwardToModule("tasks.start"),
		"tasks.submit": forwardToModule("tasks.submit"),
		"tasks.complete": forwardToModule("tasks.complete"),
		"tasks.run_gates": forwardToModule("tasks.run_gates"),
		"tasks.set_checklist": forwardToModule("tasks.set_checklist"),
		"tasks.context": forwardToModule("tasks.context"),
		"tasks.reject": forwardToModule("tasks.reject"),
		"tasks.retry": forwardToModule("tasks.retry"),
		"tasks.cancel": forwardToModule("tasks.cancel"),
		"tasks.depend": forwardToModule("tasks.depend"),
		"tasks.undepend": forwardToModule("tasks.undepend"),
		"tasks.contain": forwardToModule("tasks.contain"),
		"tasks.uncontain": forwardToModule("tasks.uncontain"),
		"docs.create": forwardToModule("docs.create"),
		"docs.list": forwardToModule("docs.list"),
		"docs.show": forwardToModule("docs.show"),
		"docs.activate": forwardToModule("docs.activate"),
		"docs.archive": forwardToModule("docs.archive"),
		"docs.reopen": forwardToModule("docs.reopen"),
		"docs.link": forwardToModule("docs.link"),
		"notes.capture": forwardToModule("notes.capture"),
		"notes.list": forwardToModule("notes.list"),
		"notes.show": forwardToModule("notes.show"),
		"notes.consume": forwardToModule("notes.consume"),
		"notes.promote": forwardToModule("notes.promote"),
		"notes.archive": forwardToModule("notes.archive"),
		"rules.create": forwardToModule("rules.create"),
		"rules.list": forwardToModule("rules.list"),
		"rules.show": forwardToModule("rules.show"),
		"rules.preview": forwardToModule("rules.preview"),
		"rules.enable": forwardToModule("rules.enable"),
		"rules.disable": forwardToModule("rules.disable"),
		"rules.gate": forwardToModule("rules.gate"),
		"skills.create": forwardToModule("skills.create"),
		"skills.create_template": forwardToModule("skills.create_template"),
		"skills.list": forwardToModule("skills.list"),
		"skills.show": forwardToModule("skills.show"),
		"skills.invoke": forwardToModule("skills.invoke"),
		"skills.run": forwardToModule("skills.run"),
		"skills.enable": forwardToModule("skills.enable"),
		"skills.disable": forwardToModule("skills.disable"),
		"skills.instantiate": (input) => {
			const templateId = string(input, "template_id");
			const template = artifacts.get(templateId);
			requireDiscourseStoreForSubtype(templateSubtype(artifacts, templateId));
			if (template?.extra["targetKind"] !== "task") return instantiateTemplate(artifacts, templateId, normalizeCreateInput(input), eventContext(input));
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
	const discourse = new SQLiteDiscourseStore(db, artifacts);
	const moduleRegistry = new OperationRegistry();
	moduleRegistry.registerAll(notesOperations(notes));
	moduleRegistry.registerAll(tasksOperations(tasks, artifacts));
	moduleRegistry.registerAll(docsOperations(artifacts));
	moduleRegistry.registerAll(rulesOperations(artifacts));
	moduleRegistry.registerAll(skillsOperations({ artifacts, events, scopes }));
	const registry = handlers(artifacts, gates, tasks, notes, discourse, events, scopes, () => migrateDb(db), moduleRegistry);
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
				throw new MigrationRequiredError("database migration required; run `papyrus migrate schema`");
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
