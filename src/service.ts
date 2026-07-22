import { SERVICE_MAX_BODY_BYTES, SQLITE_SCHEMA_VERSION } from "./constants.ts";
import { VERSION } from "./version.ts";
import { migrateDb, openDb, schemaVersion } from "./db.ts";
import { SQLiteArtifactStore } from "./adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "./adapters/sqlite-gate-runner.ts";
import { SQLiteArtifactScopeStore } from "./adapters/sqlite-artifact-scope-store.ts";
import { SQLiteGraphProjectionStore } from "./adapters/sqlite-graph-projection-store.ts";
import { SQLiteTaskFocusStore } from "./adapters/sqlite-task-focus-store.ts";
import { SQLiteTaskEventStore } from "./adapters/sqlite-task-event-store.ts";
import { SQLiteTaskScopeStore } from "./adapters/sqlite-task-scope-store.ts";
import { SQLiteSessionIdentityStore } from "./adapters/sqlite-session-identity-store.ts";
import type { CreateArtifactInput } from "./domain/artifact.ts";
import { AuthorityRegistry, AuthorizedArtifactWriter, type AuthorityClaim } from "./authority-registry.ts";
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
import { Logs } from "./log-service.ts";
import { SQLiteLogStore } from "./adapters/sqlite-log-store.ts";
import { SessionIdentity, InvalidSessionSecretError } from "./session-identity-service.ts";
import { OperationRegistry } from "./module-registry.ts";
import { docsOperations, DOCS_OPERATION_NAMES } from "./modules/docs.ts";
import { graphProjectionOperations, GRAPH_PROJECTION_OPERATION_NAMES } from "./modules/graph-projection.ts";
import { logsOperations, LOGS_OPERATION_NAMES } from "./modules/logs.ts";
import { notesOperations, NOTES_OPERATION_NAMES } from "./modules/notes.ts";
import { rulesOperations, RULES_OPERATION_NAMES } from "./modules/rules.ts";
import { skillsOperations, SKILLS_OPERATION_NAMES } from "./modules/skills.ts";
import { sessionIdentityOperations, SESSION_IDENTITY_OPERATION_NAMES } from "./modules/session-identity.ts";
import { tasksOperations, TASKS_OPERATION_NAMES } from "./modules/tasks.ts";

/**
 * Operations with no registered module: the generic, cross-cutting kernel surface
 * (artifact create/query/show, graph link/unlink/tree/status/history, gates run --
 * no domain owns creation/linking/traversal for every kind, the same way system.migrate
 * has no owning module) and two permanent composition-root exceptions (rules.injectable
 * needs tasks.active(); skills.instantiate branches into tasks.create()) -- see
 * src/modules/rules.ts and src/modules/skills.ts's module comments. Discourse's own
 * Papyrus-embedded storage (discourse.store) was removed entirely -- zero real callers
 * were ever confirmed against it; Discourse's real home is the standalone
 * @danypops/discourse package plus host adapters.
 */
const COMPOSITION_ROOT_OPERATION_NAMES = [
	"system.migrate", "artifact.create", "artifact.query", "artifact.show",
	"graph.link", "graph.unlink", "graph.tree", "graph.status", "graph.history", "gates.run",
	"rules.injectable", "skills.instantiate",
] as const;

/**
 * Each registered module owns its own operation-name list (src/modules/*.ts); this is a
 * spread of those plus the composition-root exceptions above, not a second hand-
 * maintained copy. TypeScript needs this to stay a compile-time-known array (it derives
 * OperationName, which powers Record<OperationName, OperationHandler>'s exhaustiveness
 * check below) — it cannot be generated from moduleRegistry.list() (a runtime value)
 * without losing that guarantee, so this composition of `as const` arrays is the
 * furthest this can go while keeping that safety net.
 */
export const EXPECTED_OPERATION_NAMES = [
	...COMPOSITION_ROOT_OPERATION_NAMES,
	...TASKS_OPERATION_NAMES,
	...DOCS_OPERATION_NAMES,
	...NOTES_OPERATION_NAMES,
	...RULES_OPERATION_NAMES,
	...SKILLS_OPERATION_NAMES,
	...GRAPH_PROJECTION_OPERATION_NAMES,
	...LOGS_OPERATION_NAMES,
	...SESSION_IDENTITY_OPERATION_NAMES,
] as const;

export type OperationName = typeof EXPECTED_OPERATION_NAMES[number];
type OperationInput = Record<string, unknown>;
type OperationHandler = (input: OperationInput) => unknown;

export class UnknownOperationError extends Error {}
export class MigrationRequiredError extends Error {}
export class PayloadTooLargeError extends Error {}
export { InvalidSessionSecretError };

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

/**
 * The one deep enforcement point (step 4 of reducing-papyrus-consumer-change-amplification-with-modules--pvdo)
 * replacing the previously scattered isDiscourseSubtype/NOTE_SUBTYPE/task-kind checks that used
 * to be re-implemented at every write call site. "generic" is the caller identity for the
 * low-level artifact.create / graph.link / graph.unlink / graph.status surface, which owns
 * nothing itself, so any claimed kind, subtype, or relation is rejected for it — exactly
 * matching the historical behavior these checks replace.
 */
const GENERIC_CALLER = "generic";

const notesAuthorityClaim: AuthorityClaim = {
	owner: "notes",
	matchesArtifact: (kind, subtype) => kind === "doc" && subtype === NOTE_SUBTYPE,
	denyMessage: (action) => {
		if (action === "link") return "note relationships require a notes.* operation so disposition provenance is preserved";
		if (action === "status") return "note lifecycle changes require a notes.* operation so disposition provenance is preserved";
		return "note creation requires notes.capture";
	},
};

// Only ever checked for the "status" action today (graph.status): artifact.create redirects
// kind="task" to tasks.create rather than rejecting, and graph.link/unlink never checked task
// ownership historically. appliesToAction scopes the claim so it cannot leak into those paths.
const tasksAuthorityClaim: AuthorityClaim = {
	owner: "tasks",
	matchesArtifact: (kind) => kind === "task",
	appliesToAction: (action) => action === "status",
	denyMessage: () => "task lifecycle changes require a tasks.* operation so history and review invariants are preserved",
};

function createAuthorityRegistry(): AuthorityRegistry {
	const authority = new AuthorityRegistry();
	authority.claimAll([notesAuthorityClaim, tasksAuthorityClaim]);
	return authority;
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
	/** Time-based Task Focus reclamation (see Tasks.reapStaleFocus); returns how many rows were removed, for daemon logging. */
	reapStaleFocus(): number;
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
	moduleRegistry: OperationRegistry,
	authority: AuthorityRegistry,
): Record<OperationName, OperationHandler> {
	const genericWriter = new AuthorizedArtifactWriter(artifacts, authority, GENERIC_CALLER);
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
		"artifact.create": (input) => {
			const normalized = normalizeCreateInput(input);
			authority.requireArtifactAllowed(normalized.kind, normalized.subtype ?? templateSubtype(artifacts, normalized.templateId), "create", GENERIC_CALLER);
			authority.requireArtifactAllowed(normalized.kind, normalized.subtype, "create", GENERIC_CALLER);
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
			genericWriter.checkLink({ from, relation, to });
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
			genericWriter.checkLink({ from, relation, to });
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
		"graph.status": (input) => genericWriter.setStatus(string(input, "id"), string(input, "status"), eventContext(input)),
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
		"tasks.reap_stale_focus": forwardToModule("tasks.reap_stale_focus"),
		"docs.create": forwardToModule("docs.create"),
		"docs.list": forwardToModule("docs.list"),
		"docs.show": forwardToModule("docs.show"),
		"docs.activate": forwardToModule("docs.activate"),
		"docs.archive": forwardToModule("docs.archive"),
		"docs.reopen": forwardToModule("docs.reopen"),
		"docs.link": forwardToModule("docs.link"),
		"docs.assign_project": forwardToModule("docs.assign_project"),
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
		"rules.assign_project": forwardToModule("rules.assign_project"),
		"skills.create": forwardToModule("skills.create"),
		"skills.create_template": forwardToModule("skills.create_template"),
		"skills.list": forwardToModule("skills.list"),
		"skills.show": forwardToModule("skills.show"),
		"skills.invoke": forwardToModule("skills.invoke"),
		"skills.run": forwardToModule("skills.run"),
		"skills.enable": forwardToModule("skills.enable"),
		"skills.disable": forwardToModule("skills.disable"),
		"skills.assign_project": forwardToModule("skills.assign_project"),
		"skills.instantiate": (input) => {
			const templateId = string(input, "template_id");
			const template = artifacts.get(templateId);
			// Note ownership for a non-task template target is enforced inside instantiateTemplate's
			// own rejectsNoteTemplate for the non-task branch below -- nothing else currently claims
			// an unresolved (pre-template-resolution) kind, so there is no check to perform here.
			if (template?.extra["targetKind"] !== "task") return instantiateTemplate(artifacts, templateId, normalizeCreateInput(input), authority, eventContext(input));
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
		"graph_projection.apply": forwardToModule("graph_projection.apply"),
		"graph_projection.checkpoint": forwardToModule("graph_projection.checkpoint"),
		"logs.append": forwardToModule("logs.append"),
		"logs.query": forwardToModule("logs.query"),
		"session.register": forwardToModule("session.register"),
		"session.release": forwardToModule("session.release"),
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
	const projections = new SQLiteGraphProjectionStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const logs = new Logs(new SQLiteLogStore(db));
	const sessionIdentity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
	const authority = createAuthorityRegistry();
	const moduleRegistry = new OperationRegistry();
	moduleRegistry.registerAll(notesOperations(notes));
	moduleRegistry.registerAll(logsOperations(logs));
	moduleRegistry.registerAll(sessionIdentityOperations(sessionIdentity));
	moduleRegistry.registerAll(tasksOperations(tasks, artifacts, sessionIdentity));
	moduleRegistry.registerAll(docsOperations(artifacts, artifactScopes, authority));
	moduleRegistry.registerAll(rulesOperations(artifacts, artifactScopes));
	moduleRegistry.registerAll(skillsOperations({ artifacts, events, scopes, artifactScopes, authority }));
	moduleRegistry.registerAll(graphProjectionOperations(artifacts, projections, authority));
	const registry = handlers(artifacts, gates, tasks, notes, events, scopes, () => migrateDb(db), moduleRegistry, authority);
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
		reapStaleFocus: () => tasks.reapStaleFocus(),
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
					const status = error instanceof PayloadTooLargeError ? 413 : error instanceof UnknownOperationError ? 404 : error instanceof InvalidSessionSecretError ? 403 : 400;
					return json({ error: error instanceof Error ? error.message : String(error) }, { status });
				}
			}
			return json({ error: "not found" }, { status: 404 });
		},
	};
}
