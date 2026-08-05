import { join } from "node:path";
import { acquireDaemonLock, releaseDaemonLock } from "@danypops/vehicle-server/paths";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { DAEMON_HOST, DB_OPTIMIZE_INTERVAL_MS, dbPath, WAL_CHECKPOINT_INTERVAL_MS } from "./constants.ts";
import {
	clearDaemonPort,
	clearVehicleHandle,
	daemonStateDir,
	loadOrCreateToken,
	writeDaemonPort,
	writeVehicleHandle,
} from "./daemon-state.ts";
import { logEvent, vehicleLogger } from "./log.ts";
import { createApp, createPapyrusService } from "./service.ts";

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

/** Start the supervised, long-running Papyrus service. */
export function serveMain(): void {
	const stateDir = daemonStateDir();
	const lockPath = join(stateDir, "daemon.lock");
	const lock = acquireDaemonLock(lockPath);
	if (!lock.acquired) {
		logEvent("info", "already_running", { holderPid: lock.holderPid });
		return;
	}
	const token = loadOrCreateToken(stateDir);
	const service = createPapyrusService(dbPath());
	const pushChannel = new PushChannel({ token });
	const app = createApp({
		service,
		token,
		onOperationExecuted: (operation) => {
			if (operation.startsWith("tasks.") && !TASK_READ_ONLY_OPERATIONS.has(operation)) {
				pushChannel.publish("tasks", { operation });
			}
		},
		logger: vehicleLogger(),
	});
	const server = Bun.serve({
		hostname: DAEMON_HOST,
		port: 0,
		fetch: (request, bunServer) => {
			if (new URL(request.url).pathname === "/push") return pushChannel.upgrade(request, bunServer) ?? undefined;
			return app.fetch(request);
		},
		// A no-op fallback when pushChannel never calls server.upgrade() is safe: Bun only
		// invokes these handlers for a connection that actually upgraded.
		websocket: pushChannel.websocketHandlers(),
	});
	if (!server.port) {
		service.close();
		releaseDaemonLock(lockPath);
		throw new Error("Papyrus daemon failed to bind a listener");
	}
	writeDaemonPort(stateDir, server.port);
	writeVehicleHandle(stateDir, server.port);
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
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		clearInterval(checkpointTimer);
		clearInterval(optimizeTimer);
		clearInterval(reapFocusTimer);
		clearInterval(purgeTrashTimer);
		clearDaemonPort(stateDir);
		clearVehicleHandle(stateDir);
		releaseDaemonLock(lockPath);
		service.close();
		// .finally() re-throws rather than handling a rejection -- catching it first turns a bare
		// unhandled-rejection warning into a real, queryable shutdown-failure log line.
		void server
			.stop(true)
			.catch((error) => logEvent("error", "server_stop_failed", { message: error instanceof Error ? error.message : String(error) }))
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	logEvent("info", "listening", { host: DAEMON_HOST, port: server.port });
}
