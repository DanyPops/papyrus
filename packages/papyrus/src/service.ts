import { VehicleError } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { DaemonDiagnosis } from "@danypops/vehicle-server/daemon-lifecycle";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { CreateArtifactInput } from "./artifact/artifact.ts";
import { activationContextFromInput } from "./artifact/artifact-activation.ts";
import { auditArtifactActivation } from "./artifact/artifact-activation-audit.ts";
import type { ArtifactEventReader } from "./artifact/artifact-event-reader.ts";
import type { ArtifactScopeStore } from "./artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "./artifact/artifact-store.ts";
import { removeArtifactSubtree } from "./artifact/artifact-subtree.ts";
import type { ArtifactTrashStore } from "./artifact/artifact-trash-store.ts";
import { SQLiteArtifactScopeStore } from "./artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "./artifact/sqlite-artifact-store.ts";
import { type AuthorityClaim, AuthorityRegistry, AuthorizedArtifactWriter } from "./authority-registry.ts";
import { BINDER_FILED_IN_RELATION, BINDER_KIND, BINDER_ORGANIZES_RELATION } from "./binder/binder.ts";
import { SERVICE_MAX_BODY_BYTES, SQLITE_SCHEMA_VERSION } from "./constants.ts";
import { migrateDb, openDb, schemaVersion } from "./db.ts";
import { Discussions } from "./discussion/discussion-service.ts";
import { SQLiteDiscussionRoundStore } from "./discussion/sqlite-discussion-round-store.ts";
import type { GateRunner } from "./gate/gate-runner.ts";
import { SQLiteGateRunner } from "./gate/sqlite-gate-runner.ts";
import { SQLiteGraphProjectionStore } from "./graph-projection/sqlite-graph-projection-store.ts";
import { batchItemErrorMessage, parseBatchItems } from "./handlers/batch.ts";
import { createPapyrusVehicleRegistry } from "./handlers/registry.ts";
import { logEvent } from "./log/log.ts";
import { Logs } from "./log/log-service.ts";
import { SQLiteLogStore } from "./log/sqlite-log-store.ts";
import { OperationRegistry } from "./module-registry.ts";
import { BINDERS_OPERATION_NAMES, bindersOperations } from "./modules/binders.ts";
import { DISCUSS_OPERATION_NAMES, discussOperations } from "./modules/discuss.ts";
import { DOCS_OPERATION_NAMES, docsOperations } from "./modules/docs.ts";
import { GRAPH_PROJECTION_OPERATION_NAMES, graphProjectionOperations } from "./modules/graph-projection.ts";
import { LOGS_OPERATION_NAMES, logsOperations } from "./modules/logs.ts";
import { NOTES_OPERATION_NAMES, notesOperations } from "./modules/notes.ts";
import { type OperationInput, optionalNumber, optionalString, string } from "./modules/operation-input.ts";
import { PLAYBOOKS_OPERATION_NAMES, playbooksOperations } from "./modules/playbooks.ts";
import { PROJECTS_OPERATION_NAMES, projectsOperations } from "./modules/projects.ts";
import { RULES_OPERATION_NAMES, rulesOperations } from "./modules/rules.ts";
import { SCOPE_GROUPS_OPERATION_NAMES, scopeGroupsOperations } from "./modules/scope-groups.ts";
import { SESSION_IDENTITY_OPERATION_NAMES, sessionIdentityOperations } from "./modules/session-identity.ts";
import { TASKS_OPERATION_NAMES, tasksOperations } from "./modules/tasks.ts";
import { NOTE_SUBTYPE, Notes } from "./note/note-service.ts";
import { SQLiteNoteEventStore } from "./note/sqlite-note-event-store.ts";
import { SQLiteProjectRegistryStore } from "./project-registry/sqlite-project-registry-store.ts";
import { listInjectableRules } from "./rules/rules-service.ts";
import { SQLiteScopeGroupStore } from "./scope-group/sqlite-scope-group-store.ts";
import { InvalidSessionSecretError, SessionIdentity } from "./session-identity/session-identity-service.ts";
import { SQLiteSessionIdentityStore } from "./session-identity/sqlite-session-identity-store.ts";
import { SQLiteTaskCreateRequestStore } from "./task/create-request/sqlite-task-create-request-store.ts";
import { SQLiteTaskEventStore } from "./task/event/sqlite-task-event-store.ts";
import type { TaskEventContext } from "./task/event/task-event.ts";
import type { TaskEventStore } from "./task/event/task-event-store.ts";
import { SQLiteTaskFocusStore } from "./task/focus/sqlite-task-focus-store.ts";
import { SQLiteTaskLeaseStore } from "./task/lease/sqlite-task-lease-store.ts";
import { SQLiteTaskMutationRequestStore } from "./task/mutation-request/sqlite-task-mutation-request-store.ts";
import { SQLiteTaskScopeStore } from "./task/scope/sqlite-task-scope-store.ts";
import type { TaskViewMode } from "./task/scope/task-scope.ts";
import type { TaskScopeStore } from "./task/scope/task-scope-store.ts";
import { type TaskStatus, Tasks } from "./task/task-service.ts";
import { VERSION } from "./version.ts";

/**
 * Operations with no registered module: the generic, cross-cutting kernel surface
 * (artifact create/query/show, graph link/unlink/tree/status/history, gates run --
 * no domain owns creation/linking/traversal for every kind, the same way system.migrate
 * has no owning module) and one permanent composition-root exception (rules.injectable
 * needs tasks.active()) -- see src/modules/rules.ts's own module comment. Discourse's own
 * Papyrus-embedded storage (discourse.store) was removed entirely -- zero real callers
 * were ever confirmed against it; Discourse's real home is the standalone
 * @danypops/discourse package plus host adapters.
 */
const COMPOSITION_ROOT_OPERATION_NAMES = [
	"system.migrate",
	"batch.execute",
	"artifact.create",
	"artifact.query",
	"artifact.show",
	"artifact.remove",
	"artifact.remove_subtree",
	"artifact.restore",
	"artifact.trash_status",
	"artifact.trash_list",
	"activation.audit",
	"graph.link",
	"graph.unlink",
	"graph.tree",
	"graph.status",
	"graph.history",
	"gates.run",
	"rules.injectable",
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
	...BINDERS_OPERATION_NAMES,
	...DOCS_OPERATION_NAMES,
	...NOTES_OPERATION_NAMES,
	...RULES_OPERATION_NAMES,
	...PLAYBOOKS_OPERATION_NAMES,
	...PROJECTS_OPERATION_NAMES,
	...SCOPE_GROUPS_OPERATION_NAMES,
	...GRAPH_PROJECTION_OPERATION_NAMES,
	...LOGS_OPERATION_NAMES,
	...SESSION_IDENTITY_OPERATION_NAMES,
	...DISCUSS_OPERATION_NAMES,
] as const;

export type OperationName = (typeof EXPECTED_OPERATION_NAMES)[number];
type OperationHandler = (input: OperationInput) => unknown;

export class UnknownOperationError extends Error {}
export class MigrationRequiredError extends Error {}
export class PayloadTooLargeError extends Error {}
export { InvalidSessionSecretError };

function normalizeCreateInput(input: OperationInput): CreateArtifactInput {
	const { template_id, ...rest } = input;
	return { ...rest, templateId: typeof template_id === "string" ? template_id : undefined } as CreateArtifactInput;
}

function templateSubtype(artifacts: ArtifactStore, templateId: string | undefined): string | undefined {
	if (!templateId) return undefined;
	const defaults = artifacts.get(templateId)?.extra.defaults;
	if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return undefined;
	const subtype = (defaults as Record<string, unknown>).subtype;
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
		if (action === "update") return "note content changes require a notes.* operation so disposition provenance is preserved";
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

const bindersAuthorityClaim: AuthorityClaim = {
	owner: "binders",
	matchesArtifact: (kind) => kind === BINDER_KIND,
	matchesRelation: (relation) => relation === BINDER_ORGANIZES_RELATION || relation === BINDER_FILED_IN_RELATION,
	denyMessage: () => "Binder creation, hierarchy, and filing require a binders.* operation so path and cycle invariants are preserved",
};

/**
 * The same status-bypass protection Tasks and Notes already have, extended to every other kind
 * with its own validated transition set (Doc's draft/active/archived, Rule/Playbook's
 * active/deprecated) -- graph.status previously let a caller jump straight to any status string,
 * skipping e.g. Doc's draft-must-go-through-active-before-archived rule entirely.
 */
function lifecycleAuthorityClaim(owner: "docs" | "rules" | "playbooks", kind: string): AuthorityClaim {
	return {
		owner,
		matchesArtifact: (candidateKind, subtype) => candidateKind === kind && !(kind === "doc" && subtype === NOTE_SUBTYPE),
		appliesToAction: (action) => action === "status",
		denyMessage: () => `${kind} lifecycle changes require a ${owner}.* operation so transition validation is preserved`,
	};
}

export function createAuthorityRegistry(): AuthorityRegistry {
	const authority = new AuthorityRegistry();
	authority.claimAll([
		notesAuthorityClaim,
		tasksAuthorityClaim,
		bindersAuthorityClaim,
		lifecycleAuthorityClaim("docs", "doc"),
		lifecycleAuthorityClaim("rules", "rule"),
		lifecycleAuthorityClaim("playbooks", "playbook"),
	]);
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
	/**
	 * Every domain migrated onto Vehicle, merged into one registry/one HTTP mount
	 * (see ./handlers/registry.ts) -- one honest VehicleOperation per real
	 * action, replacing the Pi extension's old `<domain>(action=X)` mega-tools.
	 * Not every domain is migrated yet -- see papyrus-vehicle.ts's own doc comment
	 * for what still isn't and why.
	 */
	readonly vehicle: VehicleRegistry;
	checkpoint(): void;
	optimize(): void;
	/** Time-based Task Focus reclamation (see Tasks.reapStaleFocus); returns how many rows were removed, for daemon logging. */
	reapStaleFocus(): number;
	/** Real, cascading deletion of every artifact past its trash purge deadline (see domain/artifact-trash.ts); returns how many were purged, for daemon logging. */
	purgeDueTrash(): number;
	close(): void;
}

function handlers(
	// The composition root's own handler table needs trash lifecycle and event-log reading
	// alongside core CRUD/graph.
	artifacts: ArtifactStore & ArtifactTrashStore & ArtifactEventReader,
	gates: GateRunner,
	tasks: Tasks,
	_notes: Notes,
	_events: TaskEventStore,
	_scopes: TaskScopeStore,
	artifactScopes: ArtifactScopeStore,
	migrate: () => unknown,
	moduleRegistry: OperationRegistry,
	authority: AuthorityRegistry,
): Record<OperationName, OperationHandler> {
	const genericWriter = new AuthorizedArtifactWriter(artifacts, authority, GENERIC_CALLER);
	// Notes is the first module extracted behind the OperationRegistry (src/modules/notes.ts);
	// these six entries stay in this completeness-checked table only as a thin forward so
	// `Record<OperationName, OperationHandler>` still guarantees every operation has an entry
	// at compile time. The actual notes.* logic now lives in the module, not here.
	const forwardToModule =
		(name: OperationName): OperationHandler =>
		(input) =>
			moduleRegistry.get(name)!.execute(input);
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
	const table: Record<OperationName, OperationHandler> = {
		"system.migrate": () => migrate(),
		// A thin fan-out over this SAME table (self-referenced via closure -- `table` is fully
		// assigned by the time this handler is ever actually called, well after this object
		// literal finishes constructing), covering both module-forwarded and composition-root
		// operations alike. Deliberately bypasses execute()'s own migration-required check per
		// item -- that check already ran once for the outer "batch.execute" call itself, and
		// migration state cannot change mid-request. This path has no permission model of its
		// own (matching every other operation reached through this same table via /api/v1/ops or
		// in-process execute()) -- see handlers/batch.ts's registerBatchVehicleOperation for the
		// permission-propagating counterpart real Pi tool calls actually reach.
		"batch.execute": async (input) => {
			const items = parseBatchItems(input);
			const results: Array<{ ok: true; result: unknown } | { ok: false; error: string }> = [];
			for (const item of items) {
				try {
					const itemHandler = table[item.op as OperationName];
					if (!itemHandler) throw new UnknownOperationError(`unknown operation "${item.op}"`);
					results.push({ ok: true, result: await itemHandler(item.input) });
				} catch (error) {
					results.push({ ok: false, error: batchItemErrorMessage(error) });
				}
			}
			return { results };
		},
		"artifact.create": (input) => {
			const normalized = normalizeCreateInput(input);
			authority.requireArtifactAllowed(
				normalized.kind,
				normalized.subtype ?? templateSubtype(artifacts, normalized.templateId),
				"create",
				GENERIC_CALLER,
			);
			authority.requireArtifactAllowed(normalized.kind, normalized.subtype, "create", GENERIC_CALLER);
			if (normalized.kind !== "task") return artifacts.create(normalized);
			return tasks.create(
				{
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
				},
				eventContextFor(input, "artifact-api"),
			);
		},
		"artifact.query": (input) => artifacts.query(input),
		"artifact.show": (input) =>
			artifacts.get(string(input, "id"), {
				tree: input.tree === true,
				depth: optionalNumber(input, "depth"),
				maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
			}),
		"artifact.remove": (input) => {
			const id = string(input, "id");
			if (artifacts.get(id)?.kind === BINDER_KIND) {
				throw new Error("Binder removal requires binders.remove so a non-empty directory cannot be orphaned");
			}
			return artifacts.trash(id, { reason: optionalString(input, "reason"), context: eventContext(input) });
		},
		"artifact.remove_subtree": (input) => {
			const id = string(input, "id");
			if (artifacts.get(id)?.kind === BINDER_KIND) {
				throw new Error("Binder removal requires binders.remove so a non-empty directory cannot be orphaned");
			}
			return removeArtifactSubtree(artifacts, id, { reason: optionalString(input, "reason"), context: eventContext(input) });
		},
		"artifact.restore": (input) => artifacts.restore(string(input, "id"), eventContext(input)),
		"artifact.trash_status": (input) => artifacts.trashStatus(string(input, "id")),
		"artifact.trash_list": () => artifacts.listTrash(),
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
				const before =
					tasks
						.graph()
						.nodes.find((node) => node.task.id === from)
						?.dependencyIds.includes(to) ?? false;
				tasks.undepend(from, to, eventContext(input));
				removed = before;
			} else {
				removed = artifacts.unlink({ from, relation, to }, eventContext(input));
			}
			return { removed };
		},
		"graph.tree": (input) =>
			artifacts.get(string(input, "id"), {
				tree: true,
				depth: optionalNumber(input, "depth"),
				maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
			}),
		"graph.status": (input) => genericWriter.setStatus(string(input, "id"), string(input, "status"), eventContext(input)),
		"graph.history": (input) =>
			artifacts.events({
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
			return artifacts.get(id)?.kind === "task" ? tasks.runGates(id, eventContextFor(input, "gates-api")) : gates.runAsync(id);
		},
		"activation.audit": (input) => {
			const filter = taskFilter(input);
			if (!filter.projectRoot) throw new Error("project_root is required");
			const activeTask = tasks.active(filter);
			return auditArtifactActivation(artifacts, artifactScopes, filter.projectRoot, activeTask?.id, {
				...activationContextFromInput(input.activation_context),
				projectRoot: filter.projectRoot,
				taskStatus: activeTask?.status,
				taskLabels: activeTask?.labels,
			});
		},
		"rules.injectable": (input) => {
			const filter = taskFilter(input);
			const activeTask = tasks.active(filter);
			return listInjectableRules(artifacts, artifactScopes, filter.projectRoot, activeTask?.id, {
				...activationContextFromInput(input.activation_context),
				projectRoot: filter.projectRoot,
				taskStatus: activeTask?.status,
				taskLabels: activeTask?.labels,
			}).map(({ id, title, body, extra }) => ({ id, title, body, extra }));
		},
		"tasks.create": forwardToModule("tasks.create"),
		"tasks.update": forwardToModule("tasks.update"),
		"tasks.list": forwardToModule("tasks.list"),
		"tasks.list_page": forwardToModule("tasks.list_page"),
		"tasks.graph": forwardToModule("tasks.graph"),
		"tasks.plan": forwardToModule("tasks.plan"),
		"tasks.show": forwardToModule("tasks.show"),
		"tasks.history": forwardToModule("tasks.history"),
		"tasks.projects": forwardToModule("tasks.projects"),
		"tasks.resolve_project": forwardToModule("tasks.resolve_project"),
		"tasks.register_project": forwardToModule("tasks.register_project"),
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
		"tasks.mutation_status": forwardToModule("tasks.mutation_status"),
		"tasks.run_gates": forwardToModule("tasks.run_gates"),
		"tasks.set_checklist": forwardToModule("tasks.set_checklist"),
		"tasks.set_gates": forwardToModule("tasks.set_gates"),
		"tasks.context": forwardToModule("tasks.context"),
		"tasks.reject": forwardToModule("tasks.reject"),
		"tasks.retry": forwardToModule("tasks.retry"),
		"tasks.cancel": forwardToModule("tasks.cancel"),
		"tasks.reopen": forwardToModule("tasks.reopen"),
		"tasks.cancel_subtree": forwardToModule("tasks.cancel_subtree"),
		"tasks.depend": forwardToModule("tasks.depend"),
		"tasks.undepend": forwardToModule("tasks.undepend"),
		"tasks.contain": forwardToModule("tasks.contain"),
		"tasks.uncontain": forwardToModule("tasks.uncontain"),
		"tasks.claim": forwardToModule("tasks.claim"),
		"tasks.heartbeat_lease": forwardToModule("tasks.heartbeat_lease"),
		"tasks.release_lease": forwardToModule("tasks.release_lease"),
		"tasks.lease": forwardToModule("tasks.lease"),
		"tasks.reap_stale_leases": forwardToModule("tasks.reap_stale_leases"),
		"tasks.event_feed": forwardToModule("tasks.event_feed"),
		"tasks.reap_stale_focus": forwardToModule("tasks.reap_stale_focus"),
		"binders.create": forwardToModule("binders.create"),
		"binders.list": forwardToModule("binders.list"),
		"binders.tree": forwardToModule("binders.tree"),
		"binders.show": forwardToModule("binders.show"),
		"binders.update": forwardToModule("binders.update"),
		"binders.move": forwardToModule("binders.move"),
		"binders.file": forwardToModule("binders.file"),
		"binders.unfile": forwardToModule("binders.unfile"),
		"binders.remove": forwardToModule("binders.remove"),
		"binders.scope": forwardToModule("binders.scope"),
		"binders.set_global": forwardToModule("binders.set_global"),
		"binders.set_none": forwardToModule("binders.set_none"),
		"binders.add_project": forwardToModule("binders.add_project"),
		"binders.remove_project": forwardToModule("binders.remove_project"),
		"binders.replace_projects": forwardToModule("binders.replace_projects"),
		"binders.add_group": forwardToModule("binders.add_group"),
		"binders.remove_group": forwardToModule("binders.remove_group"),
		"binders.replace_groups": forwardToModule("binders.replace_groups"),
		"docs.create": forwardToModule("docs.create"),
		"docs.list": forwardToModule("docs.list"),
		"docs.show": forwardToModule("docs.show"),
		"docs.activate": forwardToModule("docs.activate"),
		"docs.archive": forwardToModule("docs.archive"),
		"docs.reopen": forwardToModule("docs.reopen"),
		"docs.link": forwardToModule("docs.link"),
		"docs.assign_project": forwardToModule("docs.assign_project"),
		"docs.scope": forwardToModule("docs.scope"),
		"docs.set_global": forwardToModule("docs.set_global"),
		"docs.set_none": forwardToModule("docs.set_none"),
		"docs.add_project": forwardToModule("docs.add_project"),
		"docs.remove_project": forwardToModule("docs.remove_project"),
		"docs.replace_projects": forwardToModule("docs.replace_projects"),
		"docs.add_group": forwardToModule("docs.add_group"),
		"docs.remove_group": forwardToModule("docs.remove_group"),
		"docs.replace_groups": forwardToModule("docs.replace_groups"),
		"docs.update": forwardToModule("docs.update"),
		"notes.capture": forwardToModule("notes.capture"),
		"notes.list": forwardToModule("notes.list"),
		"notes.list_page": forwardToModule("notes.list_page"),
		"notes.show": forwardToModule("notes.show"),
		"notes.history": forwardToModule("notes.history"),
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
		"rules.scope": forwardToModule("rules.scope"),
		"rules.set_global": forwardToModule("rules.set_global"),
		"rules.set_none": forwardToModule("rules.set_none"),
		"rules.add_project": forwardToModule("rules.add_project"),
		"rules.remove_project": forwardToModule("rules.remove_project"),
		"rules.replace_projects": forwardToModule("rules.replace_projects"),
		"rules.add_group": forwardToModule("rules.add_group"),
		"rules.remove_group": forwardToModule("rules.remove_group"),
		"rules.replace_groups": forwardToModule("rules.replace_groups"),
		"rules.update": forwardToModule("rules.update"),
		"playbooks.create": forwardToModule("playbooks.create"),
		"playbooks.list": forwardToModule("playbooks.list"),
		"playbooks.show": forwardToModule("playbooks.show"),
		"playbooks.invoke": forwardToModule("playbooks.invoke"),
		"playbooks.preview": forwardToModule("playbooks.preview"),
		"playbooks.enable": forwardToModule("playbooks.enable"),
		"playbooks.disable": forwardToModule("playbooks.disable"),
		"playbooks.assign_project": forwardToModule("playbooks.assign_project"),
		"playbooks.scope": forwardToModule("playbooks.scope"),
		"playbooks.set_global": forwardToModule("playbooks.set_global"),
		"playbooks.set_none": forwardToModule("playbooks.set_none"),
		"playbooks.add_project": forwardToModule("playbooks.add_project"),
		"playbooks.remove_project": forwardToModule("playbooks.remove_project"),
		"playbooks.replace_projects": forwardToModule("playbooks.replace_projects"),
		"playbooks.add_group": forwardToModule("playbooks.add_group"),
		"playbooks.remove_group": forwardToModule("playbooks.remove_group"),
		"playbooks.replace_groups": forwardToModule("playbooks.replace_groups"),
		"playbooks.update": forwardToModule("playbooks.update"),
		"playbooks.contain": forwardToModule("playbooks.contain"),
		"playbooks.uncontain": forwardToModule("playbooks.uncontain"),
		"playbooks.depend": forwardToModule("playbooks.depend"),
		"playbooks.undepend": forwardToModule("playbooks.undepend"),
		"projects.list": forwardToModule("projects.list"),
		"projects.resolve": forwardToModule("projects.resolve"),
		"projects.register": forwardToModule("projects.register"),
		"scope_groups.list": forwardToModule("scope_groups.list"),
		"scope_groups.resolve": forwardToModule("scope_groups.resolve"),
		"scope_groups.register": forwardToModule("scope_groups.register"),
		"scope_groups.show": forwardToModule("scope_groups.show"),
		"scope_groups.add_member": forwardToModule("scope_groups.add_member"),
		"scope_groups.remove_member": forwardToModule("scope_groups.remove_member"),
		"scope_groups.delete": forwardToModule("scope_groups.delete"),
		"graph_projection.apply": forwardToModule("graph_projection.apply"),
		"graph_projection.checkpoint": forwardToModule("graph_projection.checkpoint"),
		"logs.append": forwardToModule("logs.append"),
		"logs.query": forwardToModule("logs.query"),
		"session.register": forwardToModule("session.register"),
		"session.release": forwardToModule("session.release"),
		"discuss.open": forwardToModule("discuss.open"),
		"discuss.reply": forwardToModule("discuss.reply"),
		"discuss.defer": forwardToModule("discuss.defer"),
		"discuss.resume": forwardToModule("discuss.resume"),
		"discuss.settle": forwardToModule("discuss.settle"),
		"discuss.block": forwardToModule("discuss.block"),
		"discuss.unblock": forwardToModule("discuss.unblock"),
		"discuss.show": forwardToModule("discuss.show"),
		"discuss.rounds": forwardToModule("discuss.rounds"),
		"discuss.list": forwardToModule("discuss.list"),
	};
	return table;
}

export function createPapyrusService(path: string): PapyrusService {
	const db = openDb(path);
	const artifacts = new SQLiteArtifactStore(db);
	const gates = new SQLiteGateRunner(db);
	const focus = new SQLiteTaskFocusStore(db);
	const events = new SQLiteTaskEventStore(db);
	const scopes = new SQLiteTaskScopeStore(db);
	const leases = new SQLiteTaskLeaseStore(db);
	const createRequests = new SQLiteTaskCreateRequestStore(db);
	const mutationRequests = new SQLiteTaskMutationRequestStore(db);
	const tasks = new Tasks(artifacts, gates, focus, events, scopes, leases, createRequests, mutationRequests);
	const noteEvents = new SQLiteNoteEventStore(db);
	const notes = new Notes(artifacts, noteEvents);
	const projections = new SQLiteGraphProjectionStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const projectRegistry = new SQLiteProjectRegistryStore(db);
	const scopeGroups = new SQLiteScopeGroupStore(db);
	const logs = new Logs(new SQLiteLogStore(db));
	const sessionIdentity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
	const discussions = new Discussions(artifacts, new SQLiteDiscussionRoundStore(db));
	const authority = createAuthorityRegistry();
	const vehicle = createPapyrusVehicleRegistry({
		artifacts,
		scopes: artifactScopes,
		authority,
		notes,
		events,
		taskScopes: scopes,
		tasks,
		discussions,
		sessionIdentity,
		projectRegistry,
		scopeGroups,
	});
	const moduleRegistry = new OperationRegistry();
	moduleRegistry.registerAll(notesOperations(notes));
	moduleRegistry.registerAll(logsOperations(logs));
	moduleRegistry.registerAll(sessionIdentityOperations(sessionIdentity));
	moduleRegistry.registerAll(discussOperations(discussions));
	moduleRegistry.registerAll(tasksOperations(tasks, artifacts, sessionIdentity));
	moduleRegistry.registerAll(bindersOperations(artifacts, artifactScopes, projectRegistry, scopeGroups));
	moduleRegistry.registerAll(docsOperations(artifacts, artifactScopes, authority, projectRegistry, scopeGroups));
	moduleRegistry.registerAll(rulesOperations(artifacts, artifactScopes, projectRegistry, scopeGroups));
	moduleRegistry.registerAll(
		playbooksOperations({ artifacts, events, scopes, artifactScopes, tasks, sessionIdentity, registry: projectRegistry, scopeGroups }),
	);
	moduleRegistry.registerAll(projectsOperations(projectRegistry));
	moduleRegistry.registerAll(scopeGroupsOperations(scopeGroups, projectRegistry, artifactScopes));
	moduleRegistry.registerAll(graphProjectionOperations(artifacts, projections, authority));
	const registry = handlers(artifacts, gates, tasks, notes, events, scopes, artifactScopes, () => migrateDb(db), moduleRegistry, authority);
	const state = (): SchemaState => {
		const current = schemaVersion(db);
		return { current, required: SQLITE_SCHEMA_VERSION, migrationRequired: current !== SQLITE_SCHEMA_VERSION };
	};
	return {
		operationNames: () => [...EXPECTED_OPERATION_NAMES],
		schemaState: state,
		vehicle,
		async execute(operation, input = {}) {
			const handler = registry[operation as OperationName];
			if (!handler) throw new UnknownOperationError(`unknown operation "${operation}"`);
			if (operation !== "system.migrate" && state().migrationRequired) {
				throw new MigrationRequiredError("database migration required; run `papyrus migrate schema`");
			}
			return handler(input);
		},
		checkpoint: () => {
			db.exec("PRAGMA wal_checkpoint(PASSIVE)");
		},
		optimize: () => {
			db.exec("PRAGMA optimize");
		},
		reapStaleFocus: () => tasks.reapStaleFocus(),
		purgeDueTrash: () => artifacts.purgeDueTrash(),
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
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as { op?: unknown; input?: unknown };
}

export function createApp(deps: {
	service: PapyrusService;
	token: string;
	/**
	 * Fired after an operation executes successfully -- decoupled from any specific
	 * consumer (push-invalidation, audit logging, metrics) so this HTTP layer stays
	 * agnostic of what a caller does with the notification. The composition root
	 * (daemon.ts) wires this to a PushChannel; tests and other embedders can ignore it.
	 */
	onOperationExecuted?: (operation: string, input: OperationInput) => void;
	/** Defaults to a no-op (createVehicleHttpApp's own default) -- daemon.ts wires log/log.ts's own `logger` so a failed invocation is actually logged, not silently discarded. */
	logger?: Logger;
	/**
	 * Backs GET /daemon/diagnose -- "who am I, and what happened recently" (see
	 * @danypops/vehicle-server's daemon-lifecycle.ts), without a caller reading Papyrus's own
	 * SQLite database or state files directly. Omitted (e.g. in most tests, which don't run a
	 * real supervised daemon process) means the route 404s, matching how /health always exists
	 * but this diagnostic identity does not until a real serveMain() supplies it.
	 */
	diagnose?: () => Promise<DaemonDiagnosis>;
}): { fetch(request: Request): Promise<Response> } {
	// Same Bearer token, daemon, and port as the rest of this API -- see ./handlers/registry.ts.
	const vehicleApp = createVehicleHttpApp({ registry: deps.service.vehicle, token: deps.token, logger: deps.logger });
	return {
		async fetch(request: Request): Promise<Response> {
			if (request.headers.get("authorization") !== `Bearer ${deps.token}`) {
				return json({ error: "missing or invalid bearer token" }, { status: 401 });
			}
			const url = new URL(request.url);
			if (url.pathname.startsWith("/vehicle/")) {
				// Every domain (tasks/docs/rules/discuss/notes/playbooks) is reachable here directly
				// (registry.invoke()), bypassing execute()'s own migrationRequired guard below entirely --
				// a stale schema surfaced as an opaque handler-failed (or worse, a silent wrong answer)
				// the moment a request touched a column/table the old schema never had, instead of the
				// same clear, actionable error execute() already gives. Real incident: restarting the
				// live daemon onto new code without running `papyrus migrate schema` first.
				if (deps.service.schemaState().migrationRequired) {
					logEvent("warn", "vehicle_invoke_blocked_migration_required", { path: url.pathname, schema: deps.service.schemaState() });
					const failure = new VehicleError("migration-required", "database migration required; run `papyrus migrate schema`", {
						category: "unavailable",
						retryable: false,
					}).toFailure();
					return json({ error: failure, operationId: crypto.randomUUID() }, { status: 503 });
				}
				return vehicleApp.fetch(request);
			}
			if (request.method === "GET" && url.pathname === "/health") {
				return json({ ok: true, version: VERSION, schema: deps.service.schemaState() });
			}
			if (request.method === "GET" && url.pathname === "/daemon/diagnose") {
				if (!deps.diagnose) return json({ error: "daemon diagnose is unavailable on this instance" }, { status: 404 });
				return json(await deps.diagnose());
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
					const result = await deps.service.execute(body.op, input as OperationInput);
					deps.onOperationExecuted?.(body.op, input as OperationInput);
					return json({ result });
				} catch (error) {
					const status =
						error instanceof PayloadTooLargeError
							? 413
							: error instanceof UnknownOperationError
								? 404
								: error instanceof InvalidSessionSecretError
									? 403
									: 400;
					return json({ error: error instanceof Error ? error.message : String(error) }, { status });
				}
			}
			return json({ error: "not found" }, { status: 404 });
		},
	};
}
