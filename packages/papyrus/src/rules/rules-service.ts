/**
 * Rule domain composition logic (create/list/show/preview/transition/update/gate), split out
 * of the former domain-services.ts into its own per-domain file alongside
 * docs/docs-service.ts and playbook/playbook-service.ts. Shared, kind-agnostic helpers live
 * in ../domain-service-shared.ts.
 */

import type { Artifact } from "../artifact/artifact.ts";
import { requireLocallyOwnedContent } from "../artifact/artifact.ts";
import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { ArtifactScope, ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { RULE_TEXT_HARD_LIMIT_CHARACTERS, RULE_TEXT_SOFT_TARGET_CHARACTERS } from "../constants.ts";
import { normalizeProjectRoot } from "../task-scope/task-scope.ts";
import {
	addArtifactScopeGroup,
	addArtifactScopeProject,
	assertLabelsBounds,
	assertTitleBounds,
	assignArtifactProject,
	type ListFilter,
	listScoped,
	removeArtifactScopeGroup,
	removeArtifactScopeProject,
	replaceArtifactScopeGroups,
	replaceArtifactScopeProjects,
	requireContentUpdateFields,
	requireKind,
	runTransition,
	setArtifactScopeNone,
	type TransitionTable,
	type UpdateContentInput,
} from "../domain-service-shared.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";

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
	/** Bounded exact registered project references (id/name/alias/root) -- fail-closed unlike projectRoot's auto-register-by-root legacy form. Takes precedence over projectRoot when both are given. */
	projectReferences?: string[];
}

export type RuleTransition = "enable" | "disable";

const RULE_TRANSITIONS: TransitionTable<RuleTransition, string> = {
	enable: { from: ["draft", "deprecated"], to: "active" },
	disable: { from: ["active"], to: "deprecated" },
};

function valueAtPath(value: unknown, path: string): unknown {
	return path
		.split(".")
		.reduce<unknown>(
			(current, segment) =>
				typeof current === "object" && current !== null && !Array.isArray(current)
					? (current as Record<string, unknown>)[segment]
					: undefined,
			value,
		);
}

function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function assertTemplateConformance(artifacts: ArtifactStore, rule: Artifact): void {
	const templateId = rule.extra.templateId;
	if (typeof templateId !== "string" || templateId.length === 0) return;
	const template = artifacts.get(templateId);
	if (!template) throw new Error(`rule template "${templateId}" not found`);
	if (template.subtype !== "artifact-template" || template.extra.targetKind !== "rule") {
		throw new Error(`artifact "${templateId}" is not a Rule artifact template`);
	}
	const required = Array.isArray(template.extra.completionRequired)
		? template.extra.completionRequired.filter((field): field is string => typeof field === "string")
		: [];
	for (const field of required) {
		if (!isPresent(valueAtPath(rule, field))) {
			throw new Error(`rule does not conform to template "${templateId}": missing completion-required field "${field}"`);
		}
	}
}

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
	registry?: ProjectRegistryStore,
): Artifact {
	assertRuleTextWithinBounds(input.condition, input.action, input.body);
	if (input.projectReferences !== undefined && input.projectReferences.length > 0 && registry === undefined) {
		throw new Error("projectReferences requires a project registry");
	}
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const rule = artifacts.create(
		{
			kind: "rule",
			status: input.templateId === undefined ? "active" : "draft",
			title: input.title,
			body: input.body,
			subtype: input.subtype,
			labels: input.labels,
			extra: {
				...(input.extra ?? {}),
				...(input.condition ? { condition: input.condition } : {}),
				...(input.action ? { action: input.action } : {}),
				severity: input.severity ?? "info",
				...(input.templateId === undefined ? {} : { templateId: input.templateId }),
			},
			templateId: input.templateId,
		},
		context,
	);
	if (input.projectReferences !== undefined && input.projectReferences.length > 0) {
		replaceArtifactScopeProjects(scopes, registry!, rule.id, input.projectReferences);
	} else {
		scopes.assign(rule.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	}
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
 * The multi-project scope surface rules.assign_project cannot express (more than one membership,
 * or exact fail-closed reference resolution instead of assign's auto-register-by-root). id is
 * resolved through requireKind so these reject the same way against a non-Rule or unknown id as
 * every other rules.* mutation; the project REFERENCE (name/alias/root) is resolved through the
 * shared registry's resolveProjectReference, so an unknown or ambiguous project fails closed with
 * bounded candidates rather than silently creating a new registration or guessing.
 */
export function ruleScope(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return scopes.scope(id);
}

export function setRuleGlobal(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return scopes.setAll(id, "explicit");
}

/** Fully hides this Rule -- never applicable, never injected, regardless of project. */
export function setRuleNone(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return setArtifactScopeNone(scopes, id);
}

export function replaceRuleProjects(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReferences: readonly string[],
): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return replaceArtifactScopeProjects(scopes, registry, id, projectReferences);
}

export function addRuleProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return addArtifactScopeProject(scopes, registry, id, projectReference);
}

export function removeRuleProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projectReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return removeArtifactScopeProject(scopes, registry, id, projectReference);
}

/** Scope-group ('nested scope') siblings of replaceRuleProjects/addRuleProject/removeRuleProject. */
export function replaceRuleGroups(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReferences: readonly string[],
): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return replaceArtifactScopeGroups(scopes, scopeGroups, id, groupReferences);
}

export function addRuleGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return addArtifactScopeGroup(scopes, scopeGroups, id, groupReference);
}

export function removeRuleGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	scopeGroups: ScopeGroupStore,
	id: string,
	groupReference: string,
): ArtifactScope {
	requireKind(artifacts, id, "rule");
	return removeArtifactScopeGroup(scopes, scopeGroups, id, groupReference);
}

/** The extra.scope run-gating check alone -- a Rule with no extra.scope always passes this; one with a skill-run/playbook-run scope passes only while its run owns activeTaskId. Both a workflow-definition target's own run scope ("skill-run", written by workflow-execution.ts's runWorkflowSteps for that target kind) and a Playbook's own run scope ("playbook-run", same call for a Playbook target) are recognized -- confirmed live that only "skill-run" was ever checked here, silently breaking Playbook-run-scoped rule injection since Playbook gained its own doc/rule structured steps. */
function passesRunScope(rule: Artifact, activeTaskId: string | undefined): boolean {
	const scope = rule.extra.scope;
	if (scope === undefined) return true;
	if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
	const value = scope as Record<string, unknown>;
	if ((value.type !== "skill-run" && value.type !== "playbook-run") || !Array.isArray(value.taskIds)) return false;
	return activeTaskId !== undefined && value.taskIds.some((id) => id === activeTaskId);
}

/**
 * Global rules always apply everywhere; a project-bound Rule (ArtifactScopeStore's own
 * project-membership scope, orthogonal to extra.scope's run-gating) is applicable only when
 * projectRoot resolves to one of its registered project memberships. Both checks are an AND, not
 * an alternative: extra.scope's own run-gating can no longer bypass project scope, and project
 * membership can no longer bypass run-gating -- confirmed live that a project-bound Rule was
 * injected into every project before this fix, since this function never consulted
 * ArtifactScopeStore at all despite rules.assign_project already existing.
 */
export function listInjectableRules(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRoot: string | undefined,
	activeTaskId?: string,
): Artifact[] {
	return artifacts.query({ kind: "rule", status: "active" }).filter((rule) => {
		if (rule.subtype === "artifact-template") return false;
		return passesRunScope(rule, activeTaskId) && scopes.appliesToProjectRoot(rule.id, projectRoot);
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
	if (action === "enable" && (rule.status === "draft" || rule.status === "deprecated")) assertTemplateConformance(artifacts, rule);
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
