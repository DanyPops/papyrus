/**
 * Registers notes.* as a real Vehicle instead of a hand-rolled `pi.registerTool()`
 * mega-tool -- see @danypops/papyrus's src/vehicle/notes-vehicle.ts for the
 * VehicleRegistry side. Same daemon, same handle file, same Bearer token every
 * other Papyrus RPC call already uses (resolveVehicleClientTarget mirrors
 * resolvePushChannelTarget's own resolution).
 *
 * Papyrus's daemon is expected to already be running as an installed service
 * (see `packed install-service`), not auto-spawned on first use -- so unlike
 * registerVehicleTools' README example, failure here (daemon not started yet,
 * stale handle) is tolerated the same silent-degrade way
 * subscribeTaskPushChannel already tolerates it, rather than letting a
 * daemon-not-running condition abort the rest of extension setup. There is
 * no retry-on-later-connect for a tool that was never registered at all --
 * Pi has no way to add one after the fact outside the initial registration
 * flow.
 *
 * Resolves the target through service-client.ts's currentVehicleClientTarget()
 * (test-injectable, see setVehicleClientTargetResolverForTests), never
 * @danypops/papyrus's resolveVehicleClientTarget() directly -- this runs from
 * the bare extension entrypoint on every registerPapyrus(api) call, so an
 * un-injected default would resolve the real daemonStateDir() in any test
 * exercising the full entrypoint, not just ones about notes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { registerVehicleTools } from "@danypops/vehicle-client-pi";
import { currentVehicleClientTarget } from "./service-client.ts";

export async function registerNotesVehicle(pi: ExtensionAPI): Promise<void> {
	const target = currentVehicleClientTarget();
	if (!target) return;
	try {
		const client = new RemoteVehicleClient({ baseUrl: target.baseUrl, token: target.token });
		await registerVehicleTools(pi, client, {
			permissions: ["notes:read", "notes:write"],
			principal: { id: "pi-papyrus" },
		});
	} catch {
		// Daemon state is stale/unreachable -- degrade silently, matching
		// subscribeTaskPushChannel's own tolerance for the same condition.
	}
}
