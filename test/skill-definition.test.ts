import { describe, expect, it } from "bun:test";
import { resolveSkillArguments, validateSkillDefinition } from "../src/domain/skill-definition.ts";

const definition = {
	version: 1,
	inputs: {
		project: { type: "string", required: true },
		environment: { type: "string", default: "development", enum: ["development", "production"] },
		dryRun: { type: "boolean", default: true },
	},
	blueprints: {
		docs: [{ ref: "context", title: "{{project}} context", body: "Environment: {{environment}}" }],
		rules: [{ ref: "safety", title: "Protect {{project}}", condition: "changing {{project}}", action: "Respect dryRun={{dryRun}}" }],
		tasks: [
			{ ref: "verify", title: "Verify {{project}}" },
			{ ref: "change", title: "Change {{project}}", dependsOn: ["verify"] },
		],
	},
	links: [
		{ from: "context", relation: "documents", to: "change" },
		{ from: "change", relation: "follows", to: "safety" },
	],
};

describe("Papyrus Skill definitions", () => {
	it("validates a bounded Task Rule Doc blueprint and normalizes typed arguments", () => {
		const validated = validateSkillDefinition(definition);

		expect(validated.version).toBe(1);
		expect(validated.blueprints.tasks.map((blueprint) => blueprint.ref)).toEqual(["verify", "change"]);
		expect(resolveSkillArguments(validated, { project: "Papyrus" })).toEqual({
			project: "Papyrus",
			environment: "development",
			dryRun: true,
		});
		expect(resolveSkillArguments(validated, { project: "Papyrus", environment: "production", dryRun: false })).toEqual({
			project: "Papyrus",
			environment: "production",
			dryRun: false,
		});
	});

	it("rejects missing, unknown, mistyped, and out-of-enum arguments", () => {
		const validated = validateSkillDefinition(definition);

		expect(() => resolveSkillArguments(validated, {})).toThrow('missing required skill argument "project"');
		expect(() => resolveSkillArguments(validated, { project: "Papyrus", extra: true })).toThrow('unknown skill argument "extra"');
		expect(() => resolveSkillArguments(validated, { project: 42 })).toThrow('skill argument "project" must be a string');
		expect(() => resolveSkillArguments(validated, { project: "Papyrus", environment: "staging" })).toThrow('skill argument "environment" must be one of');
	});

	it("rejects prototype keys at the external definition and argument boundary", () => {
		expect(() => validateSkillDefinition({
			...definition,
			inputs: { constructor: { type: "string" } },
		})).toThrow("reserved skill input name");
		const validated = validateSkillDefinition(definition);
		expect(() => resolveSkillArguments(validated, JSON.parse('{"__proto__":"unsafe","project":"Papyrus"}'))).toThrow("unknown skill argument");
	});

	it("rejects duplicate refs, unresolved links, unknown placeholders, and dependency cycles", () => {
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: { ...definition.blueprints, docs: [{ ref: "verify", title: "Duplicate" }] },
		})).toThrow('duplicate skill blueprint ref "verify"');
		expect(() => validateSkillDefinition({
			...definition,
			links: [{ from: "missing", relation: "documents", to: "change" }],
		})).toThrow('unknown skill blueprint ref "missing"');
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: { ...definition.blueprints, docs: [{ ref: "context", title: "{{unknown}}" }] },
		})).toThrow('unknown skill input placeholder "unknown"');
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				tasks: [
					{ ref: "first", title: "First", dependsOn: ["second"] },
					{ ref: "second", title: "Second", dependsOn: ["first"] },
				],
			},
		})).toThrow("skill task dependency cycle");
	});
});
