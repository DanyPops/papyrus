/**
 * Structural CLI parity test.
 *
 * Papyrus already shares one operation table (EXPECTED_OPERATION_NAMES in src/service.ts)
 * between the native Pi extension and the CLI, but until now src/cli.ts hand-authored a
 * USAGE block and per-command switch that only covered a subset of it — the exact gap the
 * "Daemon-backed tools require CLI parity" rule exists to close. This file is the
 * enforcement mechanism: every name in EXPECTED_OPERATION_NAMES must have an entry in
 * CLI_FIXTURES below, and invoking that fixture must route to exactly that operation.
 * A future operation added to service.ts without a matching CLI command fails this test.
 */
import { describe, expect, it } from "bun:test";
import {
	runArtifactCli,
	runDiscourseCli,
	runDocsCli,
	runGatesCli,
	runGraphCli,
	runMigrationCli,
	runNoteCli,
	runRulesCli,
	runSkillCli,
	runTaskCli,
} from "../src/cli.ts";
import { EXPECTED_OPERATION_NAMES, type OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "a1", title: "Title", status: "todo" };
const artifactList = [artifact];

interface Fixture {
	operation: OperationName;
	result: unknown;
	invoke: (client: FakeClient) => Promise<string>;
}

const CLI_FIXTURES: Fixture[] = [
	{ operation: "system.migrate", result: { from: 1, to: 2, applied: ["x"] }, invoke: (c) => runMigrationCli(["schema", "--json"], c) },
	{ operation: "discourse.store", result: {}, invoke: (c) => runDiscourseCli(["store", "post", "--store-id", "s1", "--json"], c) },
	{ operation: "artifact.create", result: artifact, invoke: (c) => runArtifactCli(["create", "--kind", "doc", "--title", "T", "--json"], c) },
	{ operation: "artifact.query", result: artifactList, invoke: (c) => runArtifactCli(["query", "--json"], c) },
	{ operation: "artifact.show", result: artifact, invoke: (c) => runArtifactCli(["show", "a1", "--json"], c) },
	{ operation: "graph.link", result: { ok: true }, invoke: (c) => runGraphCli(["link", "a1", "relates_to", "a2", "--json"], c) },
	{ operation: "graph.tree", result: artifact, invoke: (c) => runGraphCli(["tree", "a1", "--json"], c) },
	{ operation: "graph.status", result: artifact, invoke: (c) => runGraphCli(["status", "a1", "active", "--json"], c) },
	{ operation: "graph.history", result: { events: [] }, invoke: (c) => runGraphCli(["history", "--id", "a1", "--json"], c) },
	{ operation: "gates.run", result: [], invoke: (c) => runGatesCli(["run", "a1", "--json"], c) },
	{ operation: "rules.injectable", result: artifactList, invoke: (c) => runRulesCli(["injectable", "--json"], c) },
	{ operation: "tasks.create", result: artifact, invoke: (c) => runTaskCli(["create", "--title", "T", "--json"], c) },
	{ operation: "tasks.update", result: artifact, invoke: (c) => runTaskCli(["update", "a1", "--title", "T2", "--json"], c) },
	{ operation: "tasks.list", result: artifactList, invoke: (c) => runTaskCli(["list", "--json"], c) },
	{ operation: "tasks.graph", result: { nodes: [], rootIds: [] }, invoke: (c) => runTaskCli(["graph", "--json"], c) },
	{ operation: "tasks.plan", result: { layers: [], cycleIds: [], nodes: [] }, invoke: (c) => runTaskCli(["plan", "--json"], c) },
	{ operation: "tasks.show", result: artifact, invoke: (c) => runTaskCli(["show", "a1", "--json"], c) },
	{ operation: "tasks.history", result: { events: [] }, invoke: (c) => runTaskCli(["history", "a1", "--json"], c) },
	{ operation: "tasks.scope", result: { mode: "project", label: "papyrus" }, invoke: (c) => runTaskCli(["scope", "--json"], c) },
	{ operation: "tasks.set_scope", result: { mode: "all", label: "All projects" }, invoke: (c) => runTaskCli(["scope", "all", "--json"], c) },
	{ operation: "tasks.assign_project", result: artifact, invoke: (c) => runTaskCli(["assign-project", "a1", "--json"], c) },
	{ operation: "tasks.active", result: artifact, invoke: (c) => runTaskCli(["active", "--json"], c) },
	{ operation: "tasks.focused", result: { artifact, status: "active" }, invoke: (c) => runTaskCli(["focused", "--json"], c) },
	{ operation: "tasks.focus", result: artifact, invoke: (c) => runTaskCli(["focus", "a1", "--json"], c) },
	{ operation: "tasks.pause", result: { artifact, status: "paused" }, invoke: (c) => runTaskCli(["pause", "--json"], c) },
	{ operation: "tasks.unpause", result: { artifact, status: "active" }, invoke: (c) => runTaskCli(["unpause", "--json"], c) },
	{ operation: "tasks.clear_focus", result: { cleared: true }, invoke: (c) => runTaskCli(["clear-focus", "--json"], c) },
	{ operation: "tasks.start", result: artifact, invoke: (c) => runTaskCli(["start", "a1", "--json"], c) },
	{ operation: "tasks.submit", result: artifact, invoke: (c) => runTaskCli(["submit", "a1", "--json"], c) },
	{ operation: "tasks.complete", result: { artifact, gates: [], checklist: [], blocked: [], completed: true }, invoke: (c) => runTaskCli(["complete", "a1", "--json"], c) },
	{ operation: "tasks.run_gates", result: [], invoke: (c) => runTaskCli(["run-gates", "a1", "--json"], c) },
	{ operation: "tasks.set_checklist", result: artifact, invoke: (c) => runTaskCli(["set-checklist", "a1", "--checklist-json", "{}", "--json"], c) },
	{ operation: "tasks.context", result: "Progress: 0/0 done", invoke: (c) => runTaskCli(["context", "--json"], c) },
	{ operation: "tasks.reject", result: artifact, invoke: (c) => runTaskCli(["reject", "a1", "--json"], c) },
	{ operation: "tasks.retry", result: artifact, invoke: (c) => runTaskCli(["retry", "a1", "--json"], c) },
	{ operation: "tasks.cancel", result: artifact, invoke: (c) => runTaskCli(["cancel", "a1", "--json"], c) },
	{ operation: "tasks.depend", result: artifact, invoke: (c) => runTaskCli(["depend", "a1", "a2", "--json"], c) },
	{ operation: "tasks.contain", result: artifact, invoke: (c) => runTaskCli(["contain", "p1", "c1", "--json"], c) },
	{ operation: "docs.create", result: artifact, invoke: (c) => runDocsCli(["create", "--title", "T", "--json"], c) },
	{ operation: "docs.list", result: artifactList, invoke: (c) => runDocsCli(["list", "--json"], c) },
	{ operation: "docs.show", result: artifact, invoke: (c) => runDocsCli(["show", "a1", "--json"], c) },
	{ operation: "docs.activate", result: artifact, invoke: (c) => runDocsCli(["activate", "a1", "--json"], c) },
	{ operation: "docs.archive", result: artifact, invoke: (c) => runDocsCli(["archive", "a1", "--json"], c) },
	{ operation: "docs.reopen", result: artifact, invoke: (c) => runDocsCli(["reopen", "a1", "--json"], c) },
	{ operation: "docs.link", result: artifact, invoke: (c) => runDocsCli(["link", "a1", "relates_to", "a2", "--json"], c) },
	{ operation: "notes.capture", result: artifact, invoke: (c) => runNoteCli(["capture", "a request", "--json"], c) },
	{ operation: "notes.list", result: artifactList, invoke: (c) => runNoteCli(["list", "--json"], c) },
	{ operation: "notes.show", result: artifact, invoke: (c) => runNoteCli(["show", "a1", "--json"], c) },
	{ operation: "notes.consume", result: artifact, invoke: (c) => runNoteCli(["consume", "a1", "--json"], c) },
	{ operation: "notes.promote", result: artifact, invoke: (c) => runNoteCli(["promote", "a1", "t1", "--json"], c) },
	{ operation: "notes.archive", result: artifact, invoke: (c) => runNoteCli(["archive", "a1", "completed", "--json"], c) },
	{ operation: "rules.create", result: artifact, invoke: (c) => runRulesCli(["create", "--title", "T", "--json"], c) },
	{ operation: "rules.list", result: artifactList, invoke: (c) => runRulesCli(["list", "--json"], c) },
	{ operation: "rules.show", result: artifact, invoke: (c) => runRulesCli(["show", "a1", "--json"], c) },
	{ operation: "rules.preview", result: "preview text", invoke: (c) => runRulesCli(["preview", "a1", "--json"], c) },
	{ operation: "rules.enable", result: artifact, invoke: (c) => runRulesCli(["enable", "a1", "--json"], c) },
	{ operation: "rules.disable", result: artifact, invoke: (c) => runRulesCli(["disable", "a1", "--json"], c) },
	{ operation: "rules.gate", result: artifact, invoke: (c) => runRulesCli(["gate", "r1", "t1", "--json"], c) },
	{ operation: "skills.create", result: artifact, invoke: (c) => runSkillCli(["create", "--title", "T", "--json"], c) },
	{ operation: "skills.create_template", result: artifact, invoke: (c) => runSkillCli(["create-template", "--title", "T", "--target-kind", "doc", "--json"], c) },
	{ operation: "skills.list", result: artifactList, invoke: (c) => runSkillCli(["list", "--json"], c) },
	{ operation: "skills.show", result: artifact, invoke: (c) => runSkillCli(["show", "a1", "--json"], c) },
	{ operation: "skills.invoke", result: "invocation text", invoke: (c) => runSkillCli(["invoke", "a1", "--json"], c) },
	{ operation: "skills.run", result: { runId: "r1", created: { tasks: [], rules: [], docs: [] }, rootTaskIds: [], execution: { nodes: [] } }, invoke: (c) => runSkillCli(["run", "a1", "--json"], c) },
	{ operation: "skills.enable", result: artifact, invoke: (c) => runSkillCli(["enable", "a1", "--json"], c) },
	{ operation: "skills.disable", result: artifact, invoke: (c) => runSkillCli(["disable", "a1", "--json"], c) },
	{ operation: "skills.instantiate", result: artifact, invoke: (c) => runSkillCli(["instantiate", "a1", "--json"], c) },
];

describe("Papyrus CLI \u2014 structural operation parity", () => {
	it("has a CLI fixture for every EXPECTED_OPERATION_NAMES entry", () => {
		const covered = new Set(CLI_FIXTURES.map((fixture) => fixture.operation));
		const missing = EXPECTED_OPERATION_NAMES.filter((name) => !covered.has(name));
		expect(missing).toEqual([]);
	});

	it("does not carry stale fixtures for operations service.ts no longer registers", () => {
		const known = new Set<OperationName>(EXPECTED_OPERATION_NAMES);
		const stale = CLI_FIXTURES.map((fixture) => fixture.operation).filter((name) => !known.has(name));
		expect(stale).toEqual([]);
	});

	for (const fixture of CLI_FIXTURES) {
		it(`routes \`${fixture.operation}\` through the CLI`, async () => {
			const client = new FakeClient(fixture.result);
			const output = await fixture.invoke(client);
			expect(client.calls.length).toBeGreaterThan(0);
			expect(client.calls.every((call) => call.operation === fixture.operation)).toBe(true);
			expect(typeof output).toBe("string");
		});
	}
});
