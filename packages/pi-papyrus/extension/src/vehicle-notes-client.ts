/**
 * Registers every Vehicle-projected domain (notes.*, rules.*, docs.*, skills.*,
 * playbooks.*, tasks.*, artifact.*) as real Pi tools -- see @danypops/papyrus's
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
import { emitTaskFocusEvent } from "./task-focus-events.ts";

const REGISTERED_PERMISSIONS = [
	"notes:read", "notes:write", "rules:read", "rules:write", "docs:read", "docs:write",
	"skills:read", "skills:write", "playbooks:read", "playbooks:write", "tasks:read", "tasks:write",
	"artifact:read", "artifact:write",
];

/** Task Focus's own internal write needs a real, per-session secret -- see below. Every other tasks.* operation reads session_id purely for read-scoping and needs no secret. */
const FOCUS_MUTATION_OPERATIONS = new Set(["tasks.focus", "tasks.pause", "tasks.unpause", "tasks.clear_focus"]);

export async function registerNotesVehicle(pi: ExtensionAPI): Promise<void> {
	const target = currentVehicleClientTarget();
	if (!target) return;
	try {
		const client = new RemoteVehicleClient({ baseUrl: target.baseUrl, token: target.token });
		await registerVehicleTools(pi, client, {
			permissions: REGISTERED_PERMISSIONS,
			principal: { id: "pi-papyrus" },
			// playbooks.invoke's own module handler, and tasks.focus/pause/unpause/clear_focus's
			// own module handlers, authorize an internal Task Focus write via
			// sessionIdentity.assertAuthorized(session_id, session_secret) -- see
			// @danypops/papyrus's src/vehicle/playbooks-vehicle.ts and tasks-vehicle.ts. That
			// secret must never be a model-visible input field (the model has no business
			// knowing or supplying it), so it travels here instead, in principal.claims, from
			// this extension's own already-cached secret (registered at session_start -- see
			// index.ts) -- the same value sessionSecretField() used to thread through as a raw
			// RPC input field before these operations moved onto Vehicle.
			resolveInvocation: ({ descriptor, input, context }) => {
				if (descriptor.name !== "playbooks.invoke" && !FOCUS_MUTATION_OPERATIONS.has(descriptor.name)) return {};
				// tasks.* defaults session_id to this Pi session's own id, same as the removed
				// hand-rolled tool -- but the secret cache is keyed by whichever session_id is
				// actually being authorized, not blindly this session's, so a model that
				// explicitly overrides session_id to a DIFFERENT session never gets this
				// session's secret smuggled in on its behalf.
				const requestedSessionId = (input as { session_id?: unknown } | undefined)?.session_id;
				const sessionId = typeof requestedSessionId === "string" && requestedSessionId.length > 0 ? requestedSessionId : context.sessionManager.getSessionId();
				const { session_secret: sessionSecret } = sessionSecretField(sessionId);
				// Omit sessionSecret entirely when nothing is cached (unregistered session) --
				// {sessionSecret: null} would fail the module's own optionalString(input,
				// "session_secret") check (undefined-or-string, not null), a real regression from
				// sessionSecretField()'s own {} (key omitted) return for the same case.
				const claims: Record<string, string> = sessionSecret ? { sessionId, sessionSecret } : { sessionId };
				return { principal: { id: "pi-papyrus", claims } };
			},
			// papyrus.task-focus.v1 is a same-process Pi extension event bus broadcast (e.g. a
			// token-cost router correlating its own telemetry with the currently focused task)
			// -- has no Vehicle-transport equivalent, so it's emitted here, client-side, rather
			// than from the operation's own output.
			onInvoked: ({ descriptor }, output) => {
				if (descriptor.name === "tasks.focus") {
					const artifact = output as { id: string } | undefined;
					if (artifact?.id) emitTaskFocusEvent({ taskId: artifact.id, status: "focused" });
					return;
				}
				if (descriptor.name === "tasks.pause" || descriptor.name === "tasks.unpause") {
					const focus = output as { artifact: { id: string } } | undefined;
					if (focus?.artifact?.id) emitTaskFocusEvent({ taskId: focus.artifact.id, status: descriptor.name === "tasks.pause" ? "paused" : "unpaused" });
					return;
				}
				if (descriptor.name === "tasks.clear_focus") {
					const result = output as { cleared: boolean } | undefined;
					if (result?.cleared) emitTaskFocusEvent({ taskId: null, status: "cleared" });
				}
			},
		});
	} catch {
		// Daemon state is stale/unreachable -- degrade silently, matching
		// subscribeTaskPushChannel's own tolerance for the same condition.
	}
}
