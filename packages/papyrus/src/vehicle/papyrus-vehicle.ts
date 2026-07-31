/**
 * Composition root for every domain projected onto Vehicle -- one VehicleRegistry,
 * one HTTP mount (see service.ts's createApp). Operation names are already globally
 * unique via their own dotted prefix (notes.*, rules.*, docs.*, artifact.*), so
 * merging costs nothing and avoids a separate registry/mount/client per domain.
 *
 * skills, playbooks, discuss, and tasks still register via pi-papyrus's own
 * pi.registerTool() in domain-tools.ts, not here.
 */
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { AuthorityRegistry } from "../authority-registry.ts";
import type { Notes } from "../note-service.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { ArtifactTrashStore } from "../ports/artifact-trash-store.ts";
import { registerArtifactTrashOperations } from "./artifact-trash-vehicle.ts";
import { registerDocsVehicleOperations } from "./docs-vehicle.ts";
import { registerNotesVehicleOperations } from "./notes-vehicle.ts";
import { registerRulesVehicleOperations } from "./rules-vehicle.ts";

export interface PapyrusVehicleDeps {
	artifacts: ArtifactStore & ArtifactTrashStore;
	scopes: ArtifactScopeStore;
	authority: AuthorityRegistry;
	notes: Notes;
}

export function createPapyrusVehicleRegistry(deps: PapyrusVehicleDeps): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "papyrus", version: "1.0.0", description: "Papyrus's graph-artifact domains, one honest operation per real action." });
	registerNotesVehicleOperations(registry, deps.notes, deps.artifacts);
	registerRulesVehicleOperations(registry, deps.artifacts, deps.scopes);
	registerDocsVehicleOperations(registry, deps.artifacts, deps.scopes, deps.authority);
	registerArtifactTrashOperations(registry, deps.artifacts);
	return registry;
}
