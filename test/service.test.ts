import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapyrusClient } from "../src/client.ts";
import { EXPECTED_OPERATION_NAMES, createApp, createPapyrusService } from "../src/service.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-service-"));
	const service = createPapyrusService(join(dir, "papyrus.db"));
	const app = createApp({ service, token: "test-token" });
	return { dir, service, app };
}

function request(app: { fetch(request: Request): Promise<Response> }, path: string, init: RequestInit = {}) {
	return app.fetch(new Request(`http://papyrus.test${path}`, {
		...init,
		headers: { authorization: "Bearer test-token", "content-type": "application/json", ...init.headers },
	}));
}

describe("Papyrus operation service", () => {
	it("registers a service operation for every low-level and current facade action", () => {
		const { service } = fixture();
		expect(service.operationNames()).toEqual([...EXPECTED_OPERATION_NAMES]);
		expect(EXPECTED_OPERATION_NAMES).toContain("artifact.create");
		expect(EXPECTED_OPERATION_NAMES).toContain("graph.tree");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.complete");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.graph");
		expect(EXPECTED_OPERATION_NAMES).toContain("tasks.set_checklist");
		expect(EXPECTED_OPERATION_NAMES).toContain("docs.archive");
		expect(EXPECTED_OPERATION_NAMES).toContain("rules.preview");
		expect(EXPECTED_OPERATION_NAMES).toContain("skills.instantiate");
		service.close();
	});

	it("dispatches low-level and task operations through one endpoint", async () => {
		const { service, app } = fixture();
		const created = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.create", input: { title: "Serve tasks" } }),
		});
		expect(created.status).toBe(200);
		const task = (await created.json()) as { result: { id: string; kind: string } };
		expect(task.result.kind).toBe("task");

		const listed = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "artifact.query", input: { kind: "task" } }),
		});
		expect(((await listed.json()) as { result: unknown[] }).result).toHaveLength(1);

		const graph = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "tasks.graph", input: {} }),
		});
		expect(((await graph.json()) as { result: { nodes: unknown[]; rootIds: string[] } }).result.nodes).toHaveLength(1);

		const checklist = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({
				op: "tasks.set_checklist",
				input: {
					id: task.result.id,
					checklist: { "Serve requests": { proof: [{ type: "test", target: "test/service.test.ts" }] } },
				},
			}),
		});
		expect(((await checklist.json()) as { result: { extra: Record<string, unknown> } }).result.extra["checklist"]).toEqual({
			"Serve requests": { proof: [{ type: "test", target: "test/service.test.ts" }] },
		});

		const operations = await request(app, "/api/v1/ops");
		expect((await operations.json()) as unknown).toEqual({ operations: EXPECTED_OPERATION_NAMES });
		service.close();
	});

	it("requires authentication and reports unknown operations", async () => {
		const { service, app } = fixture();
		const unauthorized = await app.fetch(new Request("http://papyrus.test/health"));
		expect(unauthorized.status).toBe(401);
		const unknown = await request(app, "/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: "unknown.operation", input: {} }),
		});
		expect(unknown.status).toBe(404);
		service.close();
	});

	it("provides a typed client over the same HTTP adapter", async () => {
		const { service, app } = fixture();
		const client = new PapyrusClient("http://papyrus.test", "test-token", (request) => app.fetch(request));
		expect(await client.health()).toEqual({ ok: true, version: "0.1.0" });
		const task = await client.call<{ title: string }, { id: string; kind: string }>("tasks.create", { title: "Client task" });
		expect(task.kind).toBe("task");
		expect((await client.operations()).length).toBe(EXPECTED_OPERATION_NAMES.length);
		service.close();
	});
});
