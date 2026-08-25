import {
	connectPapyrusClient,
	type OperationName,
	type PapyrusClient,
	resolvePushChannelTarget,
	resolveVehicleClientTarget,
	type VehicleClientTarget,
} from "@danypops/papyrus";
import {
	connectPushChannel,
	createRetryingClient,
	type PushChannelClient,
	type PushChannelState,
	type RetryingClient,
} from "@danypops/vehicle-client/daemon-client";

type ClientConnector = () => Promise<PapyrusClient>;

let connector: ClientConnector = () => connectPapyrusClient();
// connectRetry:true (vehicle-client's own bounded background retry budget) covers a
// daemon that crashed and is mid systemd-restart -- without it, the very first call
// during that window fails immediately instead of waiting the ~2s restart out.
const client: RetryingClient<PapyrusClient> = createRetryingClient<PapyrusClient>(() => connector(), {
	label: "Papyrus",
	connectRetry: true,
});

// Passive lifecycle work must fail fast when the daemon is absent. The regular
// client keeps its restart-surviving retry budget for explicit user/tool calls.
const passiveClient: RetryingClient<PapyrusClient> = createRetryingClient<PapyrusClient>(() => connector(), {
	label: "Papyrus passive",
	connectRetry: false,
});

export async function papyrusClient(): Promise<PapyrusClient> {
	return client.call(async (resolved) => resolved);
}

export async function callService<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
	return client.call((resolved) => resolved.call<Input, Output>(operation, input));
}

/** Fail-fast daemon call for widgets, discovery, and lifecycle bookkeeping. */
export async function callServicePassive<Input extends Record<string, unknown>, Output>(
	operation: OperationName,
	input: Input,
): Promise<Output> {
	return passiveClient.call((resolved) => resolved.call<Input, Output>(operation, input));
}

export function setPapyrusClientConnectorForTests(value: ClientConnector): void {
	connector = value;
	client.reset();
	passiveClient.reset();
}

export function resetPapyrusClientForTests(): void {
	connector = () => connectPapyrusClient();
	client.reset();
	passiveClient.reset();
}

let pushChannelTargetResolver: typeof resolvePushChannelTarget = resolvePushChannelTarget;

export function setPushChannelTargetResolverForTests(value: typeof resolvePushChannelTarget): void {
	pushChannelTargetResolver = value;
}

export function resetPushChannelTargetResolverForTests(): void {
	pushChannelTargetResolver = resolvePushChannelTarget;
}

let vehicleClientTargetResolver: typeof resolveVehicleClientTarget = resolveVehicleClientTarget;

/**
 * Defaults to the real daemonStateDir() -- every test that exercises the full extension
 * entrypoint (registerPapyrus(api)), not just registerDomainTools, must override this
 * first, the same way mockService already overrides setPapyrusClientConnectorForTests,
 * or a hermetic unit test can silently start depending on whatever real Papyrus daemon
 * handle happens to exist on the machine running it.
 */
export function setVehicleClientTargetResolverForTests(value: () => VehicleClientTarget | undefined): void {
	vehicleClientTargetResolver = value;
}

export function resetVehicleClientTargetResolverForTests(): void {
	vehicleClientTargetResolver = resolveVehicleClientTarget;
}

export function currentVehicleClientTarget(): VehicleClientTarget | undefined {
	return vehicleClientTargetResolver();
}

/**
 * Subscribes to the daemon's "tasks" push topic so a widget can refresh the moment
 * a mutation happens, instead of waiting for its next poll tick. Returns undefined
 * (no-op) rather than throwing when the daemon has never started -- no token/port
 * on disk yet -- matching how the widget's own fetch-based refresh() already
 * tolerates "daemon not running" and falls back to its existing poll. A caller
 * should retry this on a later poll tick once the daemon is confirmed reachable.
 */
export function subscribeTaskPushChannel(
	onMessage: () => void,
	onStateChange?: (state: PushChannelState) => void,
): PushChannelClient | undefined {
	const target = pushChannelTargetResolver();
	if (!target) return undefined;
	return connectPushChannel({
		url: () => {
			// Re-resolved on every reconnect attempt: the daemon rebinds a new random
			// port on every restart, exactly the problem connectWithPolicy solves for
			// one-shot RPC by re-reading the handle file each time.
			const resolved = pushChannelTargetResolver();
			if (!resolved) throw new Error("Papyrus daemon is not running");
			return resolved.url;
		},
		token: target.token,
		topics: ["tasks"],
		onMessage: (topic) => {
			if (topic === "tasks") onMessage();
		},
		onStateChange,
	});
}
