import type { VehicleExecutionMiddleware } from "@danypops/vehicle-server";

/**
 * Publishes one invalidation only after a successful Vehicle task mutation.
 * Kept as execution middleware so HTTP, LocalVehicleClient, jobs, and future
 * transports all observe the same mutation rather than each transport trying
 * to infer success from its own response framing.
 */
export function createTaskMutationPushMiddleware(publish: (operation: string) => void): VehicleExecutionMiddleware {
	return {
		id: "papyrus.task-mutation-push",
		async intercept(request, next) {
			const output = await next(request.input);
			if (request.operation.name.startsWith("tasks.") && request.operation.effect !== "read") publish(request.operation.name);
			return output;
		},
	};
}
