import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ContextSegmentItem } from "@danypops/jittor";
import { type Artifact, CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN, CONTEXT_TREE_MAX_NODES, type TaskGraph } from "@danypops/papyrus";
import { ruleInjectionPreview } from "./rules.ts";
import { discoverSkillDirectories, type SkillCatalogFootprint, scanSkillCatalogFootprint } from "./skill-catalog-footprint.ts";

/**
 * Papyrus's own real data for the Context Hub: Rules injection cost, the Task containment tree,
 * and the Pi Skills catalog footprint -- contributed to Jittor's Context Hub as one segment
 * (context-hub-contribution.ts) instead of rendering a whole breakdown locally. The Pi-generic
 * segments (base prompt, message history, tool definitions) and the composer that reconciles
 * every producer's segments against the real total now live in pi-jittor's own
 * context-breakdown.ts.
 */

export interface RuleBudgetEntry {
	id: string;
	title: string;
	characters: number;
	estimatedTokens: number;
}

export interface ContextBudget {
	rules: {
		entries: RuleBudgetEntry[]; // sorted descending by characters
		totalCharacters: number;
		totalEstimatedTokens: number;
	};
	skills: SkillCatalogFootprint;
	totalEstimatedTokens: number;
}

/** Active Rules are injected into every relevant turn -- the same permanent tax role as a Pi-native skill's catalog entry. */
export function computeRuleBudget(rules: ReadonlyArray<Pick<Artifact, "id" | "title" | "body" | "extra">>): ContextBudget["rules"] {
	const entries = rules
		.map((rule) => {
			const characters = ruleInjectionPreview(rule).length;
			return { id: rule.id, title: rule.title, characters, estimatedTokens: Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) };
		})
		.sort((a, b) => b.characters - a.characters);
	return {
		entries,
		totalCharacters: entries.reduce((sum, entry) => sum + entry.characters, 0),
		totalEstimatedTokens: entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
	};
}

/** Best-effort: a missing, unreadable, or malformed settings.json contributes no extra skill directories rather than failing the whole report. */
function readSettingsSkillPaths(settingsPath: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { skills?: unknown };
		if (!Array.isArray(raw.skills)) return [];
		return raw.skills.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

export function computeContextBudget(
	rules: ReadonlyArray<Pick<Artifact, "id" | "title" | "body" | "extra">>,
	cwd: string,
	homeDirectory: string = homedir(),
): ContextBudget {
	const settingsSkills = readSettingsSkillPaths(`${homeDirectory}/.pi/agent/settings.json`);
	const directories = discoverSkillDirectories(homeDirectory, cwd, settingsSkills);
	const skills = scanSkillCatalogFootprint(directories);
	const ruleBudget = computeRuleBudget(rules);
	return { rules: ruleBudget, skills, totalEstimatedTokens: ruleBudget.totalEstimatedTokens + skills.totalEstimatedTokens };
}

/** Sums a possibly-nested item tree's tokens recursively -- every node's own contribution, not just top-level items. */
export function sumItemTree(items: ContextSegmentItem[]): number {
	return items.reduce((sum, item) => sum + item.estimatedTokens + sumItemTree(item.children ?? []), 0);
}

/**
 * Builds the Tasks segment's items from Papyrus's own real containment tree (parentIds/
 * childIds), not a flat list -- Tasks are a genuine DAG (a task may have more than one
 * parent, a deliberate design decision, not a defect: see /tasks contain). Open tasks only
 * (done/canceled tasks are filtered first, matching taskContext()'s own "only open work
 * matters" rule); a task whose real parent is done/canceled or otherwise filtered out
 * becomes a root in THIS projection rather than being silently dropped. A task reachable
 * from more than one open parent is shown once, under whichever parent this bounded walk
 * reaches first -- the same spanning-tree compromise already applied to the task widget
 * (extension/src/task-widget.ts) for the identical multi-parent-DAG-in-a-bounded-view
 * problem, not a new inconsistency.
 */
interface TaskWalkFrame {
	taskId: string;
	parentIndex: number | null;
}

/** Bounded, iterative two-pass walk (an explicit-stack pre-order discovery pass, then a reverse-order construction pass) -- containment depth is not assumed to stay small just because it usually does. */
export function buildTaskItemTree(graph: TaskGraph): ContextSegmentItem[] {
	const byId = new Map(graph.nodes.map((node) => [node.task.id, node]));
	const openIds = new Set(
		graph.nodes.filter((node) => node.task.status !== "done" && node.task.status !== "canceled").map((node) => node.task.id),
	);
	const visited = new Set<string>();

	const rootIds = [...openIds].filter((id) => {
		const node = byId.get(id)!;
		return node.parentIds.length === 0 || !node.parentIds.some((parentId) => openIds.has(parentId));
	});

	const order: TaskWalkFrame[] = [];
	const stack: TaskWalkFrame[] = [...rootIds].reverse().map((taskId) => ({ taskId, parentIndex: null }));
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (order.length >= CONTEXT_TREE_MAX_NODES) break;
		if (visited.has(frame.taskId) || !openIds.has(frame.taskId)) continue; // cycle guard + open-only filter
		visited.add(frame.taskId);
		const index = order.length;
		order.push(frame);
		const node = byId.get(frame.taskId);
		const children = [...(node?.childIds ?? [])]
			.reverse()
			.filter((childId) => openIds.has(childId))
			.map((childId) => ({ taskId: childId, parentIndex: index }));
		stack.push(...children);
	}

	const childItemsByParent = new Map<number, ContextSegmentItem[]>();
	const itemByIndex = new Map<number, ContextSegmentItem>();
	for (let index = order.length - 1; index >= 0; index--) {
		const frame = order[index]!;
		const node = byId.get(frame.taskId);
		if (!node) continue;
		const characters = node.task.title.length + node.task.body.length;
		const tokens = Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
		const children = childItemsByParent.get(index) ?? [];
		const item: ContextSegmentItem = { label: node.task.title, estimatedTokens: tokens, ...(children.length > 0 ? { children } : {}) };
		itemByIndex.set(index, item);
		if (frame.parentIndex !== null) {
			const siblings = childItemsByParent.get(frame.parentIndex) ?? [];
			siblings.unshift(item);
			childItemsByParent.set(frame.parentIndex, siblings);
		}
	}

	const items: ContextSegmentItem[] = [];
	for (let index = 0; index < order.length; index++) {
		if (order[index]!.parentIndex === null) {
			const item = itemByIndex.get(index);
			if (item) items.push(item);
		}
	}
	return items;
}
