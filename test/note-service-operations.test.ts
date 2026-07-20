import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapyrusClient } from "../src/client.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import { createApp, createPapyrusService, EXPECTED_OPERATION_NAMES } from "../src/service.ts";

const PROJECT = "/workspace/papyrus";

describe("Notes daemon operations", () => {
	it("exposes authenticated capture, inbox, consumption, promotion, and archive behavior", async () => {
		const directory = mkdtempSync(join(tmpdir(), "papyrus-note-ops-"));
		const service = createPapyrusService(join(directory, "papyrus.db"));
		const app = createApp({ service, token: "notes-token" });
		const client = new PapyrusClient("http://papyrus.test", "notes-token", (request) => app.fetch(request));

		expect(EXPECTED_OPERATION_NAMES).toEqual(expect.arrayContaining([
			"notes.capture", "notes.list", "notes.show", "notes.consume", "notes.promote", "notes.archive",
		]));
		const note = await client.call<Record<string, unknown>, { id: string; status: string; subtype: string }>("notes.capture", {
			body: "Investigate the retry policy", project_root: PROJECT, actor: "human", source: "test",
		});
		expect(note).toMatchObject({ status: "draft", subtype: "note" });
		expect(await client.call<Record<string, unknown>, Artifact[]>("notes.list", { project_root: PROJECT })).toEqual([expect.objectContaining({ id: note.id })]);
		expect(await client.call<Record<string, unknown>, Artifact>("notes.consume", { id: note.id, project_root: PROJECT, actor: "agent", source: "test" })).toEqual(expect.objectContaining({ status: "active" }));
		const target = await client.call<Record<string, unknown>, { id: string }>("docs.create", { title: "Retry research", subtype: "research" });
		expect(await client.call<Record<string, unknown>, Artifact>("notes.promote", { id: note.id, target_id: target.id, project_root: PROJECT, reason: "Research created" })).toEqual(expect.objectContaining({
			status: "archived",
			extra: expect.objectContaining({ disposition: expect.objectContaining({ kind: "promoted", targetId: target.id }) }),
		}));
		expect(await client.call<Record<string, unknown>, Artifact[]>("notes.list", { project_root: PROJECT })).toEqual([]);
		service.close();
	});

	it("prevents generic document and graph mutations from bypassing Note invariants", async () => {
		const directory = mkdtempSync(join(tmpdir(), "papyrus-note-guard-"));
		const service = createPapyrusService(join(directory, "papyrus.db"));
		const note = await service.execute("notes.capture", { body: "Guard this", project_root: PROJECT }) as { id: string };
		expect(await service.execute("docs.list", {})).toEqual([]);
		await expect(service.execute("docs.show", { id: note.id })).rejects.toThrow("notes.* operation");
		await expect(service.execute("docs.archive", { id: note.id })).rejects.toThrow("notes.* operation");
		await expect(service.execute("graph.status", { id: note.id, status: "archived" })).rejects.toThrow("notes.* operation");
		await expect(service.execute("artifact.create", { kind: "doc", subtype: "note", title: "Bypass" })).rejects.toThrow("notes.capture");
		await expect(service.execute("skills.create_template", {
			title: "Invalid Note template", target_kind: "doc", defaults: { subtype: "note" },
		})).rejects.toThrow("notes.capture");
		const legacyTemplate = await service.execute("artifact.create", {
			kind: "skill", subtype: "artifact-template", title: "Legacy Note template", extra: { targetKind: "doc", defaults: { subtype: "note" } },
		}) as { id: string };
		await expect(service.execute("skills.instantiate", { template_id: legacyTemplate.id, title: "Bypass" })).rejects.toThrow("notes.capture");
		await expect(service.execute("skills.create", {
			title: "Invalid Note workflow",
			definition: { version: 1, inputs: {}, blueprints: { docs: [{ ref: "note", title: "Bypass", subtype: "note" }], rules: [], tasks: [] } },
		})).rejects.toThrow("notes.capture");
		service.close();
	});
});
