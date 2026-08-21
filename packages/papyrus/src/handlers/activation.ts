import type { VehicleRegistry } from "@danypops/vehicle-server";
import { activationContextFromInput } from "../artifact/artifact-activation.ts";
import { auditArtifactActivation } from "../artifact/artifact-activation-audit.ts";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { Tasks } from "../task/task-service.ts";
import { createOperationDefiner, stringProp } from "./shared.ts";

export function registerActivationVehicleOperations(
	registry: VehicleRegistry,
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	tasks: Tasks,
): void {
	const define = createOperationDefiner(registry, "activation", "activation", ["rules:read", "playbooks:read"], (name, input) => {
		if (name !== "activation.audit") throw new Error(`unknown activation operation ${name}`);
		const projectRoot = input.project_root as string;
		const sessionId = input.session_id as string | undefined;
		const activeTask = tasks.active({ projectRoot, sessionId });
		return auditArtifactActivation(artifacts, scopes, projectRoot, activeTask?.id, {
			...activationContextFromInput(input.activation_context),
			projectRoot,
			taskStatus: activeTask?.status,
			taskLabels: activeTask?.labels,
		});
	});
	define(
		"audit",
		"Audits every Rule and Playbook against lifecycle, project/scope-group applicability, run ownership, the persisted activation flag, artifact-label matching, and typed predicates. Returns enabled/disabled decisions, exclusion reasons, activation settings, priority, injection profile, scope counts, and estimated enabled tokens.",
		"read",
		{
			project_root: stringProp,
			activation_context: { type: "object", description: "Trusted turn signals used by typed activation predicates." },
			session_id: stringProp,
		},
		["project_root"],
		(input) => input,
	);
}
