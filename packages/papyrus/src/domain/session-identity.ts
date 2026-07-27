/**
 * domain/session-identity.ts — closes the gap flagged by
 * verify-caller-identity-behind-papyrus-mutation-attribution-koxt: session_id was, until now,
 * pure caller-supplied free text at the RPC boundary, yet scope-task-focus-and-its-
 * tuicontext-injection-to-the-request-8d5n made it load-bearing for *behavior* (Task Focus
 * is keyed by session_id) -- a forged session_id can pause/unpause/clear/redirect a live
 * session's Focus, not merely mislabel history.
 *
 * The real constraint this design works within: Papyrus's daemon authenticates every client
 * with ONE shared bearer token per machine (src/daemon-state.ts) -- every authenticated
 * caller looks identical to the daemon. Checked directly against Bun's public server API:
 * no SO_PEERCRED-equivalent exists for either a TCP or a Unix-socket listener, so real
 * kernel-verified per-process identity is not cheaply achievable; building it would mean FFI
 * against libc, disproportionate to this task. Pi's session ids are uuidv7 (time-ordered, not
 * cryptographically opaque -- confirmed by reading @earendil-works/pi-coding-agent's
 * session-manager.ts source), so they were never meant to double as secrets either.
 *
 * The actual cryptographic primitive (secret generation, hashing, constant-time verify,
 * first-touch registration semantics) is NOT reimplemented here -- it lives in
 * @danypops/daemon-kit's session-identity module. That gap (a shared bearer token cannot
 * distinguish callers; a session id needs a real credential once it becomes behavior-
 * affecting) is generic to every daemon-kit-shaped daemon, not Papyrus-specific -- Papyrus's
 * own daemon.ts/service.ts predates daemon-kit and has not migrated onto it, but this one
 * capability is adopted narrowly regardless (daemon-kit's exports map is designed for
 * exactly this: "a consumer only pulls in what it uses"). This file only wires that generic
 * primitive to Papyrus's own SQLite storage (see adapters/sqlite-session-identity-store.ts)
 * and to Task Focus specifically, the one place session_id is behavior-affecting today.
 *
 * Deliberately "opt-in armor", not a breaking migration: a session_id that was never
 * registered behaves exactly as before (open), so every already-open session and every
 * caller that never calls session.register (bare CLI use of the "global" scope, older
 * Papyrus builds, test fixtures) is unaffected. Every real Pi session becomes armored
 * automatically the moment its extension fires session_start.
 *
 * Explicitly NOT solved by this: a race at first contact (whoever registers a session_id
 * first becomes its legitimate owner) -- an attacker who wins that race before the real
 * session ever registers still prevails. This is a real, disclosed, accepted residual limit,
 * not oversold as "verified identity"; scribe's own prior art never solved caller identity
 * either. Registering as soon as the extension's session_start hook fires (before any
 * Focus-mutating call could plausibly happen) shrinks this window to something small, not
 * zero.
 *
 * actor/source free-text fields are explicitly NOT in scope here -- they remain audit-trail
 * labeling only, never a security boundary, matching the conclusion already reached when this
 * task was deferred from add-a-generic-mutation-event-log-to-the-papyrus-artifactstor-at6h.
 */

export function assertValidSessionId(sessionId: string): void {
	if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("session_id is required");
}
