import { createHash } from "node:crypto";
import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN, PAPYRUS_CONTEXT_INJECTION_SCHEMA, type Artifact } from "@danypops/papyrus";
import { ruleInjectionPreview } from "./rules.ts";
import { playbookInjectionPreview } from "./playbook-bridge.ts";

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
	rules: ContextPayloadSize & { count: number };
	playbooks: ContextPayloadSize & { count: number };
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
}

const encoder = new TextEncoder();

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
	const ruleContent = input.rules.map(ruleInjectionPreview).join("\n");
	const ruleBlock = ruleContent ? `\n\n## Active rules (Papyrus)\n\n${ruleContent}\n` : "";
	const playbookContent = input.playbooks.map(playbookInjectionPreview).join("\n");
	const playbookBlock = playbookContent ? `\n\n## Available playbooks (Papyrus)\n\n${playbookContent}\n` : "";
	const taskBlock = input.taskSummary ? `\n\n## Open tasks (Papyrus)\n\n${input.taskSummary}\n` : "";
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
			rules: { ...size(ruleBlock), count: input.rules.length },
			playbooks: { ...size(playbookBlock), count: input.playbooks.length },
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
