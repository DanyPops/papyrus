import type { TaskScopeSource } from "../task-scope/task-scope.ts";
import type { ScopeMemberRef } from "../scope-group/scope-group.ts";

/**
 * Project scoping for Docs/Rules/Playbooks: an artifact is explicitly "none" (hidden -- never
 * applicable, never context-injected, regardless of project), explicitly "all" (applies
 * everywhere), or bound to a bounded, non-empty set of explicit members -- never inferred from
 * an accidentally empty join table, which is why `mode` is its own explicit field rather than
 * "members.length === 0 means none/all". A member is either a registered project (from the
 * shared ProjectRegistryStore) or a scope group (from ScopeGroupStore, itself a possibly-nested
 * collection of projects/groups) -- "explicit scope can include nested scopes". Membership is by
 * id, never by root/name, so a registered project's root (or a group's name) can move without a
 * best-effort string rewrite across every artifact that references it.
 */
export type ArtifactScopeMode = "none" | "all" | "explicit";

export interface ArtifactScope {
	artifactId: string;
	mode: ArtifactScopeMode;
	/** Direct membership only (not expanded through nested groups) -- always empty when mode is "none"/"all", always non-empty when mode is "explicit". */
	members: ScopeMemberRef[];
	source: TaskScopeSource;
}

export interface LegacyArtifactScope {
	artifactId: string;
	projectRoot?: string;
	source: TaskScopeSource;
}

export interface ArtifactScopeStore {
	/** The real, non-lossy multi-membership view. Defaults to "all"/unscoped for an artifact with no scope row yet. */
	scope(artifactId: string): ArtifactScope;
	/** Single-root compatibility view over scope(): an "all"/"none" or unscoped artifact omits projectRoot; an "explicit" mode artifact with exactly one project-type membership (and no group members) resolves it back to that project's current root; anything else (zero, more than one, or any group membership) omits projectRoot, since this shape cannot represent it. */
	get(artifactId: string): LegacyArtifactScope | undefined;
	/** Single-root compatibility shim: registers/resolves projectRoot and replaces the artifact's scope with exactly that one project membership, or setAll() when projectRoot is undefined. Every existing caller (rules/docs/playbooks assign_project) keeps working unchanged. */
	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): LegacyArtifactScope;
	/** Sets an artifact to explicitly "all" (applies everywhere), clearing any membership. */
	setAll(artifactId: string, source: TaskScopeSource): ArtifactScope;
	/** Sets an artifact to explicitly "none" (fully hidden -- never applicable, never context-injected, regardless of project), clearing any membership. */
	setNone(artifactId: string, source: TaskScopeSource): ArtifactScope;
	/** Replaces an artifact's entire explicit membership set with exactly these (project and/or group) members -- must be non-empty; use setAll/setNone to clear scoping entirely. */
	replaceMembers(artifactId: string, members: readonly ScopeMemberRef[], source: TaskScopeSource): ArtifactScope;
	/** Adds one member to an artifact's explicit membership (idempotent), switching mode to "explicit" if it was "all"/"none". Enforces the bounded maximum membership count. */
	addMember(artifactId: string, member: ScopeMemberRef, source: TaskScopeSource): ArtifactScope;
	/** Removes one member from an artifact's explicit membership (idempotent). Rejects removing the last membership while mode is "explicit": a caller must explicitly call setAll/setNone instead of accidentally broadening/narrowing scope by emptying the set. */
	removeMember(artifactId: string, member: ScopeMemberRef): ArtifactScope;
	/** Bounded id listing for one project root's EXACT direct membership (or the "all" bucket when projectRoot is undefined) -- an unregistered root always yields an empty list. Deliberately does not expand nested groups (audit semantics, matching this method's own pre-existing "exact membership" contract) -- use appliesToProjectRoot for the applicable/injection query instead. */
	ids(projectRoot: string | undefined, limit: number): string[];
	/** True when artifactId's scope is "all", or "explicit" with projectId reachable from its member set (a direct project member, or transitively through a nested group member) -- false for "none". False for an unscoped artifact with no row is never returned (defaults to "all" behavior); injection call sites decide their own applicability policy beyond this raw membership fact. */
	appliesToProject(artifactId: string, projectId: string): boolean;
	/** Root-based convenience over appliesToProject, for a caller (e.g. rules.injectable) that only has a project root, not a resolved id. An unregistered root means only an "all"-mode artifact applies; projectRoot === undefined means "no project context at all", so only "all"-mode artifacts apply either way. */
	appliesToProjectRoot(artifactId: string, projectRoot: string | undefined): boolean;
	/** True when any artifact's own explicit scope references this scope group as a direct member -- checked by deleteScopeGroup before allowing a group to be deleted. */
	referencesGroup(groupId: string): boolean;
}
