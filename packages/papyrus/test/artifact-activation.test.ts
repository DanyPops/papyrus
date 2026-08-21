import { describe, expect, test } from "bun:test";
import {
	type ActivationContext,
	activationConfig,
	evaluateActivation,
	validateActivationConfig,
} from "../src/artifact/artifact-activation.ts";

const context: ActivationContext = {
	projectRoot: "/workspace/papyrus",
	taskStatus: "in-progress",
	taskLabels: ["typescript", "release"],
	languages: ["typescript"],
	fileExtensions: [".ts", ".json"],
	toolName: "edit",
	operationName: "rules.update",
	sessionCapabilities: ["network", "filesystem"],
};

describe("artifact activation predicates", () => {
	test("evaluates bounded all/any/not predicates over trusted context fields", () => {
		const activation = validateActivationConfig({
			predicate: {
				all: [
					{ field: "project.root", operator: "eq", value: "/workspace/papyrus" },
					{ field: "task.labels", operator: "contains_all", value: ["typescript", "release"] },
					{
						any: [
							{ field: "tool.name", operator: "eq", value: "bash" },
							{ field: "tool.name", operator: "eq", value: "edit" },
						],
					},
					{ not: { field: "task.status", operator: "eq", value: "done" } },
				],
			},
			priority: 25,
			injection: "catalog",
		});

		expect(evaluateActivation(activation, context)).toEqual({ enabled: true, reason: "enabled" });
		expect(activation.priority).toBe(25);
		expect(activation.injection).toBe("catalog");
	});

	test("fails closed when a required context parameter is absent", () => {
		const activation = validateActivationConfig({
			predicate: { field: "languages", operator: "contains_any", value: ["rust"] },
		});
		expect(evaluateActivation(activation, {})).toEqual({
			enabled: false,
			reason: "activation context field languages is unavailable",
		});
	});

	test("rejects unknown fields, operators, and malformed values", () => {
		expect(() => validateActivationConfig({ predicate: { field: "cwd", operator: "eq", value: "x" } })).toThrow(
			/unsupported activation field/,
		);
		expect(() => validateActivationConfig({ predicate: { field: "project.root", operator: "matches", value: ".*" } })).toThrow(
			/unsupported activation operator/,
		);
		expect(() => validateActivationConfig({ predicate: { field: "project.root", operator: "contains_any", value: ["x"] } })).toThrow(
			/requires an array-valued field/,
		);
	});

	test("bounds predicate depth and total nodes", () => {
		let deep: unknown = { field: "project.root", operator: "exists", value: true };
		for (let index = 0; index < 10; index++) deep = { not: deep };
		expect(() => validateActivationConfig({ predicate: deep })).toThrow(/depth/);
		expect(() =>
			validateActivationConfig({
				predicate: {
					all: Array.from({ length: 65 }, () => ({ field: "project.root", operator: "exists", value: true })),
				},
			}),
		).toThrow(/nodes/);
	});

	test("defaults legacy artifacts to enabled, full injection, and neutral priority", () => {
		const config = activationConfig({});
		expect(config).toEqual({ priority: 0, injection: "full" });
		expect(evaluateActivation(config, {})).toEqual({ enabled: true, reason: "enabled" });
	});

	test("keeps on-demand artifacts activatable while leaving injection policy to the context selector", () => {
		const config = validateActivationConfig({ injection: "on-demand" });
		expect(evaluateActivation(config, {})).toEqual({ enabled: true, reason: "enabled" });
	});

	test("malformed persisted activation fails closed instead of breaking injection", () => {
		const config = activationConfig({ activation: { predicate: { field: "unknown", operator: "eq", value: "x" } } });
		expect(evaluateActivation(config, context)).toEqual({ enabled: false, reason: "invalid activation configuration" });
	});
});
