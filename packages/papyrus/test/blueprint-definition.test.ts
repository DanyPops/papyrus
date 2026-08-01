import { describe, expect, it } from "bun:test";
import { resolveBlueprintArguments, validateBlueprintDefinition } from "../src/domain/blueprint-definition.ts";

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

describe("Papyrus blueprint definitions", () => {
	it("validates a bounded Task Rule Doc blueprint and normalizes typed arguments", () => {
		const validated = validateBlueprintDefinition(definition);

		expect(validated.version).toBe(1);
		expect(validated.blueprints.tasks.map((blueprint) => blueprint.ref)).toEqual(["verify", "change"]);
		expect(resolveBlueprintArguments(validated, { project: "Papyrus" })).toEqual({
			project: "Papyrus",
			environment: "development",
			dryRun: true,
		});
		expect(resolveBlueprintArguments(validated, { project: "Papyrus", environment: "production", dryRun: false })).toEqual({
			project: "Papyrus",
			environment: "production",
			dryRun: false,
		});
	});

	it("rejects missing, unknown, mistyped, and out-of-enum arguments", () => {
		const validated = validateBlueprintDefinition(definition);

		expect(() => resolveBlueprintArguments(validated, {})).toThrow('missing required argument "project"');
		expect(() => resolveBlueprintArguments(validated, { project: "Papyrus", extra: true })).toThrow('unknown argument "extra"');
		expect(() => resolveBlueprintArguments(validated, { project: 42 })).toThrow('argument "project" must be a string');
		expect(() => resolveBlueprintArguments(validated, { project: "Papyrus", environment: "staging" })).toThrow('argument "environment" must be one of');
	});

	it("rejects prototype keys at the external definition and argument boundary", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			inputs: { constructor: { type: "string" } },
		})).toThrow("reserved input name");
		const validated = validateBlueprintDefinition(definition);
		expect(() => resolveBlueprintArguments(validated, JSON.parse('{"__proto__":"unsafe","project":"Papyrus"}'))).toThrow("unknown argument");
	});

	it("rejects duplicate refs, unresolved links, unknown placeholders, and dependency cycles", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: { ...definition.blueprints, docs: [{ ref: "verify", title: "Duplicate" }] },
		})).toThrow('duplicate blueprint ref "verify"');
		expect(() => validateBlueprintDefinition({
			...definition,
			links: [{ from: "missing", relation: "documents", to: "change" }],
		})).toThrow('unknown blueprint ref "missing"');
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: { ...definition.blueprints, docs: [{ ref: "context", title: "{{unknown}}" }] },
		})).toThrow('unknown input placeholder "unknown"');
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				tasks: [
					{ ref: "first", title: "First", dependsOn: ["second"] },
					{ ref: "second", title: "Second", dependsOn: ["first"] },
				],
			},
		})).toThrow("step dependency cycle");
	});
});

describe("Papyrus blueprint definitions: call pipeline steps", () => {
	const withCall = {
		...definition,
		blueprints: {
			...definition.blueprints,
			skills: [{ ref: "nested", title: "Nested step", targetId: "some-other-target-id", dependsOn: ["verify"] }],
		},
	};

	it("validates a call blueprint sharing the task dependency graph, with targetId left unresolved for execution time", () => {
		const validated = validateBlueprintDefinition(withCall);
		expect(validated.blueprints.skills).toEqual([{ ref: "nested", title: "Nested step", targetId: "some-other-target-id", dependsOn: ["verify"] }]);
	});

	it("lets an ordinary task depend on a call ref, and vice versa", () => {
		const validated = validateBlueprintDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				tasks: [...definition.blueprints.tasks, { ref: "after", title: "After nested", dependsOn: ["nested"] }],
				skills: [{ ref: "nested", title: "Nested step", targetId: "other-target" }],
			},
		});
		expect(validated.blueprints.tasks.find((task) => task.ref === "after")?.dependsOn).toEqual(["nested"]);
	});

	it("rejects a call referencing an unknown dependency or parent ref", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "nested", title: "Nested", targetId: "x", dependsOn: ["missing"] }] },
		})).toThrow('unknown call dependency ref "missing"');
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "nested", title: "Nested", targetId: "x", parent: "missing" }] },
		})).toThrow('unknown call parent ref "missing"');
	});

	it("rejects a call parent naming another call ref -- containment must resolve to a real task", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				skills: [
					{ ref: "first", title: "First", targetId: "x" },
					{ ref: "second", title: "Second", targetId: "y", parent: "first" },
				],
			},
		})).toThrow('unknown call parent ref "first"');
	});

	it("rejects a dependency cycle spanning a task and a call step together", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: {
				...definition.blueprints,
				tasks: [{ ref: "a", title: "A", dependsOn: ["b"] }],
				skills: [{ ref: "b", title: "B", targetId: "x", dependsOn: ["a"] }],
			},
		})).toThrow("step dependency cycle");
	});

	it("rejects a call ref colliding with a task or doc ref -- one shared ref namespace", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "verify", title: "Collides with a task ref", targetId: "x" }] },
		})).toThrow('duplicate blueprint ref "verify"');
	});

	it("rejects a call blueprint missing a targetId", () => {
		expect(() => validateBlueprintDefinition({
			...definition,
			blueprints: { ...definition.blueprints, skills: [{ ref: "nested", title: "Nested" }] },
		})).toThrow("call blueprint targetId");
	});
});
