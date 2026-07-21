import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import { createSkill } from "../src/domain-services.ts";
import { instantiateSkillWorkflow } from "../src/skill-execution.ts";

const definition = {
	version: 1,
	inputs: {
		project: { type: "string", required: true },
		environment: { type: "string", default: "development", enum: ["development", "production"] },
	},
	blueprints: {
		docs: [{ ref: "context", title: "{{project}} context", body: "Environment: {{environment}}" }],
		rules: [{ ref: "safety", title: "Protect {{project}}", condition: "changing {{project}}", action: "Use reviewed changes" }],
		tasks: [
			{
				ref: "verify",
				title: "Verify {{project}}",
				extra: {
					gates: [{ type: "command", target: "bun test" }],
					checklist: {
						"Capture baseline": { proof: [{ type: "artifact", target: "evidence-not-yet-created" }] },
					},
					context: { environment: "{{environment}}" },
				},
			},
			{ ref: "change", title: "Change {{project}}", dependsOn: ["verify"], parent: "verify" },
		],
	},
	links: [
		{ from: "context", relation: "documents", to: "change" },
		{ from: "change", relation: "follows", to: "safety" },
	],
};

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const skill = createSkill(artifacts, { title: "Project change", definition }, new AuthorityRegistry());
	return { db, artifacts, skill };
}

describe("Papyrus Skill workflow execution", () => {
	it("renders and atomically persists a connected deterministic run", () => {
		const { db, artifacts, skill } = fixture();

		const result = instantiateSkillWorkflow(artifacts, skill.id, {
			runId: "run-001",
			arguments: { project: "Papyrus" },
		});

		expect(result).toEqual({
			skillId: skill.id,
			runId: "run-001",
			arguments: { project: "Papyrus", environment: "development" },
			created: {
				docs: ["run-001-context"],
				rules: ["run-001-safety"],
				tasks: ["run-001-verify", "run-001-change"],
			},
			rootTaskIds: ["run-001-verify"],
			execution: expect.any(Object),
		});
		expect(artifacts.get("run-001-context")).toMatchObject({ title: "Papyrus context", body: "Environment: development" });
		expect(artifacts.get("run-001-verify")?.extra).toMatchObject({
			gates: [{ type: "command", target: "bun test" }],
			checklist: { "Capture baseline": { proof: [{ type: "artifact", target: "evidence-not-yet-created" }] } },
			context: { environment: "development" },
		});
		expect(artifacts.get("run-001-safety")?.extra).toMatchObject({
			scope: { type: "skill-run", runId: "run-001", taskIds: ["run-001-verify", "run-001-change"] },
		});
		expect(artifacts.relationships({ artifactIds: result.created.tasks })).toEqual(expect.arrayContaining([
			{ from: "run-001-change", relation: "depends_on", to: "run-001-verify" },
			{ from: "run-001-verify", relation: "contains", to: "run-001-change" },
			{ from: "run-001-change", relation: "part_of", to: "run-001-verify" },
			{ from: "run-001-context", relation: "documents", to: "run-001-change" },
			{ from: "run-001-change", relation: "follows", to: "run-001-safety" },
			{ from: skill.id, relation: "triggers", to: "run-001-verify" },
		]));
		expect(result.execution.nodes.find((node) => node.id === "run-001-verify")).toMatchObject({ state: "ready" });
		expect(result.execution.nodes.find((node) => node.id === "run-001-change")).toMatchObject({ state: "blocked" });
		db.close();
	});

	it("validates every argument before creating artifacts", () => {
		const { db, artifacts, skill } = fixture();
		const before = artifacts.query({}).length;

		expect(() => instantiateSkillWorkflow(artifacts, skill.id, {
			runId: "invalid-run",
			arguments: { environment: "staging" },
		})).toThrow("missing required skill argument");
		expect(artifacts.query({}).length).toBe(before);
		db.close();
	});

	it("rolls back every artifact and edge when persistence fails mid-run", () => {
		const { db, artifacts, skill } = fixture();
		artifacts.create({ id: "collision-safety", kind: "rule", title: "Existing collision" });

		expect(() => instantiateSkillWorkflow(artifacts, skill.id, {
			runId: "collision",
			arguments: { project: "Papyrus" },
		})).toThrow();
		expect(artifacts.get("collision-context")).toBeNull();
		expect(artifacts.get("collision-verify")).toBeNull();
		expect(artifacts.get("collision-safety")?.title).toBe("Existing collision");
		db.close();
	});
});
