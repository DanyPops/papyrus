import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/adapters/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import { createSkill } from "../src/domain-services.ts";
import { instantiateSkillWorkflow } from "../src/skill-execution.ts";
import { SKILL_WORKFLOW_MAX_NESTING_DEPTH } from "../src/constants.ts";

/** A leaf workflow: one task, no nesting. Used as the "downstream job" a pipeline step triggers. */
const LEAF_DEFINITION = {
	version: 1,
	inputs: { target: { type: "string", required: true } },
	blueprints: {
		docs: [],
		rules: [],
		tasks: [{ ref: "work", title: "Work on {{target}}" }],
	},
	links: [],
};

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const scopes = new SQLiteArtifactScopeStore(db);
	const authority = new AuthorityRegistry();
	const leaf = createSkill(artifacts, scopes, { title: "Leaf workflow", definition: LEAF_DEFINITION }, authority);
	return { db, artifacts, scopes, authority, leaf };
}

describe("Papyrus Skill nested pipelines: a workflow step can trigger another workflow's own run", () => {
	it("creates the nested run's tasks and links the outer skill's own task to all of them via depends_on", () => {
		const { db, artifacts, scopes, authority, leaf } = fixture();
		const pipeline = createSkill(artifacts, scopes, {
			title: "Pipeline",
			definition: {
				version: 1,
				inputs: {},
				blueprints: {
					docs: [], rules: [],
					tasks: [{ ref: "review", title: "Review", dependsOn: ["build"] }],
					skills: [{ ref: "build", title: "Build step", skillId: leaf.id, arguments: { target: "Papyrus" } }],
				},
				links: [],
			},
		}, authority);

		const result = instantiateSkillWorkflow(artifacts, pipeline.id, { runId: "pipe-001" });

		expect(result.created.skillRuns).toHaveLength(1);
		expect(result.created.tasks).toContain("pipe-001-review");
		expect(result.created.tasks.length).toBe(2); // pipeline's own "review" + leaf's own "work"
		const nestedWorkTaskId = result.created.tasks.find((id) => id !== "pipe-001-review")!;
		expect(artifacts.get(nestedWorkTaskId)?.title).toBe("Work on Papyrus");

		// The outer "review" task must depend on every task the nested run produced.
		const reviewEdges = artifacts.relationships({ artifactIds: ["pipe-001-review"] });
		expect(reviewEdges).toContainEqual({ from: "pipe-001-review", relation: "depends_on", to: nestedWorkTaskId });
		db.close();
	});

	it("wires a root skill-call step's triggers edge straight to the called skill, not to a task", () => {
		const { db, artifacts, scopes, authority, leaf } = fixture();
		const pipeline = createSkill(artifacts, scopes, {
			title: "Root call pipeline",
			definition: {
				version: 1,
				inputs: {},
				blueprints: {
					docs: [], rules: [], tasks: [],
					skills: [{ ref: "build", title: "Build step", skillId: leaf.id, arguments: { target: "Papyrus" } }],
				},
				links: [],
			},
		}, authority);

		const result = instantiateSkillWorkflow(artifacts, pipeline.id, { runId: "pipe-root" });

		const triggersEdges = artifacts.relationships({ artifactIds: [pipeline.id] }).filter((edge) => edge.from === pipeline.id && edge.relation === "triggers");
		expect(triggersEdges).toContainEqual({ from: pipeline.id, relation: "triggers", to: leaf.id });
		// rootTaskIds reports the REAL starting point -- the nested run's own root task, not a made-up placeholder.
		expect(result.rootTaskIds).toEqual(result.created.tasks);
		db.close();
	});

	it("contains a skill-call step's nested root tasks under the outer parent task", () => {
		const { db, artifacts, scopes, authority, leaf } = fixture();
		const pipeline = createSkill(artifacts, scopes, {
			title: "Contained pipeline",
			definition: {
				version: 1,
				inputs: {},
				blueprints: {
					docs: [], rules: [],
					tasks: [{ ref: "umbrella", title: "Umbrella" }],
					skills: [{ ref: "build", title: "Build step", skillId: leaf.id, arguments: { target: "Papyrus" }, parent: "umbrella" }],
				},
				links: [],
			},
		}, authority);

		const result = instantiateSkillWorkflow(artifacts, pipeline.id, { runId: "pipe-contain" });
		const nestedTaskId = result.created.tasks.find((id) => id !== "pipe-contain-umbrella")!;
		const containsEdges = artifacts.relationships({ artifactIds: ["pipe-contain-umbrella"] });
		expect(containsEdges).toContainEqual({ from: "pipe-contain-umbrella", relation: "contains", to: nestedTaskId });
		db.close();
	});

	it("rejects a skill-calls-skill cycle at execution time, rolling back the whole atomic run", () => {
		const { db, artifacts, scopes, authority } = fixture();
		// A calls B, B calls A: a genuine cycle, only detectable once both definitions exist
		// (the definition validator alone cannot see across skill boundaries).
		const a = createSkill(artifacts, scopes, { title: "A", definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "callB", title: "Call B", skillId: "placeholder" }] }, links: [] } }, authority);
		const b = createSkill(artifacts, scopes, {
			title: "B",
			definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "callA", title: "Call A", skillId: a.id }] }, links: [] },
		}, authority);
		// Patch A's definition now that B's real id is known (a genuine cross-reference cycle).
		artifacts.setExtra(a.id, { definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "callB", title: "Call B", skillId: b.id }] }, links: [] } });

		const beforeCount = artifacts.query({}).length;
		expect(() => instantiateSkillWorkflow(artifacts, a.id, { runId: "cycle-run" })).toThrow(/nesting cycle/);
		// Atomic: a rejected run must leave zero new artifacts behind, not a partial pipeline.
		expect(artifacts.query({}).length).toBe(beforeCount);
		db.close();
	});

	it("rejects nesting deeper than the configured bound", () => {
		const { db, artifacts, scopes, authority } = fixture();
		// Build a chain of SKILL_WORKFLOW_MAX_NESTING_DEPTH + 2 skills, each calling the next.
		const chainLength = SKILL_WORKFLOW_MAX_NESTING_DEPTH + 2;
		const ids: string[] = [];
		for (let index = 0; index < chainLength; index++) {
			ids.push(createSkill(artifacts, scopes, {
				title: `Chain ${index}`,
				definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [{ ref: "noop", title: "noop" }], skills: [] }, links: [] },
			}, authority).id);
		}
		// Rewire each (except the last) to call the next one instead of having its own task.
		for (let index = 0; index < chainLength - 1; index++) {
			artifacts.setExtra(ids[index]!, {
				definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "next", title: "Next", skillId: ids[index + 1] }] }, links: [] },
			});
		}
		expect(() => instantiateSkillWorkflow(artifacts, ids[0]!, { runId: "deep-run" })).toThrow(/nesting exceeds/);
		db.close();
	});
});
