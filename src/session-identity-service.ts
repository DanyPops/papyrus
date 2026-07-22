import { isSessionRegistered, registerSessionIdentity, releaseSessionIdentity, verifySessionSecret } from "@danypops/daemon-kit/session-identity";
import { assertValidSessionId } from "./domain/session-identity.ts";
import type { SessionIdentityStore } from "./ports/session-identity-store.ts";

export interface RegisterSessionIdentityResult {
	sessionId: string;
	secret: string;
}

/** Thrown by assertSessionAuthorized when a session_id has a registered identity but the caller did not present a matching session_secret. A distinguishable type so service.ts can map it to HTTP 403, separate from generic validation's 400. */
export class InvalidSessionSecretError extends Error {}

/**
 * Thin Papyrus-side wrapper over @danypops/daemon-kit's storage-agnostic session-identity
 * primitive: validates input shape, binds it to Papyrus's own SQLite-backed store, and
 * exposes the exact three operations Task Focus enforcement needs (see
 * assertAuthorizedForFocus in src/modules/tasks.ts). See domain/session-identity.ts for the
 * full design rationale and its explicitly accepted residual limits.
 */
export class SessionIdentity {
	constructor(private readonly store: SessionIdentityStore) {}

	register(sessionId: string): RegisterSessionIdentityResult {
		assertValidSessionId(sessionId);
		return registerSessionIdentity(this.store, sessionId);
	}

	release(sessionId: string, secret: string | undefined): { released: boolean } {
		assertValidSessionId(sessionId);
		const wasRegistered = isSessionRegistered(this.store, sessionId);
		releaseSessionIdentity(this.store, sessionId, secret);
		return { released: wasRegistered && !isSessionRegistered(this.store, sessionId) };
	}

	isRegistered(sessionId: string): boolean {
		return isSessionRegistered(this.store, sessionId);
	}

	verify(sessionId: string, secret: string | undefined): boolean {
		return verifySessionSecret(this.store, sessionId, secret);
	}

	/**
	 * The enforcement point for a Focus-mutating operation: opt-in armor, matching
	 * domain/session-identity.ts's design -- a sessionId with no registered identity passes
	 * through unauthenticated exactly as before (undefined sessionId included, since that maps
	 * to Task Focus's "global" scope, never armored). Only once a sessionId is registered does
	 * a matching session_secret become mandatory.
	 */
	assertAuthorized(sessionId: string | undefined, secret: string | undefined): void {
		if (sessionId === undefined) return;
		if (!this.isRegistered(sessionId)) return;
		if (!this.verify(sessionId, secret)) throw new InvalidSessionSecretError(`session "${sessionId}" is registered; a valid session_secret is required to mutate its Task Focus`);
	}
}
