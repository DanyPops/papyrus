import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";
import { type LaunchProvenance, readLaunchProvenance } from "@danypops/vehicle-server/daemon";
import { diagnoseDaemon, openDaemonLifecycleLog } from "@danypops/vehicle-server/daemon-lifecycle";
import { openVehicleMetricsStore } from "@danypops/vehicle-server/metrics";
import { createVehicleMetricsMiddleware } from "@danypops/vehicle-server/metrics-middleware";
import { registerVehicleMetricsOperations } from "@danypops/vehicle-server/metrics-operations";
import {
	type AcquireLockResult,
	acquireDaemonLock,
	acquireDaemonLockAsService,
	type ReclaimDeps,
	releaseDaemonLock,
} from "@danypops/vehicle-server/paths";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { DAEMON_HOST, DB_OPTIMIZE_INTERVAL_MS, dbPath, metricsPath, WAL_CHECKPOINT_INTERVAL_MS } from "../constants.ts";
import { logEvent, logger } from "../log/log.ts";
import { createApp, createPapyrusService } from "../service.ts";
import {
	clearDaemonPort,
	clearSharedVehicleHandle,
	clearVehicleHandle,
	daemonStateDir,
	lifecyclePath,
	loadOrCreateToken,
	tokenPath,
	writeDaemonPort,
	writeSharedVehicleHandle,
	writeVehicleHandle,
} from "./daemon-state.ts";
import { createTaskMutationPushMiddleware } from "./task-mutation-push.ts";

/**
 * Operations that never change what a Task-graph reader (the pi-papyrus widget's
 * push subscriber) would see -- excluded from the "tasks" publish so a read call
 * doesn't trigger a pointless extra refresh. Defaults to publishing for anything
 * not in this set, including future operations -- a missed push (stale widget for
 * up to one poll interval, the existing fallback) is a far smaller cost than a
 * silently-uncovered new mutation.
 */
const TASK_READ_ONLY_OPERATIONS = new Set([
	"tasks.active",
	"tasks.context",
	"tasks.event_feed",
	"tasks.focused",
	"tasks.graph",
	"tasks.history",
	"tasks.list",
	"tasks.plan",
	"tasks.scope",
	"tasks.show",
]);

/** Matches @danypops/vehicle-server's own STREAMING_IDLE_TIMEOUT_S (daemon.ts) -- see this file's
 * own fetch handler for why Papyrus needs the identical fix applied directly, not inherited. */
const VEHICLE_INVOKE_IDLE_TIMEOUT_S = 3_600;

/** Gives a supervised launch authority to replace an unmanaged lock holder. */
export async function acquirePapyrusDaemonLock(
	lockPath: string,
	provenance: LaunchProvenance,
	reclaim: ReclaimDeps = {},
): Promise<AcquireLockResult> {
	return provenance === "service"
		? acquireDaemonLockAsService(lockPath, reclaim)
		: acquireDaemonLock(lockPath, reclaim.isPidAlive, provenance);
}

/** Start the supervised, long-running Papyrus service. */
export async function serveMain(): Promise<void> {
	const stateDir = daemonStateDir();
	const lockPath = join(stateDir, "daemon.lock");
	const instanceId = randomUUID();
	const provenance = readLaunchProvenance();
	const lifecycleLog = openDaemonLifecycleLog({ path: lifecyclePath(stateDir), fs: createNodeAtomicJsonFsAdapter() });
	const recordLifecycle = async (type: "started" | "already_running" | "stopped", reason?: string): Promise<void> => {
		try {
			await lifecycleLog.record({ instanceId, pid: process.pid, type, provenance, reason });
		} catch (error) {
			logEvent("error", "lifecycle_log_record_failed", { message: error instanceof Error ? error.message : String(error) });
		}
	};
	const lock = await acquirePapyrusDaemonLock(lockPath, provenance, {
		log: (event) =>
			logEvent(event.outcome === "reaped" ? "warn" : "info", `daemon_lock_${event.outcome}`, {
				holderPid: event.holderPid,
				holderProvenance: event.holderProvenance,
				method: event.method,
				reason: event.reason,
			}),
	});
	if (!lock.acquired) {
		logEvent("info", "already_running", { holderPid: lock.holderPid });
		await recordLifecycle("already_running", lock.holderPid === null ? undefined : `holder pid ${lock.holderPid}`);
		return;
	}
	const startedAt = new Date().toISOString();
	const token = loadOrCreateToken(stateDir);
	const service = createPapyrusService(dbPath());
	// Records how often each real operation is invoked (server-side, every caller) plus, via
	// metrics.recordClientEvent, client-observed Vehicle Shell meta-tool calls -- see
	// @danypops/vehicle-server's own metrics README section. Wired directly onto the same registry
	// every real papyrus operation is already registered on, so it's discoverable through the exact
	// same tools_list/tools_man path as any other operation.
	const vehicleMetrics = openVehicleMetricsStore(metricsPath());
	service.vehicle.useExecutionMiddleware(createVehicleMetricsMiddleware(vehicleMetrics, "papyrus"));
	registerVehicleMetricsOperations(service.vehicle, vehicleMetrics, "papyrus");
	const pushChannel = new PushChannel({ token });
	service.vehicle.useExecutionMiddleware(createTaskMutationPushMiddleware((operation) => pushChannel.publish("tasks", { operation })));
	const app = createApp({
		service,
		token,
		onOperationExecuted: (operation) => {
			if (operation.startsWith("tasks.") && !TASK_READ_ONLY_OPERATIONS.has(operation)) {
				pushChannel.publish("tasks", { operation });
			}
		},
		logger,
		diagnose: () => diagnoseDaemon({ lifecycleLog, current: { instanceId, pid: process.pid, startedAt, provenance } }),
	});
	const server = Bun.serve({
		hostname: DAEMON_HOST,
		port: 0,
		fetch: (request, bunServer) => {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/push") return pushChannel.upgrade(request, bunServer) ?? undefined;
			// Bun.serve's own idleTimeout defaults to 10s and applies per-connection regardless of
			// how long a given request is expected to take -- @danypops/vehicle-server's own daemon.ts
			// (startBunListener) already fixed this for every Vehicle-backed daemon that goes through
			// its shared startDaemon() substrate; Papyrus's own daemon.ts predates that substrate and
			// has this separate, hand-rolled Bun.serve() call, so it needs the identical fix applied
			// directly here. Real live incident (papyrus task d0eb81b7): tasks.run_gates/tasks.complete
			// can legitimately take tens of seconds to actually run a caller's own gate command,
			// sending zero response bytes the whole time -- just as exposed to Bun's 10s default as
			// the streaming case, and neither gate.timeoutMs nor VehicleLimits.maxTimeoutMs ever gets a
			// chance to apply if the raw TCP connection is already dead first.
			if (pathname === "/vehicle/invoke") bunServer.timeout(request, VEHICLE_INVOKE_IDLE_TIMEOUT_S);
			return app.fetch(request);
		},
		// A no-op fallback when pushChannel never calls server.upgrade() is safe: Bun only
		// invokes these handlers for a connection that actually upgraded.
		websocket: pushChannel.websocketHandlers(),
	});
	if (!server.port) {
		service.close();
		vehicleMetrics.close();
		releaseDaemonLock(lockPath);
		throw new Error("Papyrus daemon failed to bind a listener");
	}
	writeDaemonPort(stateDir, server.port);
	writeVehicleHandle(stateDir, server.port);
	try {
		writeSharedVehicleHandle(server.port, tokenPath(stateDir));
	} catch (error) {
		logEvent("error", "shared_vehicle_handle_write_failed", { message: error instanceof Error ? error.message : String(error) });
	}
	const checkpointTimer = setInterval(() => {
		try {
			service.checkpoint();
		} catch (error) {
			logEvent("error", "checkpoint_failed", { message: error instanceof Error ? error.message : String(error) });
		}
	}, WAL_CHECKPOINT_INTERVAL_MS);
	const optimizeTimer = setInterval(() => {
		try {
			service.optimize();
		} catch (error) {
			logEvent("error", "optimize_failed", { message: error instanceof Error ? error.message : String(error) });
		}
	}, DB_OPTIMIZE_INTERVAL_MS);
	// Daily cadence (reusing DB_OPTIMIZE_INTERVAL_MS) is plenty against a 30-day staleness
	// threshold (TASK_FOCUS_STALE_AFTER_MS) -- see clean-up-stale-per-session-task-focus-rows-
	// on-real-session-l-9i7s.
	const reapFocusTimer = setInterval(() => {
		try {
			const removed = service.reapStaleFocus();
			if (removed > 0) logEvent("info", "stale_focus_reaped", { removed });
		} catch (error) {
			logEvent("error", "reap_stale_focus_failed", { message: error instanceof Error ? error.message : String(error) });
		}
	}, DB_OPTIMIZE_INTERVAL_MS);
	// Same daily cadence: ARTIFACT_TRASH_RETENTION_MS is 30 days, so a daily sweep finds newly
	// due artifacts promptly without needing its own tighter interval -- see domain/artifact-trash.ts.
	const purgeTrashTimer = setInterval(() => {
		try {
			const purged = service.purgeDueTrash();
			if (purged > 0) logEvent("info", "artifact_trash_purged", { purged });
		} catch (error) {
			logEvent("error", "purge_trash_failed", { message: error instanceof Error ? error.message : String(error) });
		}
	}, DB_OPTIMIZE_INTERVAL_MS);
	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) return;
		stopping = true;
		clearInterval(checkpointTimer);
		clearInterval(optimizeTimer);
		clearInterval(reapFocusTimer);
		clearInterval(purgeTrashTimer);
		clearDaemonPort(stateDir);
		clearVehicleHandle(stateDir);
		try {
			clearSharedVehicleHandle();
		} catch (error) {
			logEvent("error", "shared_vehicle_handle_remove_failed", { message: error instanceof Error ? error.message : String(error) });
		}
		releaseDaemonLock(lockPath);
		service.close();
		vehicleMetrics.close();
		// .finally() re-throws rather than handling a rejection -- catching it first turns a bare
		// unhandled-rejection warning into a real, queryable shutdown-failure log line.
		void recordLifecycle("stopped", signal)
			.then(() => server.stop(true))
			.catch((error) => logEvent("error", "server_stop_failed", { message: error instanceof Error ? error.message : String(error) }))
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	logEvent("info", "listening", { host: DAEMON_HOST, port: server.port });
	await recordLifecycle("started");
}
