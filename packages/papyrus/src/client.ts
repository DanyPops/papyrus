import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	connectWithVersionCheck,
	type ExpectedVersion,
	type SpawnPlatformOptions,
	spawnDetachedDaemon,
} from "@danypops/vehicle-client/daemon-client";
import { createLiveVersionExpectation } from "@danypops/vehicle-client/version";
import type { DaemonDiagnosis } from "@danypops/vehicle-server/daemon-lifecycle";
import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_DIR_ENV, DAEMON_PROBE_TIMEOUT_MS } from "./constants.ts";
import { type DaemonHandle, daemonStateDir, readDaemonHandle } from "./daemon/daemon-state.ts";
import type { OperationName, SchemaState } from "./service.ts";

/**
 * Compared against the running daemon's /health-reported version by connectWithVersionCheck
 * below. Re-read fresh on every call, not cached -- a module-level `const` here was the exact
 * bug that caused repeated, never-self-healing daemon kill/respawn churn on any process that
 * outlived an `npm update` (a respawned daemon runs the same source and reports the same real
 * version, so a stale cached expectation never converges).
 */
const papyrusExpectedVersion = createLiveVersionExpectation(new URL("../package.json", import.meta.url), "Papyrus");

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
		const body = (await response.json()) as { error?: string } & T;
		if (!response.ok) throw new Error(body.error ?? `Papyrus daemon HTTP ${response.status}`);
		return body;
	}

	health(): Promise<{ ok: true; version: string; schema: SchemaState }> {
		return this.request("/health");
	}

	/** Backed by GET /daemon/diagnose -- see service.ts's createApp and vehicle-server's daemon-lifecycle.ts. */
	diagnose(): Promise<DaemonDiagnosis> {
		return this.request("/daemon/diagnose");
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

async function probedPapyrusClient(handle: DaemonHandle): Promise<PapyrusClient> {
	const probe = new PapyrusClient(handle.baseUrl, handle.token, (request) => fetch(request), DAEMON_PROBE_TIMEOUT_MS);
	try {
		await probe.health();
		return new PapyrusClient(handle.baseUrl, handle.token);
	} catch {
		throw new Error("Papyrus daemon state is stale or unreachable; restart papyrus.service");
	}
}

/** packages/papyrus/src/cli.ts, resolved relative to this file's own installed location, not require.resolve('@danypops/papyrus') -- this module IS that package, no cross-package lookup needed. */
function papyrusCliPath(): string {
	return fileURLToPath(new URL("cli.ts", import.meta.url));
}

/**
 * spawnDetachedDaemon's injected spawn() callback, factored out for a direct unit test.
 *
 * A spawn() failure (missing binPath, no exec permission, wrong interpreter) surfaces
 * asynchronously as an "error" event on the ChildProcess -- with no listener, Node treats it
 * as an uncaught exception and kills the whole host process, not just this one connect
 * attempt (a real incident: auto-spawning against a since-deleted binPath crashed Pi itself).
 * The listener below turns that into an ordinary logged failure instead: the handle file
 * simply never appears, and connectWithPolicy's own poll-then-timeout already reports that
 * as its usual, catchable fallbackMessage error.
 */
export function spawnPapyrusDaemonProcess(command: string, args: string[], spawnOptions: SpawnPlatformOptions): void {
	const child = spawnProcess(command, args, spawnOptions);
	child.on("error", (error) => {
		console.error(`Papyrus daemon auto-spawn failed: ${error instanceof Error ? error.message : String(error)}`);
	});
	child.unref();
}

/** connectWithVersionCheck's killStaleProcess callback, factored out for a direct unit test -- a real spawned daemon can't be made to report a mismatched version without a second build. */
export function killStalePapyrusDaemon(handle: Pick<DaemonHandle, "pid">): void {
	if (handle.pid <= 0) return; // daemon-state.ts's inert "unknown pid" sentinel -- never a real process.
	try {
		process.kill(handle.pid, "SIGTERM");
	} catch {
		// Caller's handle-file poll is the real guarantee, not this call succeeding.
	}
}

export interface ConnectPapyrusClientOptions {
	/**
	 * Environment passed to an auto-spawned daemon child. Defaults to the current
	 * process.env. Always carries DAEMON_DIR_ENV=dir so the spawned child computes
	 * the exact same state directory this call itself reads/polls -- without this,
	 * a caller-supplied `dir` (every real test; production always uses the default
	 * daemonStateDir(), which the child would derive identically on its own) would
	 * silently diverge from wherever the child actually starts writing its handle.
	 */
	env?: Record<string, string | undefined>;
	/** Overrides the version connectWithVersionCheck compares against. Defaults to PAPYRUS_VERSION; test-only -- lets a test force a mismatch against a real daemon without a second build. */
	expectedVersion?: ExpectedVersion;
	/**
	 * Overrides the default fail-closed behavior (see connectPapyrusClient's own doc comment for
	 * why that default changed). Test-only -- covers the auto-spawn mechanism itself
	 * (connect-client-auto-spawn.test.ts) and lets other real-daemon integration tests keep using
	 * it as convenient bootstrap. A real, non-Armada-supervised standalone deployment could also
	 * set this explicitly, but that is not this option's primary purpose.
	 */
	autoStart?: boolean;
}

/**
 * Fails closed if nothing is reachable at all -- matches lector/pi-packed (see
 * @danypops/vehicle-client's connectWithPolicy doc comment). Papyrus used to auto-start here
 * (autoStart: true) because it predated being a properly Armada-supervised Vehicle; that flag
 * is now a genuine liability, not a convenience: a real, live race was traced to it directly --
 * Armada's own systemd unit and THIS client's auto-spawn each independently tried to be "the one
 * that starts Papyrus" whenever no daemon was momentarily reachable (e.g. mid-restart), and
 * whichever one's child won the OS-level single-instance-lock race became an orphan invisible to
 * systemd's own tracking, permanently confusing `armada status`. Now that Armada's systemd unit
 * (Restart=on-failure) is the one and only thing responsible for keeping Papyrus running, a
 * client that finds nothing reachable should say so plainly, not compete to fix it.
 *
 * Stale-VERSION self-healing (an already-running daemon reporting an older version than this
 * client expects) is unrelated to autoStart and still works: connectWithVersionCheck's own kill-
 * and-replace path only requires `spawn` to be defined, independent of the autoStart flag above.
 */
export async function connectPapyrusClient(
	dir: string = daemonStateDir(),
	options: ConnectPapyrusClientOptions = {},
): Promise<PapyrusClient> {
	return connectWithVersionCheck(
		{
			readHandle: () => readDaemonHandle(dir) ?? null,
			buildClient: probedPapyrusClient,
			autoStart: options.autoStart ?? false,
			spawn: () => {
				spawnDetachedDaemon({
					binPath: papyrusCliPath(),
					args: ["serve"],
					env: { ...(options.env ?? process.env), [DAEMON_DIR_ENV]: dir },
					spawn: spawnPapyrusDaemonProcess,
				});
			},
			fallbackMessage:
				"Papyrus daemon is not running; Armada should be supervising it -- run `armada status`/`armada reconcile`, or `papyrus serve` directly if this is a standalone (non-Armada) setup.",
		},
		{
			expectedVersion: options.expectedVersion ?? papyrusExpectedVersion,
			readVersion: async (client) => (await client.health()).version,
			killStaleProcess: killStalePapyrusDaemon,
		},
	);
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
	/** Base URL for a domain migrated onto VehicleRegistry (see src/handlers/*.ts) -- @danypops/vehicle-client's RemoteVehicleClient mounts its own /vehicle/manifest, /vehicle/invoke, /vehicle/cancel routes under this. */
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
