/**
 * The shared project catalog projected as a real VehicleRegistry: one VehicleOperation per real
 * action, fronting the same ProjectRegistryStore every Docs/Rules/Playbooks scope operation
 * already resolves against. tasks.projects/tasks.resolve_project/tasks.register_project remain
 * unchanged, documented compatibility delegates -- see handlers/tasks.ts.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { projectsOperations } from "../modules/projects.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";
import { createOperationDefiner, numberProp, stringProp } from "./shared.ts";

const OWNER = "projects";

export function registerProjectsVehicleOperations(registry: VehicleRegistry, projectRegistry: ProjectRegistryStore): void {
	const moduleOperations = new Map(projectsOperations(projectRegistry).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);
	const define = createOperationDefiner(registry, OWNER, "projects", ["projects:read", "projects:write"], call);

	define(
		"list",
		"Lists registered projects (shared by Tasks, Docs, Rules, and Playbooks), optionally filtered by a name/alias/root substring. Compatibility delegate: tasks.projects does the identical thing.",
		"read",
		{ query: stringProp, limit: numberProp },
		[],
		(input) => input,
	);

	define(
		"resolve",
		"Resolves an exact project reference (id, name, alias, or registered root) to its full identity, failing closed with bounded candidates when unknown or ambiguous. Compatibility delegate: tasks.resolve_project does the identical thing.",
		"read",
		{ reference: stringProp },
		["reference"],
		(input) => input,
	);

	define(
		"register",
		"Registers a new project, or renames/moves an existing one when project_root (or existing_id) already resolves to one. Compatibility delegate: tasks.register_project does the identical thing.",
		"local-write",
		{ project_root: stringProp, name: stringProp, aliases: { type: "array" } as unknown as { type: string }, existing_id: stringProp },
		["project_root"],
		(input) => input,
	);
}
