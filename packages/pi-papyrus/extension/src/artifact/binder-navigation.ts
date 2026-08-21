import type { Artifact, BinderArtifactPlacement, BinderNode, BinderTree } from "@danypops/papyrus";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { callService } from "../service-client.ts";

export async function loadBinderTree(projectRoot: string, artifactIds: readonly string[]): Promise<BinderTree> {
	return callService<Record<string, unknown>, BinderTree>("binders.tree", {
		project_root: projectRoot,
		artifact_ids: [...new Set(artifactIds)],
	});
}

export function parseLabelInput(value: string): string[] {
	const result: string[] = [];
	for (const label of value.split(",").map((entry) => entry.trim())) {
		if (label && !result.includes(label)) result.push(label);
	}
	return result;
}

export function binderNodeById(tree: BinderTree): Map<string, BinderNode> {
	return new Map(tree.nodes.map((node) => [node.binder.id, node]));
}

export function binderPlacementByArtifactId(tree: BinderTree): Map<string, BinderArtifactPlacement> {
	return new Map(tree.artifacts.map((placement) => [placement.artifactId, placement]));
}

export function currentBinderPath(tree: BinderTree, binderId: string | undefined): string {
	if (binderId === undefined) return "/";
	return binderNodeById(tree).get(binderId)?.path ?? "/";
}

export function childBinders(tree: BinderTree, parentId: string | undefined): BinderNode[] {
	return tree.nodes
		.filter((node) => node.parentId === parentId)
		.sort((left, right) => left.binder.title.localeCompare(right.binder.title) || left.binder.id.localeCompare(right.binder.id));
}

export function artifactsInBinder<T extends Pick<Artifact, "id" | "title">>(
	rows: readonly T[],
	tree: BinderTree,
	binderId: string | undefined,
): T[] {
	const placements = binderPlacementByArtifactId(tree);
	return rows
		.filter((row) => placements.get(row.id)?.binderId === binderId)
		.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

export function artifactBinderPath(row: Pick<Artifact, "id" | "title">, tree: BinderTree): string {
	const placement = binderPlacementByArtifactId(tree).get(row.id);
	const binderPath = placement?.binderId ? binderNodeById(tree).get(placement.binderId)?.path : undefined;
	return binderPath ? `${binderPath}/${row.title}` : `/${row.title}`;
}

export function inheritedLabelsFor(rowId: string, tree: BinderTree): string[] {
	return binderPlacementByArtifactId(tree).get(rowId)?.inheritedLabels ?? [];
}

export function effectiveLabelsFor(row: Pick<Artifact, "id" | "labels">, tree: BinderTree): string[] {
	return binderPlacementByArtifactId(tree).get(row.id)?.effectiveLabels ?? [...row.labels];
}

export function binderSearchText(node: BinderNode): string {
	return [node.path, node.binder.title, node.binder.alias, ...node.effectiveLabels].join(" ").toLowerCase();
}

export function artifactSearchText(row: Artifact, tree: BinderTree): string {
	return [artifactBinderPath(row, tree), row.id, row.alias, row.title, row.body ?? "", row.subtype ?? "", ...effectiveLabelsFor(row, tree)]
		.join(" ")
		.toLowerCase();
}

export async function createBinderInteractive(ctx: ExtensionCommandContext, parentId: string | undefined): Promise<boolean> {
	const title = await ctx.ui.input("Binder name:", "");
	if (!title) return false;
	const labelsText = await ctx.ui.input("Inherited labels (comma-separated):", "");
	if (labelsText === undefined) return false;
	try {
		await callService("binders.create", {
			title,
			labels: parseLabelInput(labelsText),
			...(parentId ? { parent_id: parentId } : {}),
			project_root: ctx.cwd,
			actor: "user",
			source: "artifact-navigator",
		});
		ctx.ui.notify(`Created Binder "${title.trim()}"`, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Binder creation failed: ${error instanceof Error ? error.message : error}`, "error");
		return false;
	}
}

export async function editBinderInteractive(ctx: ExtensionCommandContext, node: BinderNode): Promise<boolean> {
	const title = await ctx.ui.input("Binder name:", node.binder.title);
	if (title === undefined) return false;
	const labelsText = await ctx.ui.input("Inherited labels (comma-separated):", node.binder.labels.join(", "));
	if (labelsText === undefined) return false;
	try {
		await callService("binders.update", {
			id: node.binder.id,
			title,
			labels: parseLabelInput(labelsText),
			project_root: ctx.cwd,
			actor: "user",
			source: "artifact-navigator",
		});
		ctx.ui.notify(`Updated Binder "${title.trim()}"`, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Binder update failed: ${error instanceof Error ? error.message : error}`, "error");
		return false;
	}
}

function descendantIds(tree: BinderTree, rootId: string): Set<string> {
	const byId = binderNodeById(tree);
	const result = new Set<string>([rootId]);
	const pending = [...(byId.get(rootId)?.childIds ?? [])];
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (result.has(id)) continue;
		result.add(id);
		pending.push(...(byId.get(id)?.childIds ?? []));
	}
	return result;
}

async function selectBinderDestination(
	ctx: ExtensionCommandContext,
	tree: BinderTree,
	excludedIds: ReadonlySet<string> = new Set(),
): Promise<string | null | undefined> {
	const candidates = tree.nodes
		.filter((node) => !excludedIds.has(node.binder.id))
		.sort((left, right) => left.path.localeCompare(right.path));
	const labels = ["/ (root)", ...candidates.map((node) => node.path)];
	const selected = await ctx.ui.select("Destination Binder", labels);
	if (!selected) return undefined;
	if (selected === labels[0]) return null;
	return candidates[labels.indexOf(selected) - 1]?.binder.id;
}

export async function moveBinderInteractive(ctx: ExtensionCommandContext, tree: BinderTree, node: BinderNode): Promise<boolean> {
	const destination = await selectBinderDestination(ctx, tree, descendantIds(tree, node.binder.id));
	if (destination === undefined) return false;
	try {
		await callService("binders.move", {
			id: node.binder.id,
			...(destination ? { parent_id: destination } : {}),
			project_root: ctx.cwd,
			actor: "user",
			source: "artifact-navigator",
		});
		ctx.ui.notify(`Moved "${node.binder.title}"`, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Binder move failed: ${error instanceof Error ? error.message : error}`, "error");
		return false;
	}
}

export async function moveArtifactInteractive(ctx: ExtensionCommandContext, tree: BinderTree, artifact: Artifact): Promise<boolean> {
	const destination = await selectBinderDestination(ctx, tree);
	if (destination === undefined) return false;
	try {
		if (destination === null) {
			await callService("binders.unfile", {
				artifact_id: artifact.id,
				project_root: ctx.cwd,
				actor: "user",
				source: "artifact-navigator",
			});
		} else {
			await callService("binders.file", {
				artifact_id: artifact.id,
				binder_id: destination,
				project_root: ctx.cwd,
				actor: "user",
				source: "artifact-navigator",
			});
		}
		ctx.ui.notify(`Moved "${artifact.title}"`, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Artifact move failed: ${error instanceof Error ? error.message : error}`, "error");
		return false;
	}
}

export async function removeBinderInteractive(ctx: ExtensionCommandContext, node: BinderNode): Promise<boolean> {
	try {
		await callService("binders.remove", {
			id: node.binder.id,
			project_root: ctx.cwd,
			reason: "Removed from filesystem-style TUI navigator",
			actor: "user",
			source: "artifact-navigator",
		});
		ctx.ui.notify(`Removed Binder "${node.binder.title}"`, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Binder removal failed: ${error instanceof Error ? error.message : error}`, "error");
		return false;
	}
}
