/**
 * Registers every Vehicle-projected domain (notes.*, rules.*, docs.*, skills.*,
 * playbooks.*, artifact.*) as real Pi tools -- see @danypops/papyrus's
 * src/vehicle/papyrus-vehicle.ts.
 *
 * Fails silently on a stale/unreachable daemon handle instead of aborting extension
 * setup: Papyrus's daemon doesn't auto-spawn, and a tool that failed to register
 * here has no later retry path.
 *
 * Uses service-client.ts's currentVehicleClientTarget() (test-injectable) rather
 * than resolveVehicleClientTarget() directly, so a test exercising the full
 * extension entrypoint doesn't resolve a real daemonStateDir().
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { registerVehicleTools } from "@danypops/vehicle-client-pi";
import { currentVehicleClientTarget } from "./service-client.ts";
import { sessionSecretField } from "./session-identity.ts";

const REGISTERED_PERMISSIONS = [
	"notes:read", "notes:write", "rules:read", "rules:write", "docs:read", "docs:write",
	"skills:read", "skills:write", "playbooks:read", "playbooks:write", "artifact:read", "artifact:write",
];

export async function registerNotesVehicle(pi: ExtensionAPI): Promise<void> {
	const target = currentVehicleClientTarget();
	if (!target) return;
	try {
		const client = new RemoteVehicleClient({ baseUrl: target.baseUrl, token: target.token });
		await registerVehicleTools(pi, client, {
			permissions: REGISTERED_PERMISSIONS,
			principal: { id: "pi-papyrus" },
			// playbooks.invoke's own module handler authorizes an internal Task Focus write via
			// sessionIdentity.assertAuthorized(session_id, session_secret) -- see
			// @danypops/papyrus's src/vehicle/playbooks-vehicle.ts. That secret must never be a
			// model-visible input field (the model has no business knowing or supplying it), so
			// it travels here instead, in principal.claims, from this extension's own already-
			// cached secret (registered at session_start -- see index.ts) -- the same value
			// sessionSecretField() used to thread through as a raw RPC input field before this
			// operation moved onto Vehicle.
			resolveInvocation: ({ descriptor, context }) => {
				if (descriptor.name !== "playbooks.invoke") return {};
				const sessionId = context.sessionManager.getSessionId();
				const { session_secret: sessionSecret } = sessionSecretField(sessionId);
				// Omit sessionSecret entirely when nothing is cached (unregistered session) --
				// {sessionSecret: null} would fail the module's own optionalString(input,
				// "session_secret") check (undefined-or-string, not null), a real regression from
				// sessionSecretField()'s own {} (key omitted) return for the same case.
				const claims: Record<string, string> = sessionSecret ? { sessionId, sessionSecret } : { sessionId };
				return { principal: { id: "pi-papyrus", claims } };
			},
		});
	} catch {
		// Daemon state is stale/unreachable -- degrade silently, matching
		// subscribeTaskPushChannel's own tolerance for the same condition.
	}
}
