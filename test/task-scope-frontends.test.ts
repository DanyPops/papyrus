import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runTaskCli } from "../src/cli.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return { mode: "all", label: "All projects", projectRoot: "/work/papyrus" } as Output;
	}
}

describe("task scope frontends", () => {
	it("exposes stable CLI JSON for the explicit all-projects view", async () => {
		const client = new FakeClient();
		const output = await runTaskCli(["scope", "all", "--json"], client as never, "/work/papyrus");
		expect(JSON.parse(output)).toMatchObject({ mode: "all", label: "All projects" });
		expect(client.calls).toEqual([{
			operation: "tasks.set_scope",
			input: { project_root: "/work/papyrus", scope: "all" },
		}]);
	});

	it("routes Pi cwd through native tools, the browser scope control, and widget reads", () => {
		const tools = readFileSync(new URL("../extension/src/domain-tools.ts", import.meta.url), "utf8");
		const browser = readFileSync(new URL("../extension/src/tasks.ts", import.meta.url), "utf8");
		const extension = readFileSync(new URL("../extension/src/index.ts", import.meta.url), "utf8");
		expect(tools).toContain("params.project_root ?? ctx.cwd");
		expect(tools).toContain('set_scope: "tasks.set_scope"');
		expect(browser).toContain('rawKeyHint("s", "scope")');
		expect(browser).toContain('"All projects"');
		expect(extension).toContain("project_root: this.projectRoot");
		expect(extension).toContain("Tasks · ${projection.scopeLabel}");
	});
});
