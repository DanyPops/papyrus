import { SCOPE_GROUP_ALIAS_MAX_COUNT, SCOPE_GROUP_NAME_MAX_LENGTH } from "../constants.ts";

/**
 * A named, reusable collection of scope members (registered projects and/or other scope groups).
 * Membership is explicit/opt-in, never path-derived: a project registered under another
 * project's root directory (e.g. a vendored adapter package) is not automatically that parent's
 * child -- only what's deliberately added counts.
 */
export interface ScopeGroup {
	id: string;
	name: string;
	aliases: string[];
	createdAt: string;
	updatedAt: string;
}

/** One member of a ScopeGroup or of an artifact's own explicit scope -- a project, or another group (nesting). */
export type ScopeMemberRef = { readonly type: "project"; readonly id: string } | { readonly type: "group"; readonly id: string };

export function sameScopeMember(a: ScopeMemberRef, b: ScopeMemberRef): boolean {
	return a.type === b.type && a.id === b.id;
}

export interface RegisterScopeGroupInput {
	name?: string;
	aliases?: string[];
	existingId?: string;
}

export function assertRegisterScopeGroupInputBounds(name: string | undefined, aliases: string[] | undefined): void {
	if (name !== undefined && (name.trim().length === 0 || name.length > SCOPE_GROUP_NAME_MAX_LENGTH)) {
		throw new Error(`scope group name must be between 1 and ${SCOPE_GROUP_NAME_MAX_LENGTH} characters`);
	}
	if ((aliases?.length ?? 0) > SCOPE_GROUP_ALIAS_MAX_COUNT) {
		throw new Error(`scope group aliases cannot exceed ${SCOPE_GROUP_ALIAS_MAX_COUNT} entries`);
	}
	for (const alias of aliases ?? []) {
		if (alias.trim().length === 0 || alias.length > SCOPE_GROUP_NAME_MAX_LENGTH) {
			throw new Error(`each scope group alias must be between 1 and ${SCOPE_GROUP_NAME_MAX_LENGTH} characters`);
		}
	}
}

export class ScopeGroupNotFoundError extends Error {}
export class ScopeGroupAmbiguousError extends Error {}
export class ScopeGroupCycleError extends Error {}
export class ScopeGroupInUseError extends Error {}

export interface ScopeGroupReferenceLookup {
	matchingGroups(reference: string): ScopeGroup[];
	groups(query: string | undefined, limit: number): ScopeGroup[];
}

/** Same bounded, fail-closed exact-reference resolution resolveProjectReference already established -- identical contract, applied to scope groups. */
export function resolveScopeGroupReference(registry: ScopeGroupReferenceLookup, reference: string): ScopeGroup {
	const matches = registry.matchingGroups(reference);
	if (matches.length === 0) {
		const candidates = registry.groups(reference, 10);
		const fallback = candidates.length === 0 ? registry.groups(undefined, 10) : candidates;
		const suffix = fallback.length === 0 ? "" : ` Candidates: ${fallback.map((group) => group.name).join(", ")}`;
		throw new ScopeGroupNotFoundError(`no scope group named or aliased "${reference}" is registered.${suffix}`);
	}
	if (matches.length > 1) {
		throw new ScopeGroupAmbiguousError(
			`scope group reference "${reference}" is ambiguous: ${matches
				.slice(0, 10)
				.map((group) => group.name)
				.join(", ")}`,
		);
	}
	return matches[0]!;
}
