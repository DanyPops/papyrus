import { createHash } from "node:crypto";
import {
	type Artifact,
	activationConfig,
	CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN,
	PAPYRUS_CONTEXT_INJECTION_MAX_TOKENS,
	PAPYRUS_CONTEXT_INJECTION_SCHEMA,
} from "@danypops/papyrus";
import { playbookInjectionPreview } from "../playbook/playbook-bridge.ts";
import { ruleInjectionPreview } from "../rules/rules.ts";

export interface ContextPayloadSize {
	characters: number;
	bytes: number;
}

export interface PapyrusContextInjectionObservation {
	schema: typeof PAPYRUS_CONTEXT_INJECTION_SCHEMA;
	observedAt: number;
	sequence: number;
	producerId: string;
	before: ContextPayloadSize;
	rules: ContextPayloadSize & { count: number; omitted: number };
	playbooks: ContextPayloadSize & { count: number; omitted: number };
	tasks: ContextPayloadSize;
	injected: ContextPayloadSize;
	after: ContextPayloadSize;
	estimatedTokens: number;
	share: number;
	fingerprint: string;
	unchanged: boolean;
}

export interface BuildContextInjectionInput {
	basePrompt: string;
	rules: Array<Pick<Artifact, "title" | "body" | "extra">>;
	playbooks: Array<Pick<Artifact, "title" | "extra">>;
	taskSummary: string | null;
	observedAt: number;
	sequence: number;
	producerId: string;
	previousFingerprint?: string;
	maxEstimatedTokens?: number;
}

const encoder = new TextEncoder();
const RULE_HEADER = "\n\n## Active rules (Papyrus)\n\n";
const PLAYBOOK_HEADER = "\n\n## Available playbooks (Papyrus)\n\n";
const TASK_HEADER = "\n\n## Open tasks (Papyrus)\n\n";

function ruleText(rule: Pick<Artifact, "title" | "body" | "extra">): string {
	const config = activationConfig(rule.extra, "full");
	const condition = typeof rule.extra.condition === "string" ? ` (when: ${rule.extra.condition})` : "";
	if (config.injection === "catalog") return `• ${rule.title}${condition}`;
	return ruleInjectionPreview(rule);
}

interface InjectionCandidate {
	kind: "rule" | "playbook";
	text: string;
	priority: number;
	stableKey: string;
	index: number;
}

function selectWithinBudget(
	input: BuildContextInjectionInput,
	taskBlock: string,
): { ruleIndexes: Set<number>; playbookIndexes: Set<number> } {
	const maxCharacters = (input.maxEstimatedTokens ?? PAPYRUS_CONTEXT_INJECTION_MAX_TOKENS) * CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN;
	let used = taskBlock.length;
	let hasRule = false;
	let hasPlaybook = false;
	const candidates: InjectionCandidate[] = [
		...input.rules.map((rule, index) => ({
			kind: "rule" as const,
			text: ruleText(rule),
			priority: activationConfig(rule.extra, "full").priority,
			stableKey: `${rule.title}\u0000${index}`,
			index,
		})),
		...input.playbooks.map((playbook, index) => ({
			kind: "playbook" as const,
			text: playbookInjectionPreview(playbook),
			priority: activationConfig(playbook.extra, "catalog").priority,
			stableKey: `${playbook.title}\u0000${index}`,
			index,
		})),
	].filter((candidate) => {
		const source = candidate.kind === "rule" ? input.rules[candidate.index] : input.playbooks[candidate.index];
		return activationConfig(source!.extra, candidate.kind === "rule" ? "full" : "catalog").injection !== "on-demand";
	});
	candidates.sort((left, right) => right.priority - left.priority || left.stableKey.localeCompare(right.stableKey));
	const ruleIndexes = new Set<number>();
	const playbookIndexes = new Set<number>();
	for (const candidate of candidates) {
		const firstOfKind = candidate.kind === "rule" ? !hasRule : !hasPlaybook;
		const overhead = firstOfKind ? (candidate.kind === "rule" ? RULE_HEADER.length + 1 : PLAYBOOK_HEADER.length + 1) : 1;
		const cost = candidate.text.length + overhead;
		if (used + cost > maxCharacters) continue;
		used += cost;
		if (candidate.kind === "rule") {
			ruleIndexes.add(candidate.index);
			hasRule = true;
		} else {
			playbookIndexes.add(candidate.index);
			hasPlaybook = true;
		}
	}
	return { ruleIndexes, playbookIndexes };
}

function size(value: string): ContextPayloadSize {
	return { characters: value.length, bytes: encoder.encode(value).byteLength };
}

export function buildContextInjection(input: BuildContextInjectionInput): {
	prompt: string;
	ruleBlock: string;
	playbookBlock: string;
	taskBlock: string;
	observation: PapyrusContextInjectionObservation;
} {
	const taskBlock = input.taskSummary ? `${TASK_HEADER}${input.taskSummary}\n` : "";
	const selected = selectWithinBudget(input, taskBlock);
	const selectedRules = input.rules.filter((_rule, index) => selected.ruleIndexes.has(index));
	const selectedPlaybooks = input.playbooks.filter((_playbook, index) => selected.playbookIndexes.has(index));
	const ruleContent = selectedRules.map(ruleText).join("\n");
	const ruleBlock = ruleContent ? `${RULE_HEADER}${ruleContent}\n` : "";
	const playbookContent = selectedPlaybooks.map(playbookInjectionPreview).join("\n");
	const playbookBlock = playbookContent ? `${PLAYBOOK_HEADER}${playbookContent}\n` : "";
	const injected = `${ruleBlock}${playbookBlock}${taskBlock}`;
	const prompt = `${input.basePrompt}${injected}`;
	const fingerprint = createHash("sha256").update(injected).digest("hex");
	const injectedSize = size(injected);
	const afterSize = size(prompt);
	return {
		prompt,
		ruleBlock,
		playbookBlock,
		taskBlock,
		observation: {
			schema: PAPYRUS_CONTEXT_INJECTION_SCHEMA,
			observedAt: input.observedAt,
			sequence: input.sequence,
			producerId: input.producerId,
			before: size(input.basePrompt),
			rules: { ...size(ruleBlock), count: selectedRules.length, omitted: input.rules.length - selectedRules.length },
			playbooks: {
				...size(playbookBlock),
				count: selectedPlaybooks.length,
				omitted: input.playbooks.length - selectedPlaybooks.length,
			},
			tasks: size(taskBlock),
			injected: injectedSize,
			after: afterSize,
			estimatedTokens: Math.ceil(injectedSize.characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN),
			share: afterSize.characters === 0 ? 0 : injectedSize.characters / afterSize.characters,
			fingerprint,
			unchanged: input.previousFingerprint === fingerprint,
		},
	};
}
