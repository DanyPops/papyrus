/**
 * modules/session-identity.ts — the session-identity domain as a registered Papyrus-native
 * module. Deliberately self-contained: no artifact/task infrastructure imports, matching the
 * precedent set by modules/logs.ts. See domain/session-identity.ts for the design rationale.
 */
import type { OperationDefinition } from "../module-registry.ts";
import type { SessionIdentity } from "../session-identity/session-identity-service.ts";
import { type OperationInput, optionalString, string } from "./operation-input.ts";

const MODULE_ID = "session-identity";

/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const SESSION_IDENTITY_OPERATION_NAMES = ["session.register", "session.release"] as const;

/** Registers every session.* operation against one SessionIdentity instance. */
export function sessionIdentityOperations(sessionIdentity: SessionIdentity): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("session.register", (input: OperationInput) => sessionIdentity.register(string(input, "session_id"))),
		define("session.release", (input: OperationInput) =>
			sessionIdentity.release(string(input, "session_id"), optionalString(input, "session_secret")),
		),
	];
}
