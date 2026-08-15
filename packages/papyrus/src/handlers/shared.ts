/**
 * Barrel re-exporting the shared schema helpers and name->id resolution used by every per-domain
 * VehicleRegistry projection. Kept as a real file (not a `shared/index.ts` subdirectory) so every
 * existing `from "./shared.ts"` import keeps resolving unchanged -- this codebase's imports
 * always carry an explicit `.ts` extension, which does not implicitly resolve a bare specifier to
 * a directory's own index file the way Node's CJS `require()` does. Real implementation lives in
 * operation-schema.ts (schema DSL), paired-mutation.ts (operation-definer DSL), task-classifiers.ts
 * (domain error classifiers), artifact-helpers.ts (name/id resolution, workflow-run narrative).
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
