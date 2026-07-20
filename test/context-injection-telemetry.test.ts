import { describe, expect, it } from "bun:test";
import { buildContextInjection } from "../extension/src/context-injection-telemetry.ts";

const rules = [
	{ title: "Verify changes", body: "Run affected tests", extra: { condition: "editing code" } },
	{ title: "Protect secrets", body: "Never log tokens", extra: {} },
];

describe("Papyrus context injection telemetry", () => {
	it("measures the exact Rule and Task payload returned to Pi without retaining content", () => {
		const result = buildContextInjection({
			basePrompt: "Base prompt",
			rules,
			taskSummary: "Active: Ship telemetry\nNext: Run tests",
			observedAt: 1_000,
			sequence: 7,
			producerId: "123e4567-e89b-42d3-a456-426614174000",
		});
		expect(result.prompt).toContain("## Active rules (Papyrus)");
		expect(result.prompt).toContain("## Open tasks (Papyrus)");
		expect(result.observation.schema).toBe("papyrus.context-injection/v1");
		expect(result.observation.sequence).toBe(7);
		expect(result.observation.producerId).toBe("123e4567-e89b-42d3-a456-426614174000");
		expect(result.observation.rules.count).toBe(2);
		expect(result.observation.rules.characters).toBe(result.ruleBlock.length);
		expect(result.observation.tasks.characters).toBe(result.taskBlock.length);
		expect(result.observation.injected.characters).toBe(result.prompt.length - "Base prompt".length);
		expect(result.observation.after.characters).toBe(result.prompt.length);
		expect(result.observation.estimatedTokens).toBe(Math.ceil(result.observation.injected.characters / 4));
		expect(result.observation.share).toBe(result.observation.injected.characters / result.prompt.length);
		expect(result.observation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result.observation)).not.toContain("Run affected tests");
		expect(JSON.stringify(result.observation)).not.toContain("Ship telemetry");
	});

	it("reports zero injection and stable unchanged fingerprints", () => {
		const first = buildContextInjection({ basePrompt: "Base", rules: [], taskSummary: null, observedAt: 1, sequence: 1, producerId: "123e4567-e89b-42d3-a456-426614174000" });
		const second = buildContextInjection({
			basePrompt: "Base", rules: [], taskSummary: null, observedAt: 2, sequence: 2,
			producerId: "123e4567-e89b-42d3-a456-426614174000",
			previousFingerprint: first.observation.fingerprint,
		});
		expect(first.prompt).toBe("Base");
		expect(first.observation.injected.characters).toBe(0);
		expect(second.observation.unchanged).toBe(true);
	});
});
