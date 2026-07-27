/**
 * Client-side cache for the extension's own session_secret, registered with the daemon at
 * session_start and released at session_shutdown (see index.ts). Keyed by sessionId (not a
 * single "current" variable) defensively -- multiple call sites reference an explicit
 * sessionId already, and a Map costs nothing extra for real correctness. See
 * src/domain/session-identity.ts (daemon side) for the full design rationale.
 */
const secretsBySessionId = new Map<string, string>();

export function cacheSessionSecret(sessionId: string, secret: string): void {
	secretsBySessionId.set(sessionId, secret);
}

export function forgetSessionSecret(sessionId: string): void {
	secretsBySessionId.delete(sessionId);
}

/** Spread into any Focus-mutating request body alongside session_id -- empty object when no secret is cached for this sessionId (unregistered, or registration hasn't completed yet), matching the daemon's opt-in-armor default. */
export function sessionSecretField(sessionId: string | undefined): { session_secret?: string } {
	const secret = sessionId ? secretsBySessionId.get(sessionId) : undefined;
	return secret ? { session_secret: secret } : {};
}
