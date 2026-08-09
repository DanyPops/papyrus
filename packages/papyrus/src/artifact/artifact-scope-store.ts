import type { TaskScopeSource } from "../domain/task-scope.ts";

/**
 * Project scoping for Docs/Rules/Playbooks: an artifact is either explicitly global (applies
 * everywhere) or bound to a bounded, non-empty set of registered project ids -- never inferred
 * from an accidentally empty join table, which is why `mode` is its own explicit field rather
 * than "projectIds.length === 0 means global". Membership is by project id (from the shared
 * ProjectRegistryStore) internally, so a registered project's root can move without a
 * best-effort string rewrite across every artifact that references it -- assign/get/ids keep
 * taking/returning a root for compatibility with every existing caller, resolved to/from a
 * project id under the hood.
 */
export type ArtifactScopeMode = "global" | "projects";

export interface ArtifactScope {
	artifactId: string;
	mode: ArtifactScopeMode;
	/** Registered project ids this artifact applies to. Always empty when mode is "global"; always non-empty when mode is "projects". */
	projectIds: string[];
	source: TaskScopeSource;
}

export interface LegacyArtifactScope {
	artifactId: string;
	projectRoot?: string;
	source: TaskScopeSource;
}

export interface ArtifactScopeStore {
	/** The real, non-lossy multi-membership view. Defaults to global/unscoped for an artifact with no scope row yet. */
	scope(artifactId: string): ArtifactScope;
	/** Single-root compatibility view over scope(): a global or unscoped artifact omits projectRoot; a "projects" mode artifact with exactly one membership resolves it back to that project's current root; more than one membership (only reachable through the new multi-project primitives below) omits projectRoot, since this shape cannot represent more than one. */
	get(artifactId: string): LegacyArtifactScope | undefined;
	/** Single-root compatibility shim: registers/resolves projectRoot and replaces the artifact's scope with exactly that one membership, or setGlobal() when projectRoot is undefined. Every existing caller (rules/docs/playbooks assign_project) keeps working unchanged. */
	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): LegacyArtifactScope;
	/** Sets an artifact to explicitly global, clearing any project membership. */
	setGlobal(artifactId: string, source: TaskScopeSource): ArtifactScope;
	/** Replaces an artifact's entire project membership set with exactly these (registered) project ids -- must be non-empty; use setGlobal to clear scoping entirely. */
	replaceProjects(artifactId: string, projectIds: readonly string[], source: TaskScopeSource): ArtifactScope;
	/** Adds one project to an artifact's membership (idempotent -- adding an already-present id is a no-op), switching mode to "projects" if it was global. Enforces the bounded maximum membership count. */
	addProject(artifactId: string, projectId: string, source: TaskScopeSource): ArtifactScope;
	/** Removes one project from an artifact's membership (idempotent -- removing an absent id is a no-op). Rejects removing the last membership while mode is "projects": a caller must explicitly call setGlobal instead of accidentally broadening scope by emptying the set. */
	removeProject(artifactId: string, projectId: string): ArtifactScope;
	/** Bounded id listing for one project root (or the global/unscoped bucket when projectRoot is undefined) -- an unregistered root always yields an empty list, since nothing can be scoped to a project that was never registered. */
	ids(projectRoot: string | undefined, limit: number): string[];
	/** True when artifactId's scope includes projectId (mode "projects" and a member), or is "global" (applies everywhere). False for an unscoped artifact with no row -- matching a Rule/Doc/Playbook's default of "applies everywhere" being represented by the same "global" default scope() already returns, but injection call sites decide their own applicability policy; this is the raw membership fact only. */
	appliesToProject(artifactId: string, projectId: string): boolean;
	/** Root-based convenience over appliesToProject, for a caller (e.g. rules.injectable) that only has a project root, not a resolved id -- resolves the same way ids() does. An unregistered root (no project was ever registered for it) means only a global-mode artifact applies; projectRoot === undefined means "no project context at all", so only global-mode artifacts apply either way. */
	appliesToProjectRoot(artifactId: string, projectRoot: string | undefined): boolean;
}
