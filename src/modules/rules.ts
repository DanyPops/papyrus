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
import { assignRuleProject, createRule, gateTaskWithRule, listRules, previewRule, showRule, transitionRule } from "../domain-services.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ArtifactScopeStore } from "../ports/artifact-scope-store.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";

const MODULE_ID = "rules";

type OperationInput = Record<string, unknown>;

function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

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

/** Registers every rules.* operation except rules.injectable (see module comment). Behavior is unchanged from the prior inline handlers in src/service.ts. */
export function rulesOperations(artifacts: ArtifactStore, scopes: ArtifactScopeStore): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("rules.create", (input: OperationInput) => createRule(artifacts, scopes, {
			title: string(input, "title"), body: optionalString(input, "body"), condition: optionalString(input, "condition"),
			action: optionalString(input, "rule_action") ?? optionalString(input, "governance_action"),
			severity: optionalString(input, "severity") as "block" | "warn" | "info" | undefined,
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			projectRoot: optionalString(input, "project_root"),
		}, eventContext(input))),
		define("rules.list", (input: OperationInput) => listRules(artifacts, scopes, artifactFilter(input))),
		define("rules.show", (input: OperationInput) => showRule(artifacts, string(input, "id"))),
		define("rules.preview", (input: OperationInput) => previewRule(artifacts, string(input, "id"))),
		define("rules.enable", (input: OperationInput) => transitionRule(artifacts, string(input, "id"), "enable", eventContext(input))),
		define("rules.disable", (input: OperationInput) => transitionRule(artifacts, string(input, "id"), "disable", eventContext(input))),
		define("rules.gate", (input: OperationInput) => gateTaskWithRule(artifacts, string(input, "id"), string(input, "task_id"), eventContext(input))),
		define("rules.assign_project", (input: OperationInput) => assignRuleProject(artifacts, scopes, string(input, "id"), optionalString(input, "project_root"))),
	];
}
