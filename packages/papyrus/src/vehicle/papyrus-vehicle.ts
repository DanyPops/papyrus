/**
 * Composition root for every domain projected onto Vehicle -- one VehicleRegistry,
 * one HTTP mount (see service.ts's createApp). Operation names are already globally
 * unique via their own dotted prefix (notes.*, rules.*, docs.*, playbooks.*, discuss.*,
 * artifact.*), so merging costs nothing and avoids a separate registry/mount/client
 * per domain.
 */
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { AuthorityRegistry } from "../authority-registry.ts";
import type { Discussions } from "../discussion-service.ts";
import type { Notes } from "../note-service.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { ArtifactTrashStore } from "../ports/artifact-trash-store.ts";
import type { TaskEventStore } from "../ports/task-event-store.ts";
import type { TaskScopeStore } from "../ports/task-scope-store.ts";
import type { SessionIdentity } from "../session-identity-service.ts";
import type { Tasks } from "../task-service.ts";
import { registerArtifactTrashOperations } from "./artifact-trash-vehicle.ts";
import { registerDiscussVehicleOperations } from "./discuss-vehicle.ts";
import { registerDocsVehicleOperations } from "./docs-vehicle.ts";
import { registerNotesVehicleOperations } from "./notes-vehicle.ts";
import { registerPlaybooksVehicleOperations } from "./playbooks-vehicle.ts";
import { registerRulesVehicleOperations } from "./rules-vehicle.ts";
import { registerTasksVehicleOperations } from "./tasks-vehicle.ts";

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
}

export function createPapyrusVehicleRegistry(deps: PapyrusVehicleDeps): VehicleRegistry {
	const registry = new VehicleRegistry({
		name: "papyrus",
		version: "1.0.0",
		description: "Papyrus's graph-artifact domains, one honest operation per real action.",
	});
	// An unexpected handler exception's message becomes the classified failure's causeMessage
	// instead of vanishing into an opaque "<op>@N handler failed". Safe here: no Papyrus domain
	// error ever embeds a session_secret or other credential in its message (only a bare
	// session_id, a correlation id, not a secret -- see session-identity-service.ts).
	registry.setExposeHandlerFailureDetails(true);
	registerNotesVehicleOperations(registry, deps.notes, deps.artifacts);
	registerRulesVehicleOperations(registry, deps.artifacts, deps.scopes);
	registerDocsVehicleOperations(registry, deps.artifacts, deps.scopes, deps.authority);
	registerPlaybooksVehicleOperations(registry, {
		artifacts: deps.artifacts,
		events: deps.events,
		scopes: deps.taskScopes,
		artifactScopes: deps.scopes,
		tasks: deps.tasks,
		sessionIdentity: deps.sessionIdentity,
	});
	registerTasksVehicleOperations(registry, { tasks: deps.tasks, artifacts: deps.artifacts, sessionIdentity: deps.sessionIdentity });
	registerDiscussVehicleOperations(registry, deps.discussions, deps.artifacts);
	registerArtifactTrashOperations(registry, deps.artifacts);
	return registry;
}
