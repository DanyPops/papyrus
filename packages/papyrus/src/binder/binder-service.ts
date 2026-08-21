import { type Artifact, requireLocallyOwnedContent } from "../artifact/artifact.ts";
import type { ArtifactEventContext } from "../artifact/artifact-event.ts";
import type { ArtifactScope, ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { ArtifactTrashRecord } from "../artifact/artifact-trash.ts";
import type { ArtifactTrashStore } from "../artifact/artifact-trash-store.ts";
import { requireAtomicArtifactStore } from "../artifact/atomic-artifact-store.ts";
import {
	BINDER_EFFECTIVE_LABEL_MAX_COUNT,
	BINDER_TREE_MAX_ARTIFACTS,
	BINDER_TREE_MAX_DEPTH,
	BINDER_TREE_MAX_RELATIONSHIPS,
} from "../constants.ts";
import {
	addArtifactScopeGroup,
	addArtifactScopeProject,
	assertLabelsBounds,
	assertTitleBounds,
	type ListFilter,
	listScoped,
	removeArtifactScopeGroup,
	removeArtifactScopeProject,
	replaceArtifactScopeGroups,
	replaceArtifactScopeProjects,
	setArtifactScopeNone,
} from "../domain-service-shared.ts";
import { resolveProjectReference } from "../project-registry/project-registry.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import { normalizeProjectRoot } from "../project-registry/scope-source.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import {
	BINDER_FILED_IN_RELATION,
	BINDER_KIND,
	BINDER_ORGANIZES_RELATION,
	type BinderArtifactPlacement,
	type BinderNode,
	type BinderTree,
} from "./binder.ts";

export interface CreateBinderInput {
	title: string;
	labels?: string[];
	parentId?: string;
	projectRoot?: string;
	projectReferences?: string[];
}

export interface UpdateBinderInput {
	title?: string;
	labels?: string[];
}

export interface BinderTreeInput {
	projectRoot?: string;
	artifactIds?: string[];
}

function validateBinderName(title: string): string {
	assertTitleBounds(title);
	const normalized = title.trim();
	if (normalized === "." || normalized === ".." || normalized.includes("/")) {
		throw new Error('binder names cannot be ".", "..", or contain "/"');
	}
	return normalized;
}

function appendUnique(target: string[], values: readonly string[]): string[] {
	for (const value of values) if (!target.includes(value)) target.push(value);
	if (target.length > BINDER_EFFECTIVE_LABEL_MAX_COUNT) {
		throw new Error(`effective Binder labels cannot exceed ${BINDER_EFFECTIVE_LABEL_MAX_COUNT} entries`);
	}
	return target;
}

export function requireBinder(artifacts: ArtifactStore, id: string): Artifact {
	const binder = artifacts.get(id);
	if (!binder) throw new Error(`binder artifact "${id}" not found`);
	if (binder.kind !== BINDER_KIND) throw new Error(`artifact "${id}" is not a binder`);
	return binder;
}

export function listBinders(artifacts: ArtifactStore, scopes: ArtifactScopeStore, filter: ListFilter): Artifact[] {
	return listScoped(artifacts, scopes, BINDER_KIND, filter);
}

function applicableBinders(artifacts: ArtifactStore, scopes: ArtifactScopeStore, projectRoot: string | undefined): Artifact[] {
	return listBinders(
		artifacts,
		scopes,
		projectRoot === undefined
			? { limit: BINDER_TREE_MAX_ARTIFACTS }
			: { applicableToProjectRoot: normalizeProjectRoot(projectRoot), limit: BINDER_TREE_MAX_ARTIFACTS },
	);
}

function edgesFor(artifacts: ArtifactStore, ids: readonly string[]) {
	if (ids.length === 0) return [];
	const edges = artifacts.relationships({ artifactIds: [...ids], limit: BINDER_TREE_MAX_RELATIONSHIPS + 1 });
	if (edges.length > BINDER_TREE_MAX_RELATIONSHIPS) {
		throw new Error(`binder tree cannot exceed ${BINDER_TREE_MAX_RELATIONSHIPS} relationships`);
	}
	return edges;
}

function candidateParents(
	artifacts: ArtifactStore,
	binderIds: ReadonlySet<string>,
	childIds: ReadonlySet<string>,
): Map<string, Set<string>> {
	const parents = new Map<string, Set<string>>();
	const add = (childId: string, parentId: string): void => {
		if (!binderIds.has(parentId) || !childIds.has(childId) || childId === parentId) return;
		const values = parents.get(childId) ?? new Set<string>();
		values.add(parentId);
		parents.set(childId, values);
	};
	for (const edge of edgesFor(artifacts, [...new Set([...binderIds, ...childIds])])) {
		if (edge.relation === BINDER_ORGANIZES_RELATION) add(edge.to, edge.from);
		else if (edge.relation === BINDER_FILED_IN_RELATION) add(edge.from, edge.to);
	}
	return parents;
}

function selectedParents(binders: ReadonlyMap<string, Artifact>, parents: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string> {
	const selected = new Map<string, string>();
	for (const [childId, candidates] of parents) {
		const parentId = [...candidates].sort((left, right) => {
			const leftBinder = binders.get(left);
			const rightBinder = binders.get(right);
			return (leftBinder?.title ?? left).localeCompare(rightBinder?.title ?? right) || left.localeCompare(right);
		})[0];
		if (parentId) selected.set(childId, parentId);
	}
	return selected;
}

export function binderTree(artifacts: ArtifactStore, scopes: ArtifactScopeStore, input: BinderTreeInput = {}): BinderTree {
	const binders = applicableBinders(artifacts, scopes, input.projectRoot);
	const binderById = new Map(binders.map((binder) => [binder.id, binder]));
	const requestedArtifactIds = [...new Set(input.artifactIds ?? [])];
	if (requestedArtifactIds.length > BINDER_TREE_MAX_ARTIFACTS) {
		throw new Error(`binder tree cannot project more than ${BINDER_TREE_MAX_ARTIFACTS} artifacts`);
	}
	const requestedArtifacts =
		requestedArtifactIds.length === 0
			? []
			: artifacts.query({ ids: requestedArtifactIds }).filter((artifact) => artifact.kind !== BINDER_KIND);
	const artifactById = new Map(requestedArtifacts.map((artifact) => [artifact.id, artifact]));
	const visibleChildIds = new Set([...binderById.keys(), ...artifactById.keys()]);
	const parents = candidateParents(artifacts, new Set(binderById.keys()), visibleChildIds);
	if (input.projectRoot !== undefined) {
		const conflict = [...parents].find(([, candidates]) => candidates.size > 1);
		if (conflict) {
			throw new Error(`artifact "${conflict[0]}" has multiple visible Binder parents in this project context; refile it to one Binder`);
		}
	}
	const parentByChild = selectedParents(binderById, parents);

	const resolved = new Map<string, BinderNode>();
	const resolveNode = (id: string, stack: Set<string>): BinderNode => {
		const cached = resolved.get(id);
		if (cached) return cached;
		const binder = binderById.get(id);
		if (!binder) throw new Error(`binder artifact "${id}" not found`);
		if (stack.has(id)) throw new Error("binder hierarchy contains a cycle");
		if (stack.size >= BINDER_TREE_MAX_DEPTH) throw new Error(`binder hierarchy cannot exceed ${BINDER_TREE_MAX_DEPTH} levels`);
		const nextStack = new Set(stack).add(id);
		const parentId = parentByChild.get(id);
		const parent = parentId === undefined ? undefined : resolveNode(parentId, nextStack);
		const inheritedLabels = parent ? [...parent.effectiveLabels] : [];
		const effectiveLabels = appendUnique([...inheritedLabels], binder.labels);
		const node: BinderNode = {
			binder,
			...(parentId === undefined ? {} : { parentId }),
			childIds: [],
			path: parent ? `${parent.path}/${binder.title}` : `/${binder.title}`,
			inheritedLabels,
			effectiveLabels,
		};
		resolved.set(id, node);
		return node;
	};
	for (const binder of binders) resolveNode(binder.id, new Set());
	for (const node of resolved.values()) {
		if (node.parentId) resolved.get(node.parentId)?.childIds.push(node.binder.id);
	}
	for (const node of resolved.values()) {
		node.childIds.sort((left, right) => {
			const a = binderById.get(left)!;
			const b = binderById.get(right)!;
			return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
		});
	}

	const placements: BinderArtifactPlacement[] = requestedArtifactIds.map((artifactId) => {
		const artifact = artifactById.get(artifactId);
		if (!artifact) return { artifactId, inheritedLabels: [], effectiveLabels: [] };
		const binderId = parentByChild.get(artifactId);
		const inheritedLabels = binderId ? [...resolveNode(binderId, new Set()).effectiveLabels] : [];
		return {
			artifactId,
			...(binderId === undefined ? {} : { binderId }),
			inheritedLabels,
			effectiveLabels: appendUnique([...inheritedLabels], artifact.labels),
		};
	});

	return {
		nodes: [...resolved.values()].sort(
			(left, right) => left.path.localeCompare(right.path) || left.binder.id.localeCompare(right.binder.id),
		),
		rootIds: [...resolved.values()]
			.filter((node) => node.parentId === undefined)
			.sort((left, right) => left.binder.title.localeCompare(right.binder.title) || left.binder.id.localeCompare(right.binder.id))
			.map((node) => node.binder.id),
		artifacts: placements,
	};
}

function requireVisibleBinder(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string, projectRoot: string | undefined): Artifact {
	const binder = requireBinder(artifacts, id);
	if (projectRoot !== undefined && !scopes.appliesToProjectRoot(id, normalizeProjectRoot(projectRoot))) {
		throw new Error(`binder "${binder.title}" is outside project scope`);
	}
	return binder;
}

function assertUniqueSibling(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	title: string,
	parentId: string | undefined,
	projectRoot: string | undefined,
	excludeId?: string,
): void {
	const normalized = title.toLowerCase();
	const duplicate = binderTree(artifacts, scopes, { projectRoot }).nodes.find(
		(node) => node.binder.id !== excludeId && node.parentId === parentId && node.binder.title.toLowerCase() === normalized,
	);
	if (duplicate) throw new Error(`binder "${title}" already exists at ${parentId ? "that path" : "the root"}`);
}

function rawVisibleParentIds(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	childId: string,
	projectRoot: string | undefined,
): string[] {
	const visibleIds = new Set(applicableBinders(artifacts, scopes, projectRoot).map((binder) => binder.id));
	return [...(candidateParents(artifacts, visibleIds, new Set([childId])).get(childId) ?? [])];
}

function linkPlacement(artifacts: ArtifactStore, parentId: string, childId: string, context?: ArtifactEventContext): void {
	artifacts.link({ from: parentId, relation: BINDER_ORGANIZES_RELATION, to: childId }, context);
	artifacts.link({ from: childId, relation: BINDER_FILED_IN_RELATION, to: parentId }, context);
}

function unlinkPlacement(artifacts: ArtifactStore, parentId: string, childId: string, context?: ArtifactEventContext): void {
	artifacts.unlink({ from: parentId, relation: BINDER_ORGANIZES_RELATION, to: childId }, context);
	artifacts.unlink({ from: childId, relation: BINDER_FILED_IN_RELATION, to: parentId }, context);
}

export function createBinder(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	input: CreateBinderInput,
	context?: ArtifactEventContext,
	registry?: ProjectRegistryStore,
): Artifact {
	const title = validateBinderName(input.title);
	assertLabelsBounds(input.labels);
	if (input.projectReferences !== undefined && input.projectReferences.length > 0 && registry === undefined) {
		throw new Error("projectReferences requires a project registry");
	}
	const projectRoot = input.projectRoot === undefined ? undefined : normalizeProjectRoot(input.projectRoot);
	const projectContexts =
		input.projectReferences !== undefined && input.projectReferences.length > 0
			? input.projectReferences.map((reference) => resolveProjectReference(registry!, reference).projectRoot)
			: [projectRoot];
	for (const contextRoot of projectContexts) {
		if (input.parentId) requireVisibleBinder(artifacts, scopes, input.parentId, contextRoot);
		assertUniqueSibling(artifacts, scopes, title, input.parentId, contextRoot);
	}
	const binder = artifacts.create({ kind: BINDER_KIND, status: "active", title, labels: input.labels }, context);
	if (input.projectReferences !== undefined && input.projectReferences.length > 0) {
		replaceArtifactScopeProjects(scopes, registry!, binder.id, input.projectReferences);
	} else {
		scopes.assign(binder.id, projectRoot, projectRoot === undefined ? "unscoped" : "explicit");
	}
	if (input.parentId) requireAtomicArtifactStore(artifacts).atomic(() => linkPlacement(artifacts, input.parentId!, binder.id, context));
	return artifacts.get(binder.id)!;
}

function assertNoBinderCycle(artifacts: ArtifactStore, binderId: string, parentId: string): void {
	if (binderId === parentId) throw new Error("a binder cannot be moved inside itself");
	const binders = artifacts.query({ kind: BINDER_KIND, limit: BINDER_TREE_MAX_ARTIFACTS });
	const ids = new Set(binders.map((binder) => binder.id));
	const hierarchyEdges = artifacts.relationships({ kind: BINDER_KIND, limit: BINDER_TREE_MAX_RELATIONSHIPS + 1 });
	if (hierarchyEdges.length > BINDER_TREE_MAX_RELATIONSHIPS) {
		throw new Error(`binder hierarchy cannot exceed ${BINDER_TREE_MAX_RELATIONSHIPS} relationships`);
	}
	const children = new Map<string, string[]>();
	for (const edge of hierarchyEdges) {
		if (edge.relation !== BINDER_ORGANIZES_RELATION || !ids.has(edge.from) || !ids.has(edge.to)) continue;
		const values = children.get(edge.from) ?? [];
		values.push(edge.to);
		children.set(edge.from, values);
	}
	const pending = [binderId];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (visited.has(current)) continue;
		visited.add(current);
		if (current === parentId) throw new Error("a binder cannot be moved inside one of its descendants");
		if (visited.size > BINDER_TREE_MAX_ARTIFACTS) throw new Error(`binder hierarchy cannot exceed ${BINDER_TREE_MAX_ARTIFACTS} nodes`);
		pending.push(...(children.get(current) ?? []));
	}
}

export function moveBinder(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	id: string,
	parentId: string | undefined,
	projectRoot: string | undefined,
	context?: ArtifactEventContext,
): BinderNode {
	const binder = requireVisibleBinder(artifacts, scopes, id, projectRoot);
	if (parentId) {
		requireVisibleBinder(artifacts, scopes, parentId, projectRoot);
		assertNoBinderCycle(artifacts, id, parentId);
	}
	assertUniqueSibling(artifacts, scopes, binder.title, parentId, projectRoot, id);
	const oldParents = rawVisibleParentIds(artifacts, scopes, id, projectRoot);
	if (oldParents.length === 1 && oldParents[0] === parentId)
		return binderTree(artifacts, scopes, { projectRoot }).nodes.find((node) => node.binder.id === id)!;
	requireAtomicArtifactStore(artifacts).atomic(() => {
		for (const oldParentId of oldParents) unlinkPlacement(artifacts, oldParentId, id, context);
		if (parentId) linkPlacement(artifacts, parentId, id, context);
	});
	return binderTree(artifacts, scopes, { projectRoot }).nodes.find((node) => node.binder.id === id)!;
}

export function fileArtifact(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	artifactId: string,
	binderId: string,
	projectRoot: string | undefined,
	context?: ArtifactEventContext,
): BinderArtifactPlacement {
	const artifact = artifacts.get(artifactId);
	if (!artifact) throw new Error(`artifact "${artifactId}" not found`);
	if (artifact.kind === BINDER_KIND) throw new Error("use binders.move to move a Binder");
	requireVisibleBinder(artifacts, scopes, binderId, projectRoot);
	const oldParents = rawVisibleParentIds(artifacts, scopes, artifactId, projectRoot);
	if (!(oldParents.length === 1 && oldParents[0] === binderId)) {
		requireAtomicArtifactStore(artifacts).atomic(() => {
			for (const oldParentId of oldParents) unlinkPlacement(artifacts, oldParentId, artifactId, context);
			linkPlacement(artifacts, binderId, artifactId, context);
		});
	}
	return binderTree(artifacts, scopes, { projectRoot, artifactIds: [artifactId] }).artifacts[0]!;
}

export function unfileArtifact(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	artifactId: string,
	projectRoot: string | undefined,
	context?: ArtifactEventContext,
): BinderArtifactPlacement {
	const artifact = artifacts.get(artifactId);
	if (!artifact) throw new Error(`artifact "${artifactId}" not found`);
	if (artifact.kind === BINDER_KIND) throw new Error("use binders.move without a parent to move a Binder to root");
	const oldParents = rawVisibleParentIds(artifacts, scopes, artifactId, projectRoot);
	requireAtomicArtifactStore(artifacts).atomic(() => {
		for (const oldParentId of oldParents) unlinkPlacement(artifacts, oldParentId, artifactId, context);
	});
	return binderTree(artifacts, scopes, { projectRoot, artifactIds: [artifactId] }).artifacts[0]!;
}

export function updateBinder(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	id: string,
	input: UpdateBinderInput,
	projectRoot: string | undefined,
	context?: ArtifactEventContext,
): Artifact {
	requireLocallyOwnedContent(requireVisibleBinder(artifacts, scopes, id, projectRoot));
	if (input.title === undefined && input.labels === undefined) throw new Error("binder update requires title or labels");
	const title = input.title === undefined ? undefined : validateBinderName(input.title);
	assertLabelsBounds(input.labels);
	if (title !== undefined) {
		const current = binderTree(artifacts, scopes, { projectRoot }).nodes.find((node) => node.binder.id === id);
		assertUniqueSibling(artifacts, scopes, title, current?.parentId, projectRoot, id);
	}
	return artifacts.updateContent(id, { title, labels: input.labels }, context)!;
}

export function removeBinder(
	artifacts: ArtifactStore & ArtifactTrashStore,
	id: string,
	context?: ArtifactEventContext,
	reason?: string,
): ArtifactTrashRecord {
	const binder = requireLocallyOwnedContent(requireBinder(artifacts, id));
	const edges = edgesFor(artifacts, [id]);
	if (
		edges.some(
			(edge) =>
				(edge.from === id && edge.relation === BINDER_ORGANIZES_RELATION) || (edge.to === id && edge.relation === BINDER_FILED_IN_RELATION),
		)
	) {
		throw new Error(`binder "${binder.title}" is not empty; move or unfile its contents first`);
	}
	requireAtomicArtifactStore(artifacts).atomic(() => {
		for (const edge of edges) {
			if (edge.to === id && edge.relation === BINDER_ORGANIZES_RELATION) unlinkPlacement(artifacts, edge.from, id, context);
			if (edge.from === id && edge.relation === BINDER_FILED_IN_RELATION) unlinkPlacement(artifacts, edge.to, id, context);
		}
	});
	return artifacts.trash(id, { reason, context });
}

export function binderScope(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireBinder(artifacts, id);
	return scopes.scope(id);
}

export function setBinderGlobal(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireBinder(artifacts, id);
	return scopes.setAll(id, "explicit");
}

export function setBinderNone(artifacts: ArtifactStore, scopes: ArtifactScopeStore, id: string): ArtifactScope {
	requireBinder(artifacts, id);
	return setArtifactScopeNone(scopes, id);
}

export function addBinderProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	project: string,
): ArtifactScope {
	requireBinder(artifacts, id);
	return addArtifactScopeProject(scopes, registry, id, project);
}

export function removeBinderProject(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	project: string,
): ArtifactScope {
	requireBinder(artifacts, id);
	return removeArtifactScopeProject(scopes, registry, id, project);
}

export function replaceBinderProjects(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	registry: ProjectRegistryStore,
	id: string,
	projects: readonly string[],
): ArtifactScope {
	requireBinder(artifacts, id);
	return replaceArtifactScopeProjects(scopes, registry, id, projects);
}

export function addBinderGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	groups: ScopeGroupStore,
	id: string,
	group: string,
): ArtifactScope {
	requireBinder(artifacts, id);
	return addArtifactScopeGroup(scopes, groups, id, group);
}

export function removeBinderGroup(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	groups: ScopeGroupStore,
	id: string,
	group: string,
): ArtifactScope {
	requireBinder(artifacts, id);
	return removeArtifactScopeGroup(scopes, groups, id, group);
}

export function replaceBinderGroups(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	groups: ScopeGroupStore,
	id: string,
	groupRefs: readonly string[],
): ArtifactScope {
	requireBinder(artifacts, id);
	return replaceArtifactScopeGroups(scopes, groups, id, groupRefs);
}
