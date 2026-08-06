/**
 * modules/rules.ts — Rules as a Papyrus-native registered module
 * (step 5, continued, of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo).
 *
 * rules.injectable is intentionally NOT registered here even though its operation name
 * starts with "rules.": its implementation requires tasks.active() (the current Task
 * Focus) to decide which scoped rules apply, a genuine cross-module concern. It stays a
 * composition-root operation in src/service.ts rather than importing Tasks internals
 * into this module or introducing a premature "modules call each other through the
 * registry" convention.
 */

import { type Artifact, summarizeArtifact } from "../artifact/artifact.ts";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import {
	assignRuleProject,
	createRule,
	gateTaskWithRule,
	listRules,
	previewRule,
	ruleCombinedLength,
	ruleCombinedLengthWarning,
	showRule,
	transitionRule,
	updateRule,
} from "../domain-services.ts";
import type { OperationDefinition } from "../module-registry.ts";
import { type OperationInput, optionalBoolean, optionalNumber, optionalString, string } from "./operation-input.ts";

const MODULE_ID = "rules";

const eventContext = (input: OperationInput) => ({
	actor: optionalString(input, "actor"),
	source: optionalString(input, "source"),
	sessionId: optionalString(input, "session_id") ?? optionalString(input, "sessionId"),
});

const artifactFilter = (input: OperationInput) => ({
	status: optionalString(input, "status"),
	text: optionalString(input, "text"),
	limit: optionalNumber(input, "limit"),
	projectRoot: optionalString(input, "project_root"),
});

/**
 * Adds a rule's own combinedLength (and, past the soft target, a non-blocking warning) to any
 * response shaped as its own Artifact -- additive fields alongside every existing one, so a
 * caller reading .id/.title/... unchanged still works. Removes the need for a manual
 * len(condition)+len(action)+len(body) count before every rules.create/update call.
 */
function withRuleLengthInfo(rule: Artifact): Artifact & { combinedLength: number; warning?: string } {
	const combinedLength = ruleCombinedLength(
		typeof rule.extra.condition === "string" ? rule.extra.condition : undefined,
		typeof rule.extra.action === "string" ? rule.extra.action : undefined,
		rule.body,
	);
	const warning = ruleCombinedLengthWarning(combinedLength);
	return { ...rule, combinedLength, ...(warning === undefined ? {} : { warning }) };
}

/** Registers every rules.* operation except rules.injectable (see module comment). Behavior is unchanged from the prior inline handlers in src/service.ts. */
/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. rules.injectable is deliberately absent -- see the module comment above. */
export const RULES_OPERATION_NAMES = [
	"rules.create",
	"rules.list",
	"rules.show",
	"rules.preview",
	"rules.enable",
	"rules.disable",
	"rules.gate",
	"rules.assign_project",
	"rules.update",
] as const;

export function rulesOperations(artifacts: ArtifactStore, scopes: ArtifactScopeStore): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("rules.create", (input: OperationInput) =>
			withRuleLengthInfo(
				createRule(
					artifacts,
					scopes,
					{
						title: string(input, "title"),
						body: optionalString(input, "body"),
						condition: optionalString(input, "condition"),
						action: optionalString(input, "rule_action") ?? optionalString(input, "governance_action"),
						severity: optionalString(input, "severity") as "block" | "warn" | "info" | undefined,
						labels: input.labels as string[] | undefined,
						extra: input.extra as Record<string, unknown> | undefined,
						projectRoot: optionalString(input, "project_root"),
					},
					eventContext(input),
				),
			),
		),
		define("rules.list", (input: OperationInput) => {
			const rules = listRules(artifacts, scopes, artifactFilter(input));
			return optionalBoolean(input, "full") === true ? rules : rules.map(summarizeArtifact);
		}),
		define("rules.show", (input: OperationInput) => withRuleLengthInfo(showRule(artifacts, string(input, "id")))),
		define("rules.preview", (input: OperationInput) => {
			const rule = showRule(artifacts, string(input, "id"));
			const combinedLength = ruleCombinedLength(
				typeof rule.extra.condition === "string" ? rule.extra.condition : undefined,
				typeof rule.extra.action === "string" ? rule.extra.action : undefined,
				rule.body,
			);
			const warning = ruleCombinedLengthWarning(combinedLength);
			return { preview: previewRule(artifacts, string(input, "id")), combinedLength, ...(warning === undefined ? {} : { warning }) };
		}),
		define("rules.enable", (input: OperationInput) => transitionRule(artifacts, string(input, "id"), "enable", eventContext(input))),
		define("rules.disable", (input: OperationInput) => transitionRule(artifacts, string(input, "id"), "disable", eventContext(input))),
		define("rules.gate", (input: OperationInput) =>
			gateTaskWithRule(artifacts, string(input, "id"), string(input, "task_id"), eventContext(input)),
		),
		define("rules.assign_project", (input: OperationInput) =>
			assignRuleProject(artifacts, scopes, string(input, "id"), optionalString(input, "project_root")),
		),
		define("rules.update", (input: OperationInput) =>
			withRuleLengthInfo(
				updateRule(
					artifacts,
					string(input, "id"),
					{
						title: optionalString(input, "title"),
						body: optionalString(input, "body"),
						labels: input.labels as string[] | undefined,
					},
					eventContext(input),
				),
			),
		),
	];
}
