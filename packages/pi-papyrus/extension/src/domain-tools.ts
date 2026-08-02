import type { Artifact, OperationName } from "@danypops/papyrus";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callService } from "./service-client.ts";

/**
 * Every domain tool's primary interfacing point is an artifact's NAME, not its id -- id is a
 * backend implementation detail (a stable key other operations need, and titles aren't
 * guaranteed unique), so it stays out of what the model reads by default. It only resurfaces
 * when genuinely needed to tell two same-titled artifacts apart (artifactLines below), or in a
 * matchArtifactByName disambiguation error, never as a matter of course.
 */
export function artifactLine(artifact: Artifact): string {
	return `[${artifact.status}] ${artifact.title}`;
}

/** Appends " (id)" only for artifacts whose title collides with another in this same result set. */
export function artifactLines(artifacts: Artifact[]): string[] {
	const titleCounts = new Map<string, number>();
	for (const artifact of artifacts) titleCounts.set(artifact.title, (titleCounts.get(artifact.title) ?? 0) + 1);
	return artifacts.map((artifact) =>
		titleCounts.get(artifact.title)! > 1 ? `${artifactLine(artifact)} (${artifact.id})` : artifactLine(artifact),
	);
}

/**
 * Exact, case-insensitive, trimmed title match against an already-fetched candidate set. Throws
 * a clear "not found" or "ambiguous -- use id" error rather than guessing at a fuzzy match -- id
 * remains the one truly unambiguous key, so ambiguity is exactly where it's allowed to resurface.
 * Pure and synchronous so it's directly testable without a service round-trip.
 */
export function matchArtifactByName(candidates: Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) throw new Error(`no artifact named "${name}" found in this scope`);
	if (matches.length > 1) {
		throw new Error(
			`${matches.length} artifacts are named "${name}": ${matches.map((artifact) => `${artifact.title} (${artifact.id})`).join(", ")} -- use id to disambiguate`,
		);
	}
	return matches[0]!.id;
}

/**
 * tasks.list is the one list operation that requires `project_root` and separately supports a
 * `scope` ("project" | "graph" | "all") to widen or narrow the search. Every other list operation
 * (docs.list, rules.list, playbooks.list, artifact.query, ...) instead treats an
 * omitted `project_root` as an unscoped/global search (domain-services.ts's listScoped) and has
 * no `scope` concept at all -- so "search everywhere" means something different for each.
 */
const SCOPE_AWARE_LIST_OPERATIONS = new Set<OperationName>(["tasks.list"]);

/** The widened-scope request tried once when a name isn't found under the caller's current scope. */
function widenedRequest(listOperation: OperationName, baseRequest: Record<string, unknown>): Record<string, unknown> {
	return SCOPE_AWARE_LIST_OPERATIONS.has(listOperation) ? { ...baseRequest, scope: "all" } : { ...baseRequest, project_root: undefined };
}

/**
 * Resolves a name to its id via `listOperation` (whichever kind's list call is the right search
 * scope -- tasks.list, docs.list, rules.list, playbooks.list, notes.list, discuss.list, or the
 * kind-agnostic artifact.query for a cross-kind reference like a link target). `baseRequest`
 * should mirror whatever scoping (project_root, etc.) that operation's own "list" action already
 * uses, so resolution never searches a wider or narrower scope than a plain list call would.
 *
 * A two-artifact action (depend/contain/gate/link) routinely names artifacts that live in two
 * different projects, and one call has no way to give two different name fields two different
 * scopes. When the first lookup finds nothing under the caller's current scope, retry exactly
 * once against a global search before giving up -- but never when the caller already pinned an
 * explicit `scope`, so a genuine "not found in the scope I asked for" stays a real error instead
 * of being silently papered over. `notes`, when given, records that a name only resolved after
 * widening, so the caller can surface that a search went wider than the caller's default scope
 * rather than resolving silently.
 */
async function resolveArtifactIdByName(
	listOperation: OperationName,
	baseRequest: Record<string, unknown>,
	name: string,
	notes?: string[],
): Promise<string> {
	const candidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, { ...baseRequest, text: name });
	try {
		return matchArtifactByName(candidates, name);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("no artifact named") || baseRequest.scope !== undefined) throw error;
		const widenedCandidates = await callService<Record<string, unknown>, Artifact[]>(listOperation, {
			...widenedRequest(listOperation, baseRequest),
			text: name,
		});
		const id = matchArtifactByName(widenedCandidates, name);
		notes?.push(`"${name}" was not found in the current project scope; resolved across all projects instead.`);
		return id;
	}
}

/**
 * Resolves every {nameKey -> idKey} pair present and not already satisfied by an explicit id, in
 * place. `notes`, when given, collects a message for each name that only resolved by widening
 * past the caller's own scope (see resolveArtifactIdByName) -- callers that want that surfaced
 * to the model/human pass an array here and append it to their own response text.
 */
export async function resolveNameFields(
	params: Record<string, unknown>,
	fields: ReadonlyArray<{ nameKey: string; idKey: string; listOperation: OperationName; baseRequest: Record<string, unknown> }>,
	notes?: string[],
): Promise<void> {
	for (const { nameKey, idKey, listOperation, baseRequest } of fields) {
		const nameValue = params[nameKey];
		if (typeof nameValue === "string" && nameValue.length > 0 && !params[idKey]) {
			params[idKey] = await resolveArtifactIdByName(listOperation, baseRequest, nameValue, notes);
		}
	}
}

// notes.*, rules.*, docs.*, playbooks.*, tasks.*, discuss.*, and the shared artifact.*
// are all registered as Vehicles (see ../vehicle-notes-client.ts and @danypops/papyrus's
// src/vehicle/papyrus-vehicle.ts) -- no domain has a hand-rolled pi.registerTool() left
// in this file. What remains here (above) is name-resolution machinery still used
// directly by index.ts's own low-level tools (papyrus_graph).
