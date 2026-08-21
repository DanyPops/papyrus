import { describe, expect, it } from "bun:test";
import type { Artifact, BinderTree } from "@danypops/papyrus";
import { browserEntries } from "../extension/src/artifact/artifact-browser.ts";
import { parseLabelInput } from "../extension/src/artifact/binder-navigation.ts";

function artifact(id: string, kind: string, title: string, labels: string[] = []): Artifact {
	return {
		id,
		kind,
		title,
		status: kind === "binder" ? "active" : "draft",
		subtype: "",
		body: "",
		labels,
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		alias: id,
	};
}

const rootBinder = artifact("engineering", "binder", "Engineering", ["area:engineering"]);
const childBinder = artifact("architecture", "binder", "Architecture", ["type:architecture"]);
const rootDoc = artifact("inbox", "doc", "Inbox");
const nestedDoc = artifact("decision", "doc", "Storage decision", ["decision"]);

const tree: BinderTree = {
	nodes: [
		{
			binder: rootBinder,
			childIds: [childBinder.id],
			path: "/Engineering",
			inheritedLabels: [],
			effectiveLabels: ["area:engineering"],
		},
		{
			binder: childBinder,
			parentId: rootBinder.id,
			childIds: [],
			path: "/Engineering/Architecture",
			inheritedLabels: ["area:engineering"],
			effectiveLabels: ["area:engineering", "type:architecture"],
		},
	],
	rootIds: [rootBinder.id],
	artifacts: [
		{ artifactId: rootDoc.id, inheritedLabels: [], effectiveLabels: [] },
		{
			artifactId: nestedDoc.id,
			binderId: childBinder.id,
			inheritedLabels: ["area:engineering", "type:architecture"],
			effectiveLabels: ["area:engineering", "type:architecture", "decision"],
		},
	],
};

describe("filesystem-style artifact browser projection", () => {
	it("shows only immediate child Binders and directly filed artifacts at each path", () => {
		const rows = [rootDoc, nestedDoc];
		expect(
			browserEntries(rows, tree, undefined, "").map((entry) =>
				entry.type === "binder" ? `binder:${entry.node.binder.id}` : `artifact:${entry.row.id}`,
			),
		).toEqual(["binder:engineering", "artifact:inbox"]);
		expect(
			browserEntries(rows, tree, rootBinder.id, "").map((entry) =>
				entry.type === "binder" ? `binder:${entry.node.binder.id}` : `artifact:${entry.row.id}`,
			),
		).toEqual(["binder:architecture"]);
		expect(browserEntries(rows, tree, childBinder.id, "").map((entry) => entry.type === "artifact" && entry.row.id)).toEqual(["decision"]);
	});

	it("searches across full paths and effective inherited labels, not only the current directory", () => {
		const rows = [rootDoc, nestedDoc];
		const byInheritedLabel = browserEntries(rows, tree, undefined, "area:engineering");
		expect(byInheritedLabel.map((entry) => (entry.type === "binder" ? entry.node.binder.id : entry.row.id))).toEqual([
			"engineering",
			"architecture",
			"decision",
		]);
		const byPath = browserEntries(rows, tree, undefined, "engineering/architecture/storage");
		expect(byPath).toHaveLength(1);
		expect(byPath[0]?.type === "artifact" && byPath[0].row.id).toBe("decision");
	});

	it("normalizes comma-separated label editing deterministically", () => {
		expect(parseLabelInput(" alpha, beta, alpha, , gamma ")).toEqual(["alpha", "beta", "gamma"]);
	});
});
