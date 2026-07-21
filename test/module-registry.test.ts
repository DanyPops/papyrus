import { describe, expect, it } from "bun:test";
import { OperationRegistry, type OperationDefinition } from "../src/module-registry.ts";

function op(name: string, moduleId: string, execute: (input: unknown) => unknown = () => undefined): OperationDefinition {
	return { name, moduleId, execute };
}

describe("OperationRegistry — branch-by-abstraction over the operation switch", () => {
	it("registers and looks up an operation in O(1) by name", () => {
		const registry = new OperationRegistry();
		const capture = op("notes.capture", "notes", (input) => ({ received: input }));
		registry.register(capture);

		expect(registry.get("notes.capture")).toBe(capture);
		expect(registry.has("notes.capture")).toBe(true);
		expect(registry.get("unknown.op")).toBeUndefined();
	});

	it("rejects a duplicate operation name naming the module that already owns it", () => {
		const registry = new OperationRegistry();
		registry.register(op("notes.capture", "notes"));
		expect(() => registry.register(op("notes.capture", "some-other-module"))).toThrow(
			'operation "notes.capture" is already registered by module "notes"',
		);
	});

	it("registerAll registers every descriptor and stops at the first duplicate", () => {
		const registry = new OperationRegistry();
		registry.registerAll([op("notes.capture", "notes"), op("notes.list", "notes"), op("notes.show", "notes")]);
		expect(registry.list()).toEqual(["notes.capture", "notes.list", "notes.show"]);
		expect(() => registry.registerAll([op("notes.capture", "notes-again")])).toThrow(/already registered/);
	});

	it("list is bounded by registration count and returns sorted names for stable diagnostics", () => {
		const registry = new OperationRegistry();
		registry.registerAll([op("tasks.create", "tasks"), op("docs.create", "docs"), op("notes.capture", "notes")]);
		expect(registry.list()).toEqual(["docs.create", "notes.capture", "tasks.create"]);
	});

	it("executes the registered operation's own logic, not a shared dispatcher branch", async () => {
		const registry = new OperationRegistry();
		registry.register(op("echo", "test-module", (input) => ({ echoed: input })));
		const result = await registry.get("echo")!.execute({ value: 1 });
		expect(result).toEqual({ echoed: { value: 1 } });
	});
});
