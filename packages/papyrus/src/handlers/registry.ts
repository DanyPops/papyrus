/**
 * Composition root for every domain projected onto Vehicle -- one VehicleRegistry,
 * one HTTP mount (see service.ts's createApp). Operation names are already globally
 * unique via their own dotted prefix (notes.*, rules.*, docs.*, playbooks.*, discuss.*,
 * artifact.*), so merging costs nothing and avoids a separate registry/mount/client
 * per domain.
 */
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { ArtifactTrashStore } from "../artifact/artifact-trash-store.ts";
import type { AuthorityRegistry } from "../authority-registry.ts";
import { PAPYRUS_VEHICLE_NAME } from "../constants.ts";
import type { Discussions } from "../discussion/discussion-service.ts";
import type { Notes } from "../note/note-service.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import type { TaskEventStore } from "../task/event/task-event-store.ts";
import type { TaskScopeStore } from "../task/scope/task-scope-store.ts";
import type { Tasks } from "../task/task-service.ts";
import { registerArtifactTrashOperations } from "./artifact-trash.ts";
import { registerBatchVehicleOperation } from "./batch.ts";
import { registerDiscussVehicleOperations } from "./discuss.ts";
import { registerDocsVehicleOperations } from "./docs.ts";
import { registerNotesVehicleOperations } from "./notes.ts";
import { registerPlaybooksVehicleOperations } from "./playbooks.ts";
import { registerProjectsVehicleOperations } from "./projects.ts";
import { registerRulesVehicleOperations } from "./rules.ts";
import { registerScopeGroupsVehicleOperations } from "./scope-groups.ts";
import { registerTasksVehicleOperations } from "./tasks.ts";

export interface PapyrusVehicleDeps {
	artifacts: ArtifactStore & ArtifactTrashStore;
	scopes: ArtifactScopeStore;
	authority: AuthorityRegistry;
	notes: Notes;
	events: TaskEventStore;
	taskScopes: TaskScopeStore;
	tasks: Tasks;
	discussions: Discussions;
	sessionIdentity: SessionIdentity;
	projectRegistry: ProjectRegistryStore;
	scopeGroups: ScopeGroupStore;
}

export function createPapyrusVehicleRegistry(deps: PapyrusVehicleDeps): VehicleRegistry {
	const registry = new VehicleRegistry({
		name: PAPYRUS_VEHICLE_NAME,
		version: "1.0.0",
		description: "Papyrus's graph-artifact domains, one honest operation per real action.",
	});
	// An unexpected handler exception's message becomes the classified failure's causeMessage
	// instead of vanishing into an opaque "<op>@N handler failed". Safe here: no Papyrus domain
	// error ever embeds a session_secret or other credential in its message (only a bare
	// session_id, a correlation id, not a secret -- see session-identity-service.ts).
	registry.setExposeHandlerFailureDetails(true);
	registerNotesVehicleOperations(registry, deps.notes, deps.artifacts);
	registerRulesVehicleOperations(registry, deps.artifacts, deps.scopes, deps.projectRegistry, deps.scopeGroups);
	registerDocsVehicleOperations(registry, deps.artifacts, deps.scopes, deps.authority, deps.projectRegistry, deps.scopeGroups);
	registerPlaybooksVehicleOperations(registry, {
		artifacts: deps.artifacts,
		events: deps.events,
		scopes: deps.taskScopes,
		artifactScopes: deps.scopes,
		tasks: deps.tasks,
		sessionIdentity: deps.sessionIdentity,
		projectRegistry: deps.projectRegistry,
		scopeGroups: deps.scopeGroups,
	});
	registerTasksVehicleOperations(registry, { tasks: deps.tasks, artifacts: deps.artifacts, sessionIdentity: deps.sessionIdentity });
	registerProjectsVehicleOperations(registry, deps.projectRegistry);
	registerScopeGroupsVehicleOperations(registry, deps.scopeGroups, deps.projectRegistry, deps.scopes);
	registerDiscussVehicleOperations(registry, deps.discussions, deps.artifacts);
	registerArtifactTrashOperations(registry, deps.artifacts);
	registerBatchVehicleOperation(registry);
	return registry;
}
