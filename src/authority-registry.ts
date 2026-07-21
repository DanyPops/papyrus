/**
 * authority-registry.ts — step 4 of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo.
 *
 * Subtype/relation ownership guards (isDiscourseSubtype, NOTE_SUBTYPE, task-kind checks)
 * were previously re-implemented at every write call site across src/service.ts and
 * src/domain-services.ts. This is the one deep enforcement point: a claim expresses
 * which module owns which artifact kind/subtype or relation and what message a
 * non-owner gets for a given action; AuthorizedArtifactWriter enforces claims for the
 * mechanical link/unlink/status paths where the target artifact's persisted kind/subtype
 * is unambiguous. Create is intentionally NOT wrapped transparently here — template
 * resolution (an artifact-template's declared targetKind/defaults.subtype) determines
 * the effective kind/subtype before a claim can be checked, and callers already resolve
 * that themselves; they call registry.requireArtifactAllowed(...) directly with the
 * resolved kind/subtype instead.
 *
 * This module has no domain knowledge of its own (no Discourse/Notes/Tasks awareness) —
 * claims are constructed at the composition root (src/service.ts) where that knowledge
 * already lives, matching "the core has generic registries" from the decision doc.
 */
import type { ArtifactEventContext } from "./domain/artifact-event.ts";
import type { Artifact, ArtifactLink } from "./domain/artifact.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";

export type ArtifactAction = "create" | "link" | "status";

export interface AuthorityClaim {
	/** Module id that owns this kind/subtype/relation, e.g. "discourse", "notes", "tasks". */
	readonly owner: string;
	/** kind may be undefined at a call site that has not yet resolved an artifact's effective kind (e.g. pre-template-resolution). */
	matchesArtifact(kind: string | undefined, subtype: string | undefined): boolean;
	matchesRelation?(relation: string): boolean;
	/**
	 * If provided, this claim is only enforced for the given actions — e.g. Task ownership of
	 * kind="task" is only enforced for status changes; artifact.create redirects kind="task" to
	 * tasks.create rather than rejecting it, so the claim must not match the "create" action.
	 * Omit to apply to every action.
	 */
	appliesToAction?(action: ArtifactAction): boolean;
	/** Exact rejection message for a non-owner attempting `action`. Must match the historical per-action wording. */
	denyMessage(action: ArtifactAction): string;
}

/** O(N) claims, O(N) lookup (N is the number of registered domains, not artifacts — small and fixed at boot). */
export class AuthorityRegistry {
	private readonly claims: AuthorityClaim[] = [];

	claim(claim: AuthorityClaim): void {
		this.claims.push(claim);
	}

	claimAll(claims: readonly AuthorityClaim[]): void {
		for (const entry of claims) this.claim(entry);
	}

	claimForArtifact(kind: string | undefined, subtype: string | undefined, action: ArtifactAction): AuthorityClaim | undefined {
		return this.claims.find((entry) => (entry.appliesToAction?.(action) ?? true) && entry.matchesArtifact(kind, subtype));
	}

	claimForRelation(relation: string, action: ArtifactAction): AuthorityClaim | undefined {
		return this.claims.find((entry) => (entry.appliesToAction?.(action) ?? true) && entry.matchesRelation?.(relation) === true);
	}

	/** Throws the owning claim's message if kind/subtype is claimed by a module other than `caller`. No-op if unclaimed or caller is the owner. */
	requireArtifactAllowed(kind: string | undefined, subtype: string | undefined, action: ArtifactAction, caller: string): void {
		const claim = this.claimForArtifact(kind, subtype, action);
		if (claim && claim.owner !== caller) throw new Error(claim.denyMessage(action));
	}

	requireRelationAllowed(relation: string, action: ArtifactAction, caller: string): void {
		const claim = this.claimForRelation(relation, action);
		if (claim && claim.owner !== caller) throw new Error(claim.denyMessage(action));
	}
}

/**
 * A scoped write path bound to one caller identity. Every mutating call re-checks the
 * *persisted* kind/subtype of the artifacts involved (via a get() read, not a cached
 * assumption), so a caller cannot bypass a claim by acting on an id whose current
 * ownership it hasn't verified.
 */
export class AuthorizedArtifactWriter {
	constructor(
		private readonly store: ArtifactStore,
		private readonly registry: AuthorityRegistry,
		private readonly caller: string,
	) {}

	link(link: ArtifactLink, context?: ArtifactEventContext): void {
		this.checkLink(link);
		this.store.link(link, context);
	}

	unlink(link: ArtifactLink, context?: ArtifactEventContext): boolean {
		this.checkLink(link);
		return this.store.unlink(link, context);
	}

	setStatus(id: string, status: string, context?: ArtifactEventContext): Artifact | null {
		const artifact = this.store.get(id);
		if (artifact) this.registry.requireArtifactAllowed(artifact.kind, artifact.subtype, "status", this.caller);
		return this.store.setStatus(id, status, context);
	}

	/** Exposed standalone so a caller that needs custom branching between claim-checked and redirect
	 * paths (e.g. graph.link routing depends_on between two Tasks through Tasks.depend for cycle
	 * safety) can still run the exact same check before deciding which path to take. */
	checkLink(link: ArtifactLink): void {
		this.registry.requireRelationAllowed(link.relation, "link", this.caller);
		const from = this.store.get(link.from);
		const to = this.store.get(link.to);
		if (from) this.registry.requireArtifactAllowed(from.kind, from.subtype, "link", this.caller);
		if (to) this.registry.requireArtifactAllowed(to.kind, to.subtype, "link", this.caller);
	}
}
