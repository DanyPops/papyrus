import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { DOCS_OPERATION_NAMES, docsOperations } from "../src/modules/docs.ts";
import { RULES_OPERATION_NAMES, rulesOperations } from "../src/modules/rules.ts";
import { SQLiteProjectRegistryStore } from "../src/stores/sqlite-project-registry-store.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const projectRegistry = new SQLiteProjectRegistryStore(db);
	const authority = new AuthorityRegistry();
	const registry = new OperationRegistry();
	registry.registerAll(docsOperations(artifacts, artifactScopes, authority));
	registry.registerAll(rulesOperations(artifacts, artifactScopes, projectRegistry));
	return { registry, artifacts };
}

describe("modules/docs — a Papyrus-native registered module", () => {
	it("registers exactly the docs.* operations EXPECTED_OPERATION_NAMES declares", () => {
		const { registry } = fixture();
		const registered = registry.list().filter((name) => name.startsWith("docs."));
		expect(registered).toEqual([...DOCS_OPERATION_NAMES].sort());
	});

	it("delegates create/show/lifecycle to the same field mapping as the prior inline handlers", async () => {
		const { registry } = fixture();
		const created = (await registry.get("docs.create")!.execute({ title: "Design note" })) as { id: string; status: string };
		expect(created.status).toBe("draft");
		const activated = (await registry.get("docs.activate")!.execute({ id: created.id })) as { status: string };
		expect(activated.status).toBe("active");
		const shown = (await registry.get("docs.show")!.execute({ id: created.id })) as { id: string };
		expect(shown.id).toBe(created.id);
	});

	it("updates a document's title/body/labels through docs.update", async () => {
		const { registry } = fixture();
		const created = (await registry.get("docs.create")!.execute({ title: "Design note" })) as { id: string };
		const updated = (await registry.get("docs.update")!.execute({ id: created.id, title: "Design note v2", labels: ["reviewed"] })) as {
			title: string;
			labels: string[];
		};
		expect(updated.title).toBe("Design note v2");
		expect(updated.labels).toEqual(["reviewed"]);
	});
});

describe("modules/rules — a Papyrus-native registered module (excluding rules.injectable)", () => {
	it("registers exactly the rules.* operations EXPECTED_OPERATION_NAMES declares, except the documented rules.injectable exception", () => {
		const { registry } = fixture();
		const registered = registry.list().filter((name) => name.startsWith("rules."));
		expect(registered).toEqual([...RULES_OPERATION_NAMES].sort());
		expect(registry.has("rules.injectable")).toBe(false);
	});

	it("delegates create/gate to the same field mapping as the prior inline handlers", async () => {
		const { registry, artifacts } = fixture();
		const task = artifacts.create({ kind: "task", title: "Gated task", extra: { projectRoot: "/x" } });
		const rule = (await registry.get("rules.create")!.execute({ title: "A rule" })) as { id: string };
		const gated = (await registry.get("rules.gate")!.execute({ id: rule.id, task_id: task.id })) as { id: string };
		expect(gated.id).toBe(rule.id);
	});

	it("updates a rule's title/body/labels through rules.update", async () => {
		const { registry } = fixture();
		const rule = (await registry.get("rules.create")!.execute({ title: "A rule" })) as { id: string };
		const updated = (await registry.get("rules.update")!.execute({ id: rule.id, title: "A rule v2" })) as { title: string };
		expect(updated.title).toBe("A rule v2");
	});

	it("accepts subtype and template_id at creation, matching docs.create's own parity (papyrus-defect-unify-template-subtype-53b3a1eb)", async () => {
		const { registry, artifacts } = fixture();
		// defaults.extra deliberately omits severity: createRule always forces a real severity value
		// (input.severity ?? "info") into its own extra object before the generic template-merge in
		// ops.ts ever runs, so a template-declared extra.severity default can never win there -- a
		// pre-existing createRule quirk unrelated to this test's own subtype/template_id parity claim.
		const template = artifacts.create({
			kind: "rule",
			subtype: "artifact-template",
			title: "Security rule template",
			extra: { targetKind: "rule", defaults: { subtype: "security", body: "Follow the security checklist" } },
		});
		const plain = (await registry.get("rules.create")!.execute({ title: "A rule", subtype: "security" })) as { subtype: string };
		expect(plain.subtype).toBe("security");
		const fromTemplate = (await registry.get("rules.create")!.execute({ title: "From template", template_id: template.id })) as {
			subtype: string;
			body: string;
			status: string;
		};
		expect(fromTemplate.subtype).toBe("security");
		expect(fromTemplate.body).toBe("Follow the security checklist");
		expect(fromTemplate.status).toBe("draft");
	});
});
