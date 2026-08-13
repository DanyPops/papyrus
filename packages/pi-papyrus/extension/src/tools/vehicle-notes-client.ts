/**
 * Registers every Vehicle-projected domain (notes.*, rules.*, docs.*, playbooks.*,
 * tasks.*, discuss.*, artifact.*) as real Pi tools -- see @danypops/papyrus's
 * src/handlers/registry.ts. discuss.* is the last of the six domains to
 * migrate off pi-papyrus's own retired hand-rolled pi.registerTool() mega-tool.
 *
 * Deferred to registerVehicleToolsWhenReady's own internal session_start handler
 * (bounded retry/backoff, matching pi-tickets' registerTicketsVehicle) rather than
 * a single unretried attempt: a daemon that's merely slow to start, or transiently
 * unreachable right when session_start fires (including on /reload, which re-runs
 * this extension's factory and this call), no longer permanently drops every
 * notes/rules/docs/playbooks/tasks/discuss/artifact tool for the rest of the
 * session. Every outcome logs through ctx.ui.notify instead of vanishing.
 *
 * Uses service-client.ts's currentVehicleClientTarget() (test-injectable) rather
 * than resolveVehicleClientTarget() directly, so a test exercising the full
 * extension entrypoint doesn't resolve a real daemonStateDir().
 *
 * The client itself is wrapped in createReconnectingVehicleClient() once, re-resolving
 * currentVehicleClientTarget() on every reconnect attempt rather than closing over
 * one target captured here -- the daemon rebinds a new random port on every restart,
 * so a bare RemoteVehicleClient built once would have no way to notice its baseUrl
 * had died.
 */

import { createReconnectingVehicleClient, daemonInstanceIdentity } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { type RegisteredPiVehicle, registerVehicleToolsWhenReady, type VehicleReadyEvent } from "@danypops/vehicle-client-pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discussLiveFollowUp } from "../discuss/discuss-live-follow-up.ts";
import { currentVehicleClientTarget } from "../service-client.ts";
import { sessionSecretField } from "../session-identity.ts";
import { emitTaskFocusEvent } from "../task/task-focus-events.ts";
import { recordRenderDiagnostic, shapeFingerprint } from "./render-diagnostics.ts";
import { papyrusVehiclePresentations, papyrusVehicleRenderers } from "./vehicle-artifact-renderers.ts";

const REGISTERED_PERMISSIONS = [
	"notes:read",
	"notes:write",
	"rules:read",
	"rules:write",
	"docs:read",
	"docs:write",
	"playbooks:read",
	"playbooks:write",
	"tasks:read",
	"tasks:write",
	"discuss:read",
	"discuss:write",
	"artifact:read",
	"artifact:write",
];

/** Task Focus's own internal write needs a real, per-session secret -- see below. Every other tasks.* operation reads session_id purely for read-scoping and needs no secret. */
const FOCUS_MUTATION_OPERATIONS = new Set(["tasks.focus", "tasks.pause", "tasks.unpause", "tasks.clear_focus"]);

/**
 * Vehicle Shell's core set (see @danypops/vehicle-client-pi's registerVehicleTools `shell`
 * option): the handful of operations used in nearly every session, active from turn one with no
 * tools_man round-trip. Every other operation (91 total at last count, ~8929 tokens of always-
 * loaded schema) boots inactive, reachable via tools_list/tools_man. Illustrative, not fixed --
 * tune from real usage.
 */
const CORE_OPERATIONS = ["tasks.list", "tasks.create", "tasks.start", "tasks.submit", "tasks.complete", "tasks.context"];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Surfaces a real resolution/registration error and the terminal exhausted state (the
 * case that used to leave every notes/rules/docs/playbooks/tasks/discuss/artifact tool
 * unregistered for the whole session with no visible sign why) -- a daemon merely still
 * starting up (repeated client-unavailable before the last attempt) stays quiet, matching
 * pi-tickets' own notifyReadyEvent.
 */
function notifyReadyEvent(event: VehicleReadyEvent): void {
	switch (event.kind) {
		case "client-resolution-failed":
			event.ctx.ui.notify(`papyrus daemon target resolution failed: ${errorMessage(event.error)}`, "warning");
			return;
		case "registration-failed":
			event.ctx.ui.notify(`papyrus tool registration failed: ${errorMessage(event.error)}`, "warning");
			return;
		case "exhausted":
			event.ctx.ui.notify(
				`papyrus tools unavailable this session -- the daemon never became reachable after ${event.attempts} attempts`,
				"warning",
			);
			return;
		case "client-unavailable":
		case "registered":
			return;
	}
}

/**
 * Fire-and-forget from the extension's top-level factory: registerVehicleToolsWhenReady
 * registers its own session_start handler internally and defers the actual
 * pi.getAllTools()/getActiveTools()/setActiveTools() calls to it (Pi's extension runtime
 * only finishes initializing after every extension's factory has resolved, so calling
 * registerVehicleTools directly from here throws "Extension runtime not initialized").
 * The returned promise settles once that sequence succeeds or exhausts its attempts --
 * awaiting it is optional and mainly useful for tests.
 */
export function registerNotesVehicle(pi: ExtensionAPI): Promise<RegisteredPiVehicle | undefined> {
	recordRenderDiagnostic({ event: "register-notes-vehicle-called" });
	function resolveTarget() {
		const resolved = currentVehicleClientTarget();
		if (!resolved) throw new Error("Papyrus daemon is not running");
		return resolved;
	}
	const client = createReconnectingVehicleClient(
		async () => {
			const resolved = resolveTarget();
			return new RemoteVehicleClient({ baseUrl: resolved.baseUrl, token: resolved.token });
		},
		{
			// The random loopback port is process-instance identity for Papyrus: it changes on
			// every restart while the bearer token intentionally survives. Re-read it before
			// every dispatch so a long-lived Pi session never sends one sacrificial call to a
			// cached dead port just to discover what the handle file already says.
			resolveIdentity: () => daemonInstanceIdentity(resolveTarget().baseUrl),
		},
	);
	return registerVehicleToolsWhenReady(pi, () => Promise.resolve(currentVehicleClientTarget() ? client : undefined), {
		log: (event) => {
			// Correlates against onInvoked's own timestamps below -- the /reload investigation's
			// leading theory is a race between this fire-and-forget registration actually
			// completing (this "registered" event) and Pi resolving a tool's ToolDefinition for
			// rendering at the moment its tool-call message streams in.
			recordRenderDiagnostic({ event: "vehicle-ready", kind: event.kind, ...("attempt" in event ? { attempt: event.attempt } : {}) });
			notifyReadyEvent(event);
		},
		permissions: REGISTERED_PERMISSIONS,
		principal: { id: "pi-papyrus" },
		renderers: papyrusVehicleRenderers,
		// papyrusVehiclePresentations projects a bounded, versioned PapyrusToolDetails DTO
		// before Pi persists this call's details -- renderers above still supplies renderCall
		// (createTool sources renderCall/renderResult independently; presentations' own
		// renderResult takes priority over renderers' renderResult, and falls back to it for a
		// partial/error result or a historical session row persisted before this seam existed).
		presentations: papyrusVehiclePresentations,
		// tools_list/tools_man are a neutral, process-wide singleton now (vehicle-client-pi's own
		// ensureVehicleShellHandle) -- no ownVehicleName/broker option needed here anymore; every
		// vehicle in the process (including papyrus's own) is discovered and namespaced uniformly.
		shell: { coreOperations: CORE_OPERATIONS },
		// playbooks.invoke's own module handler, and tasks.focus/pause/unpause/clear_focus's
		// own module handlers, authorize an internal Task Focus write via
		// sessionIdentity.assertAuthorized(session_id, session_secret) -- see
		// @danypops/papyrus's src/handlers/playbooks.ts and tasks.ts. That
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
			const sessionId =
				typeof requestedSessionId === "string" && requestedSessionId.length > 0
					? requestedSessionId
					: context.sessionManager.getSessionId();
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
		// discuss.open/discuss.reply's own live:true synchronous human round-trip --
		// see discuss/discuss-live-follow-up.ts. Every other operation's resolver call
		// returns undefined, meaning zero behavior change for the other 5 domains.
		interactiveFollowUps: (descriptor) =>
			descriptor.name === "discuss.open" || descriptor.name === "discuss.reply" ? discussLiveFollowUp : undefined,
		// The retired discuss tool declared executionMode: "sequential" so the model
		// couldn't batch a live ask alongside other tool calls in the same turn and
		// let those run before the human sees the prompt -- same reasoning here.
		executionMode: (descriptor) => (descriptor.name === "discuss.open" || descriptor.name === "discuss.reply" ? "sequential" : undefined),
		onInvoked: ({ descriptor }, output) => {
			// See vehicle-notes-client.ts's log wiring above -- correlates a real invocation's
			// timestamp against when registration actually completed.
			recordRenderDiagnostic({ event: "invoked", operation: descriptor.name, output: shapeFingerprint(output) });
			if (descriptor.name === "tasks.focus") {
				const artifact = output as { id: string } | undefined;
				if (artifact?.id) emitTaskFocusEvent({ taskId: artifact.id, status: "focused" });
				return;
			}
			if (descriptor.name === "tasks.pause" || descriptor.name === "tasks.unpause") {
				const focus = output as { artifact: { id: string } } | undefined;
				if (focus?.artifact?.id)
					emitTaskFocusEvent({ taskId: focus.artifact.id, status: descriptor.name === "tasks.pause" ? "paused" : "unpaused" });
				return;
			}
			if (descriptor.name === "tasks.clear_focus") {
				const result = output as { cleared: boolean } | undefined;
				if (result?.cleared) emitTaskFocusEvent({ taskId: null, status: "cleared" });
			}
		},
	});
}
