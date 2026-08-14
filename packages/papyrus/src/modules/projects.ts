/**
 * modules/projects.ts — the shared project catalog as its own Papyrus-native registered module,
 * fronting the same ProjectRegistryStore Docs/Rules/Playbooks scope operations and Tasks'
 * project catalog already share underneath (see ports/project-registry-store.ts). Tasks'
 * own tasks.projects/tasks.resolve_project/tasks.register_project remain fully working,
 * documented compatibility delegates -- this module gives every other domain (and any caller
 * with no reason to go through tasks.*) the identical operations under a kind-neutral name.
 */

import { TASK_PROJECT_LIST_MAX_RESULTS } from "../constants.ts";
import { assertRegisterProjectInputBounds, resolveProjectReference } from "../project-registry/project-registry.ts";
import { normalizeProjectRoot } from "../task-scope/task-scope.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import { type OperationInput, optionalNumber, optionalString, optionalStringArray, string } from "./operation-input.ts";

const MODULE_ID = "projects";

export const PROJECTS_OPERATION_NAMES = ["projects.list", "projects.resolve", "projects.register"] as const;

export function projectsOperations(registry: ProjectRegistryStore): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("projects.list", (input: OperationInput) => {
			const limit = optionalNumber(input, "limit") ?? 20;
			if (!Number.isInteger(limit) || limit < 1 || limit > TASK_PROJECT_LIST_MAX_RESULTS) {
				throw new Error(`project list limit must be between 1 and ${TASK_PROJECT_LIST_MAX_RESULTS}`);
			}
			return registry.projects(optionalString(input, "query"), limit);
		}),
		define("projects.resolve", (input: OperationInput) => resolveProjectReference(registry, string(input, "reference"))),
		define("projects.register", (input: OperationInput) => {
			const name = optionalString(input, "name");
			const aliases = optionalStringArray(input, "aliases");
			assertRegisterProjectInputBounds(name, aliases);
			return registry.registerProject({
				projectRoot: normalizeProjectRoot(string(input, "project_root")),
				name,
				aliases,
				existingId: optionalString(input, "existing_id"),
			});
		}),
	];
}
