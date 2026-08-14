/**
 * playbook-execution.ts — playbooks.invoke's real implementation: compile the Playbook's
 * composition tree (playbook-definition.ts) into a BlueprintDefinition, materialize it through
 * workflow-execution.ts's shared engine, mirror any pre-existing Rule/Doc links onto the
 * generated root task, and report which task to focus. No text is rendered here -- every
 * step is its own Task, and only the currently-focused one is ever surfaced to an agent
 * (via the existing Task Focus system-prompt pointer), which is what actually avoids the
 * old text-dump problem: one page at a time, not the whole book at once.
 */

import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { requireAtomicArtifactStore } from "../artifact/atomic-artifact-store.ts";
import type { TaskExecutionPlan } from "../task/task-execution.ts";
import type { BlueprintArgumentValue } from "./blueprint-definition.ts";
import { compilePlaybookDefinition } from "./playbook-definition.ts";
import {
	applyPlaybookExternalLinks,
	materializeWorkflowDefinition,
	resolveRefToTaskId,
	type WorkflowRunHistory,
} from "./workflow-execution.ts";

export interface InvokePlaybookInput {
	runId?: string;
	arguments?: Record<string, unknown>;
}

export interface PlaybookInvocationResult {
	playbookId: string;
	runId: string;
	arguments: Record<string, BlueprintArgumentValue>;
	created: { docs: string[]; rules: string[]; tasks: string[] };
	rootTaskIds: string[];
	/** The one task to focus -- the first real leaf in the whole composition tree's reading order (deepest prerequisite's own first step, or this playbook's own first step, or its first nested child's, or the container task itself when there is nothing else). */
	entryTaskId: string;
	execution: TaskExecutionPlan;
}

export interface PlaybookMissingArguments {
	playbookId: string;
	/** Nothing was created: ask the human for these (discuss tool, live:true) before invoking again with them supplied. */
	missingArguments: string[];
}

function missingRequiredInputs(
	inputs: Record<string, { required?: boolean; default?: BlueprintArgumentValue }>,
	provided: Record<string, unknown>,
): string[] {
	return Object.entries(inputs)
		.filter(([name, input]) => input.required && provided[name] === undefined && input.default === undefined)
		.map(([name]) => name);
}

export function invokePlaybook(
	artifacts: ArtifactStore,
	playbookId: string,
	input: InvokePlaybookInput,
	history?: WorkflowRunHistory,
): PlaybookInvocationResult | PlaybookMissingArguments {
	const compiled = compilePlaybookDefinition(artifacts, playbookId);
	const missingArguments = missingRequiredInputs(compiled.definition.inputs, input.arguments ?? {});
	if (missingArguments.length > 0) return { playbookId, missingArguments };

	const atomic = history
		? history.events.atomic.bind(history.events)
		: requireAtomicArtifactStore(artifacts).atomic.bind(requireAtomicArtifactStore(artifacts));
	return atomic(() => {
		const result = materializeWorkflowDefinition(
			artifacts,
			{ ownerId: playbookId, extraKey: "playbookRun", labelPrefix: "playbook-run" },
			compiled.definition,
			{ runId: input.runId, arguments: input.arguments, focusRef: compiled.entryRef },
			history,
			new Set(),
			0,
		);
		const refToTaskId = resolveRefToTaskId(artifacts, result.created.tasks, "playbookRun");
		applyPlaybookExternalLinks(artifacts, compiled.externalLinks, refToTaskId);
		return {
			playbookId,
			runId: result.runId,
			arguments: result.arguments,
			created: { docs: result.created.docs, rules: result.created.rules, tasks: result.created.tasks },
			rootTaskIds: result.rootTaskIds,
			entryTaskId: result.entryTaskId!,
			execution: result.execution,
		};
	});
}
