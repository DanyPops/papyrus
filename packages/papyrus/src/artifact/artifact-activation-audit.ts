import { ARTIFACT_SCOPE_MAX_ARTIFACTS, CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN } from "../constants.ts";
import { passesRuleRunScope, previewRule } from "../rules/rules-service.ts";
import type { Artifact } from "./artifact.ts";
import { type ActivationContext, activationConfig, evaluateActivation, type InjectionProfile } from "./artifact-activation.ts";
import type { ArtifactScopeMode, ArtifactScopeStore } from "./artifact-scope-store.ts";
import type { ArtifactStore } from "./artifact-store.ts";

export interface ActivationAuditEntry {
	id: string;
	kind: "rule" | "playbook";
	title: string;
	status: string;
	scopeMode: ArtifactScopeMode;
	enabled: boolean;
	reason: string;
	priority: number;
	injection: InjectionProfile;
	estimatedTokens: number;
}

export interface ActivationAudit {
	projectRoot: string;
	entries: ActivationAuditEntry[];
	summary: {
		total: number;
		enabled: number;
		disabled: number;
		global: number;
		explicit: number;
		hidden: number;
		estimatedEnabledTokens: number;
	};
}

function estimatedTokens(artifacts: ArtifactStore, artifact: Artifact): number {
	const text =
		artifact.kind === "rule"
			? previewRule(artifacts, artifact.id)
			: `• ${artifact.title} (when: ${typeof artifact.extra.trigger === "string" ? artifact.extra.trigger : "manual invocation"})`;
	return Math.ceil(text.length / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
}

export function auditArtifactActivation(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRoot: string,
	activeTaskId: string | undefined,
	context: ActivationContext,
): ActivationAudit {
	const rows = [
		...artifacts.query({ kind: "rule", limit: ARTIFACT_SCOPE_MAX_ARTIFACTS }),
		...artifacts.query({ kind: "playbook", limit: ARTIFACT_SCOPE_MAX_ARTIFACTS }),
	] as Artifact[];
	const entries = rows
		.map((artifact): ActivationAuditEntry => {
			const scope = scopes.scope(artifact.id);
			const config = activationConfig(artifact.extra, artifact.kind === "rule" ? "full" : "catalog");
			let decision: { enabled: boolean; reason: string };
			if (artifact.status !== "active") decision = { enabled: false, reason: `lifecycle status is ${artifact.status}` };
			else if (!scopes.appliesToProjectRoot(artifact.id, projectRoot))
				decision = { enabled: false, reason: `scope ${scope.mode} does not apply` };
			else if (artifact.kind === "rule" && artifact.subtype === "artifact-template") {
				decision = { enabled: false, reason: "rule is an artifact template" };
			} else if (artifact.kind === "rule" && !passesRuleRunScope(artifact, activeTaskId)) {
				decision = { enabled: false, reason: "run ownership does not apply" };
			} else decision = evaluateActivation(config, { ...context, projectRoot });
			return {
				id: artifact.id,
				kind: artifact.kind as "rule" | "playbook",
				title: artifact.title,
				status: artifact.status,
				scopeMode: scope.mode,
				...decision,
				priority: config.priority,
				injection: config.injection,
				estimatedTokens: estimatedTokens(artifacts, artifact),
			};
		})
		.sort(
			(left, right) =>
				Number(right.enabled) - Number(left.enabled) || right.priority - left.priority || left.title.localeCompare(right.title),
		);
	return {
		projectRoot,
		entries,
		summary: {
			total: entries.length,
			enabled: entries.filter((entry) => entry.enabled).length,
			disabled: entries.filter((entry) => !entry.enabled).length,
			global: entries.filter((entry) => entry.scopeMode === "all").length,
			explicit: entries.filter((entry) => entry.scopeMode === "explicit").length,
			hidden: entries.filter((entry) => entry.scopeMode === "none").length,
			estimatedEnabledTokens: entries.filter((entry) => entry.enabled).reduce((sum, entry) => sum + entry.estimatedTokens, 0),
		},
	};
}
