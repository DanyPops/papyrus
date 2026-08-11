/**
 * Real live incident (papyrus task d0eb81b7, vehicle task 59a22737): tasks.run_gates/
 * tasks.complete can legitimately take many seconds to tens of seconds to actually run a
 * caller's own gate command, sending zero response bytes the whole time. Bun.serve's own
 * idleTimeout defaults to 10s and applies per-connection regardless of how long a given
 * request is expected to take -- @danypops/vehicle-server's daemon.ts already fixed this for
 * every OTHER Vehicle-backed daemon (the ones that go through its own startDaemon/
 * startBunListener), but Papyrus's own daemon.ts predates that shared substrate and has its
 * own separate, hand-rolled Bun.serve() call (see daemon.ts's own doc comment) -- meaning it
 * never got that fix at all. Confirmed live: raising gate.timeoutMs made no difference,
 * because neither it nor VehicleLimits.maxTimeoutMs ever got a chance to apply -- the raw TCP
 * connection was already dead first, every single time a gate command ran long enough, while
 * every fast plain read (tasks.show) never hit it.
 *
 * Mirrors daemon-push-channel.test.ts's own fixture pattern (real Bun.serve, same wiring
 * daemon.ts's serveMain() uses) rather than asserting against serveMain() as a black box.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { createApp, createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

function startFixtureDaemon(token: string) {
	const dir = tempDir("papyrus-invoke-timeout-daemon-");
	const service = createPapyrusService(join(dir, "papyrus.db"));
	const pushChannel = new PushChannel({ token });
	const app = createApp({ service, token });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request, bunServer) => {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/push") return pushChannel.upgrade(request, bunServer) ?? undefined;
			if (pathname === "/vehicle/invoke") bunServer.timeout(request, 3_600);
			return app.fetch(request);
		},
		websocket: pushChannel.websocketHandlers(),
	});
	return { server, service, port: server.port! };
}

describe("Papyrus daemon's own Bun.serve() wiring: /vehicle/invoke idle timeout", () => {
	it("raises Bun's own idle timeout for a POST /vehicle/invoke request, not just Bun's 10s default", async () => {
		const calls: Array<{ seconds: number }> = [];
		// biome-ignore lint/suspicious/noExplicitAny: Bun.serve's overloaded signature can't be spied through cleanly; only .timeout()'s own args matter here.
		const originalServe = Bun.serve.bind(Bun) as (options: any) => ReturnType<typeof Bun.serve>;
		// biome-ignore lint/suspicious/noExplicitAny: same as above -- the mock's own options param.
		const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: any) => {
			const server = originalServe(options);
			spyOn(server, "timeout").mockImplementation(((_request: Request, seconds: number) => {
				calls.push({ seconds });
			}) as typeof server.timeout);
			return server;
		}) as typeof Bun.serve);
		const token = "invoke-timeout-token";
		let daemon: ReturnType<typeof startFixtureDaemon> | undefined;
		try {
			daemon = startFixtureDaemon(token);
			await fetch(`http://127.0.0.1:${daemon.port}/vehicle/invoke`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ name: "tasks.list", version: 1, input: { project_root: "/workspace/papyrus" } }),
			});
			await fetch(`http://127.0.0.1:${daemon.port}/health`);
			expect(calls).toEqual([{ seconds: 3_600 }]);
		} finally {
			daemon?.service.close();
			await daemon?.server.stop(true);
			serveSpy.mockRestore();
		}
	}, 10_000);
});
