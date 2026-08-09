/**
 * Rule domain composition logic (create/list/show/preview/transition/update/gate), split out
 * of the former domain-services.ts into its own per-domain file alongside
 * docs/docs-service.ts and playbook/playbook-service.ts. Shared, kind-agnostic helpers live
 * in ../domain-service-shared.ts.
 */

import type { Artifact } from "../artifact/artifact.ts";
import { requireLocallyOwnedContent } from "../artifact/artifact.ts";
import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { RULE_TEXT_HARD_LIMIT_CHARACTERS, RULE_TEXT_SOFT_TARGET_CHARACTERS } from "../constants.ts";
import { normalizeProjectRoot } from "../domain/task-scope.ts";
import {
	assertLabelsBounds,
	assertTitleBounds,
	assignArtifactProject,
	type ListFilter,
	listScoped,
	requireContentUpdateFields,
	requireKind,
	runTransition,
	type TransitionTable,
	type UpdateContentInput,
} from "../domain-service-shared.ts";

export interface CreateRuleInput {
	title: string;
	body?: string;
	condition?: string;
	action?: string;
	severity?: "block" | "warn" | "info";
	subtype?: string;
	labels?: string[];
	extra?: Record<string, unknown>;
	templateId?: string;
	projectRoot?: string;
}

export type RuleTransition = "enable" | "disable";

const RULE_TRANSITIONS: TransitionTable<RuleTransition, string> = {
	enable: { from: ["deprecated"], to: "active" },
	disable: { from: ["active"], to: "deprecated" },
};

/**
 * A Rule's condition+action+body is injected into every relevant turn for the rule's entire
 * lifetime -- a permanent tax on every future turn's context budget, not a one-time cost.
 * Rejects (rather than silently truncating or merely warning) once a rule is unambiguously
 * bloated, since a silently-truncated rule would inject different text than what its author
 * reviewed, and a warning nobody reads is not a bound. See RULE_TEXT_HARD_LIMIT_CHARACTERS's
 * own comment in constants.ts for the research this threshold is grounded in.
 */
export function ruleCombinedLength(condition: string | undefined, action: string | undefined, body: string | undefined): number {
	return (condition ?? "").length + (action ?? "").length + (body ?? "").length;
}

/**
 * Non-blocking counterpart to assertRuleTextWithinBounds's hard rejection: the same combined
 * length, informational once it crosses the soft target, so a caller doesn't have to self-police
 * with a manual character count before every rules.create/update. Returns undefined at or under
 * the target -- the common case, not worth a field only ever seen as "undefined" on the wire.
 */
export function ruleCombinedLengthWarning(combinedLength: number): string | undefined {
	if (combinedLength <= RULE_TEXT_SOFT_TARGET_CHARACTERS) return undefined;
	return (
		`condition+action+body is ${combinedLength} characters, over the ${RULE_TEXT_SOFT_TARGET_CHARACTERS}-character soft target ` +
		`(hard limit ${RULE_TEXT_HARD_LIMIT_CHARACTERS}) -- consider moving detail into a linked Doc.`
	);
}

function assertRuleTextWithinBounds(condition: string | undefined, action: string | undefined, body: string | undefined): void {
	const combined = ruleCombinedLength(condition, action, body);
	if (combined > RULE_TEXT_HARD_LIMIT_CHARACTERS) {
		throw new Error(
			`rule condition+action+body is ${combined} characters, exceeding the ${RULE_TEXT_HARD_LIMIT_CHARACTERS}-character bound. ` +
				"A Rule is injected into every relevant turn for its entire lifetime -- this is a permanent context-budget tax, not a one-time cost. " +
				"Split it: keep a short Rule (the condition and the invariant itself), and move the full reasoning, examples, and research into a linked Doc.",
		);
	}
}

export function createRule(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	input: CreateRuleInput,
	context?: ArtifactEventContext,
): Artifact {
	assertRuleTextWithinBounds(input.condition, input.action, input.body);
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const rule = artifacts.create(
		{
			kind: "rule",
			status: "active", // explicit; see createDocument for why defaultStatusFor is not trusted here
			title: input.title,
			body: input.body,
			subtype: input.subtype,
			labels: input.labels,
			extra: {
				...(input.extra ?? {}),
				...(input.condition ? { condition: input.condition } : {}),
				...(input.action ? { action: input.action } : {}),
				severity: input.severity ?? "info",
			},
			templateId: input.templateId,
		},
		context,
	);
	scopes.assign(rule.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	return rule;
}

export function listRules(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, "rule", filter);
}

export function assignRuleProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	id: string,
	projectRoot: string | undefined,
): Artifact {
	return assignArtifactProject(artifacts, scopes, id, "rule", projectRoot);
}

/**
 * Global rules always apply; scoped workflow-run rules apply only while their run owns active
 * focus. Both a workflow-definition target's own run scope ("skill-run", written by
 * workflow-execution.ts's runWorkflowSteps for that target kind) and a Playbook's own run scope
 * ("playbook-run", same call for a Playbook target) are recognized -- confirmed live that only
 * "skill-run" was ever checked here, silently breaking Playbook-run-scoped rule injection since
 * Playbook gained its own doc/rule structured steps.
 */
export function listInjectableRules(artifacts: ArtifactStore, activeTaskId?: string): Artifact[] {
	return artifacts.query({ kind: "rule", status: "active" }).filter((rule) => {
		const scope = rule.extra.scope;
		if (scope === undefined) return true;
		if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
		const value = scope as Record<string, unknown>;
		if ((value.type !== "skill-run" && value.type !== "playbook-run") || !Array.isArray(value.taskIds)) return false;
		return activeTaskId !== undefined && value.taskIds.some((id) => id === activeTaskId);
	});
}

export function showRule(artifacts: ArtifactStore, id: string): Artifact {
	requireKind(artifacts, id, "rule");
	return artifacts.get(id, { tree: true })!;
}

export function previewRule(artifacts: ArtifactStore, id: string): string {
	const rule = requireKind(artifacts, id, "rule");
	const condition = typeof rule.extra.condition === "string" ? ` (when: ${rule.extra.condition})` : "";
	const action = rule.body || (typeof rule.extra.action === "string" ? rule.extra.action : "");
	return `• ${rule.title}${condition}\n  ${action}`;
}

export function transitionRule(artifacts: ArtifactStore, id: string, action: RuleTransition, context?: ArtifactEventContext): Artifact {
	const rule = requireLocallyOwnedContent(requireKind(artifacts, id, "rule"));
	return runTransition(artifacts, rule, "rule", action, RULE_TRANSITIONS, context);
}

export type UpdateRuleInput = UpdateContentInput;

/** A Rule's body update stays under the same combined condition+action+body ceiling as creation -- a permanent per-turn injection cost doesn't get looser just because it's an edit, not a create. */
export function updateRule(artifacts: ArtifactStore, id: string, input: UpdateRuleInput, context?: ArtifactEventContext): Artifact {
	requireContentUpdateFields(input);
	assertTitleBounds(input.title);
	assertLabelsBounds(input.labels);
	const rule = requireLocallyOwnedContent(requireKind(artifacts, id, "rule"));
	if (input.body !== undefined) {
		const condition = typeof rule.extra.condition === "string" ? rule.extra.condition : undefined;
		const action = typeof rule.extra.action === "string" ? rule.extra.action : undefined;
		assertRuleTextWithinBounds(condition, action, input.body);
	}
	const updated = artifacts.updateContent(id, input, context);
	if (!updated) throw new Error(`rule "${id}" not found`);
	return updated;
}

export function gateTaskWithRule(artifacts: ArtifactStore, ruleId: string, taskId: string, context?: ArtifactEventContext): Artifact {
	requireLocallyOwnedContent(requireKind(artifacts, ruleId, "rule"));
	requireKind(artifacts, taskId, "task");
	artifacts.link({ from: ruleId, relation: "gates", to: taskId }, context);
	return showRule(artifacts, ruleId);
}
