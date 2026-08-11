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
		expect(client.calls).toEqual([
			{
				operation: "tasks.set_scope",
				input: { project_root: "/work/papyrus", scope: "all" },
			},
		]);
	});

	it("requires project_root explicitly server-side now that tasks is Vehicle-projected (no ambient Pi cwd there), while the browser scope control and status widget keep routing Pi's own cwd", () => {
		const tasksVehicle = readFileSync(new URL("../src/handlers/tasks.ts", import.meta.url), "utf8");
		const browser = readFileSync(new URL("../../pi-papyrus/extension/src/task/tasks.ts", import.meta.url), "utf8");
		const extension = readFileSync(new URL("../../pi-papyrus/extension/src/index.ts", import.meta.url), "utf8");
		expect(tasksVehicle).toContain('"set_scope"');
		expect(tasksVehicle).toContain("no ambient cwd server-side");
		expect(browser).toContain('rawKeyHint("s", "scope")');
		expect(browser).toContain('"All projects"');
		expect(extension).toContain("project_root: this.projectRoot");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text, not building a template string
		expect(extension).toContain('vehicleWidgetTitle(PAPYRUS_VEHICLE_NAME, "Tasks", projection.scopeLabel)');
	});
});
