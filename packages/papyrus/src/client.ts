import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_PROBE_TIMEOUT_MS } from "./constants.ts";
import { daemonStateDir, readDaemonHandle } from "./daemon-state.ts";
import type { OperationName, SchemaState } from "./service.ts";

export type FetchAdapter = (request: Request) => Promise<Response>;

export class PapyrusClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly fetchAdapter: FetchAdapter = (request) => fetch(request),
		private readonly timeoutMs: number = DAEMON_CLIENT_TIMEOUT_MS,
	) {}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const request = new Request(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
				...init.headers,
			},
			signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
		});
		const response = await this.fetchAdapter(request);
		const body = await response.json() as { error?: string } & T;
		if (!response.ok) throw new Error(body.error ?? `Papyrus daemon HTTP ${response.status}`);
		return body;
	}

	health(): Promise<{ ok: true; version: string; schema: SchemaState }> {
		return this.request("/health");
	}

	async operations(): Promise<OperationName[]> {
		const body = await this.request<{ operations: OperationName[] }>("/api/v1/ops");
		return body.operations;
	}

	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		const body = await this.request<{ result: Output }>("/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: operation, input }),
		});
		return body.result;
	}
}

export async function connectPapyrusClient(dir: string = daemonStateDir()): Promise<PapyrusClient> {
	const handle = readDaemonHandle(dir);
	if (!handle) throw new Error("Papyrus daemon is not running; install/start papyrus.service");
	const probe = new PapyrusClient(handle.baseUrl, handle.token, (request) => fetch(request), DAEMON_PROBE_TIMEOUT_MS);
	try {
		await probe.health();
		return new PapyrusClient(handle.baseUrl, handle.token);
	} catch {
		throw new Error("Papyrus daemon state is stale or unreachable; restart papyrus.service");
	}
}

export interface PushChannelTarget {
	/** ws:// URL for the daemon's push-invalidation channel (see push-channel.ts in vehicle-server). */
	url: string;
	token: string;
}

/**
 * Narrow surface for a push-channel consumer -- exposes only what's needed to open
 * the WebSocket (url derived from the same handle connectPapyrusClient reads, token),
 * not daemon-state.ts's whole internal handle shape. Returns undefined rather than
 * throwing when the daemon has never started (no token/port on disk yet); a caller
 * wiring this into a UI widget already tolerates "daemon not running" for its own
 * fetch-based refresh and should treat push-channel absence the same way -- fall
 * back to polling rather than surfacing an error.
 */
export function resolvePushChannelTarget(dir: string = daemonStateDir()): PushChannelTarget | undefined {
	const handle = readDaemonHandle(dir);
	if (!handle) return undefined;
	return { url: `${handle.baseUrl.replace(/^http/, "ws")}/push`, token: handle.token };
}

export interface VehicleClientTarget {
	/** Base URL for a domain migrated onto VehicleRegistry (see src/vehicle/*.ts) -- @danypops/vehicle-client's RemoteVehicleClient mounts its own /vehicle/manifest, /vehicle/invoke, /vehicle/cancel routes under this. */
	baseUrl: string;
	token: string;
}

/**
 * Narrow surface for a Vehicle-projected domain consumer -- same daemon, same
 * handle file, same Bearer token every other Papyrus RPC call already uses (see
 * service.ts's createApp, which mounts the Vehicle HTTP app at /vehicle/* on
 * this same port). Returns undefined rather than throwing when the daemon has
 * never started, matching resolvePushChannelTarget's own tolerance.
 */
export function resolveVehicleClientTarget(dir: string = daemonStateDir()): VehicleClientTarget | undefined {
	const handle = readDaemonHandle(dir);
	if (!handle) return undefined;
	return { baseUrl: handle.baseUrl, token: handle.token };
}
