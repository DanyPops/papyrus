import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/adapters/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import type { ArtifactStore } from "../src/ports/artifact-store.ts";
import type { ArtifactScopeStore } from "../src/ports/artifact-scope-store.ts";
import { instantiateSkillWorkflow } from "../src/workflow-execution.ts";
import { SKILL_WORKFLOW_MAX_NESTING_DEPTH } from "../src/constants.ts";

/**
 * skills.create (the operation) is retired for definition-based workflow Skills -- see
 * modules/playbooks.ts. This constructs the kind=skill/subtype=workflow artifact shape
 * directly, the way createSkill used to, since these tests exercise instantiateSkillWorkflow's
 * nested-pipeline resolution (workflow-execution.ts, the shared engine, not retired), not the
 * retired creation path.
 */
function createWorkflowSkillFixture(artifacts: ArtifactStore, scopes: ArtifactScopeStore, title: string, definition: unknown): { id: string } {
	const skill = artifacts.create({ kind: "skill", status: "active", subtype: "workflow", title, extra: { definition } });
	scopes.assign(skill.id, undefined, "unscoped");
	return skill;
}

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
	const leaf = createWorkflowSkillFixture(artifacts, scopes, "Leaf workflow", LEAF_DEFINITION);
	return { db, artifacts, scopes, leaf };
}

describe("Papyrus Skill nested pipelines: a workflow step can trigger another workflow's own run", () => {
	it("creates the nested run's tasks and links the outer skill's own task to all of them via depends_on", () => {
		const { db, artifacts, scopes, leaf } = fixture();
		const pipeline = createWorkflowSkillFixture(artifacts, scopes, "Pipeline", {
			version: 1,
			inputs: {},
			blueprints: {
				docs: [], rules: [],
				tasks: [{ ref: "review", title: "Review", dependsOn: ["build"] }],
				skills: [{ ref: "build", title: "Build step", skillId: leaf.id, arguments: { target: "Papyrus" } }],
			},
			links: [],
		});

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
		const { db, artifacts, scopes, leaf } = fixture();
		const pipeline = createWorkflowSkillFixture(artifacts, scopes, "Root call pipeline", {
			version: 1,
			inputs: {},
			blueprints: {
				docs: [], rules: [], tasks: [],
				skills: [{ ref: "build", title: "Build step", skillId: leaf.id, arguments: { target: "Papyrus" } }],
			},
			links: [],
		});

		const result = instantiateSkillWorkflow(artifacts, pipeline.id, { runId: "pipe-root" });

		const triggersEdges = artifacts.relationships({ artifactIds: [pipeline.id] }).filter((edge) => edge.from === pipeline.id && edge.relation === "triggers");
		expect(triggersEdges).toContainEqual({ from: pipeline.id, relation: "triggers", to: leaf.id });
		// rootTaskIds reports the REAL starting point -- the nested run's own root task, not a made-up placeholder.
		expect(result.rootTaskIds).toEqual(result.created.tasks);
		db.close();
	});

	it("contains a skill-call step's nested root tasks under the outer parent task", () => {
		const { db, artifacts, scopes, leaf } = fixture();
		const pipeline = createWorkflowSkillFixture(artifacts, scopes, "Contained pipeline", {
			version: 1,
			inputs: {},
			blueprints: {
				docs: [], rules: [],
				tasks: [{ ref: "umbrella", title: "Umbrella" }],
				skills: [{ ref: "build", title: "Build step", skillId: leaf.id, arguments: { target: "Papyrus" }, parent: "umbrella" }],
			},
			links: [],
		});

		const result = instantiateSkillWorkflow(artifacts, pipeline.id, { runId: "pipe-contain" });
		const nestedTaskId = result.created.tasks.find((id) => id !== "pipe-contain-umbrella")!;
		const containsEdges = artifacts.relationships({ artifactIds: ["pipe-contain-umbrella"] });
		expect(containsEdges).toContainEqual({ from: "pipe-contain-umbrella", relation: "contains", to: nestedTaskId });
		db.close();
	});

	it("rejects a skill-calls-skill cycle at execution time, rolling back the whole atomic run", () => {
		const { db, artifacts, scopes } = fixture();
		// A calls B, B calls A: a genuine cycle, only detectable once both definitions exist
		// (the definition validator alone cannot see across skill boundaries).
		const a = createWorkflowSkillFixture(artifacts, scopes, "A", { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "callB", title: "Call B", skillId: "placeholder" }] }, links: [] });
		const b = createWorkflowSkillFixture(artifacts, scopes, "B", { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "callA", title: "Call A", skillId: a.id }] }, links: [] });
		// Patch A's definition now that B's real id is known (a genuine cross-reference cycle).
		artifacts.setExtra(a.id, { definition: { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [], skills: [{ ref: "callB", title: "Call B", skillId: b.id }] }, links: [] } });

		const beforeCount = artifacts.query({}).length;
		expect(() => instantiateSkillWorkflow(artifacts, a.id, { runId: "cycle-run" })).toThrow(/nesting cycle/);
		// Atomic: a rejected run must leave zero new artifacts behind, not a partial pipeline.
		expect(artifacts.query({}).length).toBe(beforeCount);
		db.close();
	});

	it("rejects nesting deeper than the configured bound", () => {
		const { db, artifacts, scopes } = fixture();
		// Build a chain of SKILL_WORKFLOW_MAX_NESTING_DEPTH + 2 skills, each calling the next.
		const chainLength = SKILL_WORKFLOW_MAX_NESTING_DEPTH + 2;
		const ids: string[] = [];
		for (let index = 0; index < chainLength; index++) {
			ids.push(createWorkflowSkillFixture(artifacts, scopes, `Chain ${index}`, { version: 1, inputs: {}, blueprints: { docs: [], rules: [], tasks: [{ ref: "noop", title: "noop" }], skills: [] }, links: [] }).id);
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
