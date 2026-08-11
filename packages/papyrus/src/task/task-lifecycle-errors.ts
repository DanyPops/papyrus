/**
 * Shared lifecycle-transition error, split into its own file so both task-service.ts (transition/
 * complete) and task-focus-coordinator.ts (pause/unpause) can throw the identical class without a
 * runtime circular import between them -- task-service.ts still re-exports this under the same
 * name for backward compatibility with every existing consumer (src/index.ts's public surface,
 * handlers/tasks.ts's `instanceof` check).
 */
export class TaskInvalidTransitionError extends Error {
	constructor(
		readonly operation: string,
		readonly currentStatus: string,
		readonly intendedStatus: string,
		readonly allowedActions: readonly string[],
		readonly recovery: string,
	) {
		super(`cannot ${operation} task from ${currentStatus}; intended status is ${intendedStatus}`);
	}
}
