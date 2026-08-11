/**
 * Barrel re-exporting the shared schema helpers and name->id resolution used by every per-domain
 * VehicleRegistry projection (notes-vehicle.ts, rules-vehicle.ts, docs-vehicle.ts,
 * artifact-trash-vehicle.ts, ...). Kept as a real file (not a `shared/index.ts` subdirectory) so
 * every existing `from "./shared.ts"` import across the 8 handler files that depend on it keeps
 * resolving unchanged -- this codebase's imports always carry an explicit `.ts` extension, which
 * does not implicitly resolve a bare specifier to a directory's own index file the way Node's
 * CJS `require()` does.
 *
 * The real implementation now lives in four focused sibling modules instead of one 435-line file
 * mixing four unrelated concerns -- see Doc "Modularity playbook: building-block-shaped
 * TypeScript modules for papyrus/pi-papyrus" and the "handlers/shared.ts split" child of "Epic:
 * Modularize papyrus/pi-papyrus god-files into building-block modules":
 *   - operation-schema.ts: generic, domain-agnostic operation-input schema DSL
 *   - paired-mutation.ts: the Vehicle-operation-definer DSL and the paired add/remove shape built on it
 *   - task-classifiers.ts: business-rule error classifiers specific to this package's own domain errors
 *   - artifact-helpers.ts: cross-domain artifact name/id resolution and workflow-run narrative building
 */
export {
	buildWorkflowRunContent,
	labelsById,
	matchArtifactByName,
	normalizeJsonEncodedField,
	resolveArtifactIdWidened,
	type WorkflowRunNarrativeInput,
} from "./artifact-helpers.ts";
export {
	booleanProp,
	looseObjectSchema,
	numberProp,
	type OperationSchemaNode,
	passthroughOutput,
	stringProp,
	validationError,
} from "./operation-schema.ts";
export {
	createOperationDefiner,
	type DefineOperation,
	definePairedMutation,
	type OperationSchemaProperties,
	type PairedMutationFieldSpec,
} from "./paired-mutation.ts";
export {
	classifyPlaybookComposition,
	classifySessionAuthorization,
	classifyTaskCreateIdempotency,
	classifyTaskDependencyCycles,
	classifyTaskExecutionBounds,
} from "./task-classifiers.ts";
