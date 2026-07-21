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
		})).toThrow("skill step dependency cycle");
	});
});

describe("Papyrus Skill definitions: skill-call pipeline steps", () => {
	const withSkillCall = {
		...definition,
		blueprints: {
			...definition.blueprints,
			skills: [{ ref: "nested", title: "Nested step", skillId: "some-other-skill-id", dependsOn: ["verify"] }],
		},
	};

	it("validates a skill-call blueprint sharing the task dependency graph, with skillId left unresolved for execution time", () => {
		const validated = validateSkillDefinition(withSkillCall);
		expect(validated.blueprints.skills).toEqual([{ ref: "nested", title: "Nested step", skillId: "some-other-skill-id", dependsOn: ["verify"] }]);
	});

	it("lets an ordinary task depend on a skill-call ref, and vice versa", () => {
		const validated = validateSkillDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				tasks: [...definition.blueprints.tasks, { ref: "after", title: "After nested", dependsOn: ["nested"] }],
				skills: [{ ref: "nested", title: "Nested step", skillId: "other-skill" }],
			},
		});
		expect(validated.blueprints.tasks.find((task) => task.ref === "after")?.dependsOn).toEqual(["nested"]);
	});

	it("rejects a skill-call referencing an unknown dependency or parent ref", () => {
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "nested", title: "Nested", skillId: "x", dependsOn: ["missing"] }] },
		})).toThrow('unknown skill call dependency ref "missing"');
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "nested", title: "Nested", skillId: "x", parent: "missing" }] },
		})).toThrow('unknown skill call parent ref "missing"');
	});

	it("rejects a skill-call parent naming another skill-call ref -- containment must resolve to a real task", () => {
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				skills: [
					{ ref: "first", title: "First", skillId: "x" },
					{ ref: "second", title: "Second", skillId: "y", parent: "first" },
				],
			},
		})).toThrow('unknown skill call parent ref "first"');
	});

	it("rejects a dependency cycle spanning a task and a skill-call step together", () => {
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				tasks: [{ ref: "a", title: "A", dependsOn: ["b"] }],
				skills: [{ ref: "b", title: "B", skillId: "x", dependsOn: ["a"] }],
			},
		})).toThrow("skill step dependency cycle");
	});

	it("rejects a skill-call ref colliding with a task or doc ref -- one shared ref namespace", () => {
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "verify", title: "Collides with a task ref", skillId: "x" }] },
		})).toThrow('duplicate skill blueprint ref "verify"');
	});

	it("rejects a skill-call blueprint missing a skillId", () => {
		expect(() => validateSkillDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "nested", title: "Nested" }] },
		})).toThrow("skill call blueprint skillId");
	});
});
