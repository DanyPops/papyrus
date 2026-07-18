import { DAEMON_HOST, DB_OPTIMIZE_INTERVAL_MS, WAL_CHECKPOINT_INTERVAL_MS, dbPath } from "./constants.ts";
import { clearDaemonPort, daemonStateDir, loadOrCreateToken, writeDaemonPort } from "./daemon-state.ts";
import { createApp, createPapyrusService } from "./service.ts";

/** Start the supervised, long-running Papyrus service. */
export function serveMain(): void {
	const stateDir = daemonStateDir();
	const token = loadOrCreateToken(stateDir);
	const service = createPapyrusService(dbPath());
	const app = createApp({ service, token });
	const server = Bun.serve({
		hostname: DAEMON_HOST,
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	if (!server.port) {
		service.close();
		throw new Error("Papyrus daemon failed to bind a listener");
	}
	writeDaemonPort(stateDir, server.port);
	const checkpointTimer = setInterval(() => {
		try { service.checkpoint(); } catch (error) { console.error("[papyrus] checkpoint failed", error); }
	}, WAL_CHECKPOINT_INTERVAL_MS);
	const optimizeTimer = setInterval(() => {
		try { service.optimize(); } catch (error) { console.error("[papyrus] optimize failed", error); }
	}, DB_OPTIMIZE_INTERVAL_MS);

	let stopping = false;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		clearInterval(checkpointTimer);
		clearInterval(optimizeTimer);
		clearDaemonPort(stateDir);
		service.close();
		void server.stop(true).finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	console.error(`[papyrus] listening on ${DAEMON_HOST}:${server.port}`);
}
