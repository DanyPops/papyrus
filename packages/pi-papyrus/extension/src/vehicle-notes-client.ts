/**
 * Registers every Vehicle-projected domain (notes.*, rules.*, docs.*, artifact.*)
 * as real Pi tools -- see @danypops/papyrus's src/vehicle/papyrus-vehicle.ts.
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

const REGISTERED_PERMISSIONS = ["notes:read", "notes:write", "rules:read", "rules:write", "docs:read", "docs:write", "artifact:read", "artifact:write"];

export async function registerNotesVehicle(pi: ExtensionAPI): Promise<void> {
	const target = currentVehicleClientTarget();
	if (!target) return;
	try {
		const client = new RemoteVehicleClient({ baseUrl: target.baseUrl, token: target.token });
		await registerVehicleTools(pi, client, {
			permissions: REGISTERED_PERMISSIONS,
			principal: { id: "pi-papyrus" },
		});
	} catch {
		// Daemon state is stale/unreachable -- degrade silently, matching
		// subscribeTaskPushChannel's own tolerance for the same condition.
	}
}
