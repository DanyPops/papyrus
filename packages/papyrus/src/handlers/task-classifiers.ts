/**
 * Business-rule error classifiers -- turn an ordinary, expected domain rejection into its own
 * classified VehicleError instead of vehicle-registry's generic opaque "handler-failed", split out
 * of handlers/shared.ts as part of a SOLID-audit-driven decomposition (see Doc "Modularity
 * playbook: building-block-shaped TypeScript modules for papyrus/pi-papyrus" and the
 * "handlers/shared.ts split" child of "Epic: Modularize papyrus/pi-papyrus god-files into
 * building-block modules"). Unlike operation-schema.ts, every function here is specific to this
 * package's own domain error types.
 */
import { VehicleError } from "@danypops/vehicle-core";
import { PlaybookCompositionError } from "../playbook/playbook-definition.ts";
import { InvalidSessionSecretError } from "../session-identity/session-identity-service.ts";
import { TaskCreateIdempotencyConflictError } from "../task/create-request/task-create-request-store.ts";
import { TaskDependencyCycleError, TaskExecutionBoundExceededError } from "../task/task-execution.ts";

/**
 * tasks.focus/pause/unpause/clear_focus and playbooks.invoke all re-run
 * sessionIdentity.assertAuthorized(session_id, session_secret) directly, bypassing the guarded
 * tasks.focus operation (see modules/tasks.ts's guardFocusMutation and modules/playbooks.ts's own
 * doc comment) -- a real, registered session's own auth failure is an ordinary, expected outcome,
 * not an unexpected crash, so it must surface as its own classified VehicleError. Real incident:
 * this used to arrive only inside .cause of an opaque "... handler failed", invisible to a caller
 * that doesn't already know to dig for it. Anything else propagates unchanged, so vehicle-registry's
 * own secure-by-default handler-failed opacity still applies to a genuine unexpected crash.
 */
export function classifySessionAuthorization<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof InvalidSessionSecretError) {
			throw new VehicleError("invalid-session-secret", error.message, { category: "authorization" });
		}
		throw error;
	}
}

/**
 * A task execution graph (or a workflow/playbook run materializing one) that exceeds its own
 * node/edge/degree bound is an ordinary, expected capacity failure, not an unexpected crash --
 * must surface as its own classified VehicleError instead of vehicle-registry's generic
 * handler-failed. Shared by tasks-vehicle.ts (create/depend/contain/graph/plan/complete) and
 * playbooks-vehicle.ts (invoke, which materializes Tasks through the same shared engine).
 */
export function classifyTaskExecutionBounds<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof TaskExecutionBoundExceededError) {
			throw new VehicleError("task-execution-bound-exceeded", error.message, { category: "capacity" });
		}
		throw error;
	}
}

export function classifyTaskCreateIdempotency<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof TaskCreateIdempotencyConflictError) {
			throw new VehicleError("idempotency-key-conflict", error.message, { category: "conflict" });
		}
		throw error;
	}
}

/** A self-dependency or dependency-cycle rejection (tasks.depend/undepend/create) is an ordinary, expected validation failure, not an unexpected crash. */
export function classifyTaskDependencyCycles<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof TaskDependencyCycleError) {
			throw new VehicleError("task-dependency-cycle", error.message, { category: "validation" });
		}
		throw error;
	}
}

/** A Playbook's own composition tree (contains/depends_on nesting) is invalid -- a cycle, excessive depth/size, or conflicting argument types -- an ordinary, expected authoring mistake caught at playbooks.invoke/preview compile time, not an unexpected crash. */
export function classifyPlaybookComposition<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof PlaybookCompositionError) {
			throw new VehicleError("playbook-composition-invalid", error.message, { category: "validation" });
		}
		throw error;
	}
}
