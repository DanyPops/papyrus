import { describe, expect, it } from "bun:test";
import type { DaemonDiagnosis } from "@danypops/vehicle-server/daemon-lifecycle";
import { runDaemonCli } from "../src/cli/daemon-command.ts";

class FakeDiagnoseClient {
	calls = 0;
	constructor(private readonly diagnosis: DaemonDiagnosis) {}
	diagnose(): Promise<DaemonDiagnosis> {
		this.calls++;
		return Promise.resolve(this.diagnosis);
	}
}

const diagnosis: DaemonDiagnosis = {
	instanceId: "instance-1",
	pid: 4242,
	startedAt: "2026-01-01T00:00:00.000Z",
	provenance: "service",
	history: [
		{ instanceId: "instance-0", pid: 1, type: "started", at: "2025-12-31T00:00:00.000Z", provenance: "service" },
		{ instanceId: "instance-0", pid: 1, type: "stopped", at: "2025-12-31T01:00:00.000Z", provenance: "service", reason: "SIGTERM" },
	],
};

describe("runDaemonCli (Stricli-backed)", () => {
	it("diagnose --json returns the raw diagnosis object", async () => {
		const client = new FakeDiagnoseClient(diagnosis);
		const output = await runDaemonCli(["diagnose", "--json"], client);
		expect(JSON.parse(output)).toEqual(diagnosis);
		expect(client.calls).toBe(1);
	});

	it("diagnose (human) renders identity plus a readable history line per event", async () => {
		const client = new FakeDiagnoseClient(diagnosis);
		const output = await runDaemonCli(["diagnose"], client);
		expect(output).toContain("instance instance-1 (pid 4242, service)");
		expect(output).toContain("started 2026-01-01T00:00:00.000Z");
		expect(output).toContain("2025-12-31T00:00:00.000Z  started  pid=1 instance=instance-0");
		expect(output).toContain("2025-12-31T01:00:00.000Z  stopped (SIGTERM)  pid=1 instance=instance-0");
	});

	it("diagnose (human) renders a clear placeholder when history is empty", async () => {
		const client = new FakeDiagnoseClient({ ...diagnosis, history: [] });
		const output = await runDaemonCli(["diagnose"], client);
		expect(output).toContain("(none)");
	});

	it("rejects an unknown action", async () => {
		const client = new FakeDiagnoseClient(diagnosis);
		await expect(runDaemonCli(["bogus"], client)).rejects.toThrow();
	});
});
