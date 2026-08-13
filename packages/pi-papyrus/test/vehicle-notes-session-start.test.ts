/**
 * Regression for a real, live bug: registerNotesVehicle(pi) -> registerVehicleTools()
 * needs pi.getAllTools()/getActiveTools()/setActiveTools(), which throw "Extension
 * runtime not initialized" when called directly from an extension's top-level
 * factory body (Pi's runtime only finishes initializing after every extension's
 * factory has resolved). Confirmed live, independently, in the identical pi-tickets
 * bug first.
 *
 * registerNotesVehicle now defers via registerVehicleToolsWhenReady, which registers
 * its own session_start handler internally and kicks off resolve+register fire-and-
 * forget (not awaited) once that event fires -- so a real assertion here must poll
 * for the eventual result rather than assume it lands within one microtask of
 * invoking the captured handler.
 *
 * This spins up a real HTTP server answering /vehicle/manifest (empty operations is
 * enough -- registerVehicleTools() calls pi.getAllTools()/getActiveTools()/
 * setActiveTools() unconditionally right after fetching any manifest, regardless of
 * operation count) so registerNotesVehicle actually reaches those calls instead of
 * no-op'ing on an unresolved target.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PapyrusClient } from "@danypops/papyrus";
import { __resetInProcessVehicleRegistryForTests, __resetVehicleShellHandleForTests } from "@danypops/vehicle-client-pi/test-utils";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPapyrus from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";
import { waitFor } from "./support/wait-for.ts";

/**
 * session_start also calls callService("session.register", ...) (see index.ts) through the
 * OLD action-dispatch path, not Vehicle -- unlike setVehicleClientTargetResolverForTests, that
 * path defaults to the real connectPapyrusClient(), which auto-spawns a real daemon subprocess
 * against this machine's real, ambient daemonStateDir() when nothing else is running. That real
 * spawn+poll is exactly what every other test file touching callService() already avoids via
 * this same override (see service-client.test.ts, task-widget.test.ts, etc.) -- confirmed live:
 * omitting it here let this test's timing depend on whether a real Papyrus daemon happened to
 * already be running on the machine running it, passing in under 150ms locally (a real daemon
 * usually is) while a machine with none hits the real autostart poll instead.
 */
function fakeSessionRegisterClient(): PapyrusClient {
	return {
		call: () => Promise.resolve({ sessionId: "session-a", secret: "test-secret" }),
	} as unknown as PapyrusClient;
}

function emptyManifestServer(): { baseUrl: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/vehicle/manifest") {
				return Response.json({ operations: [] });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("registerNotesVehicle is deferred to session_start, not called from the top-level factory body", () => {
	// See vehicle-shell-activation.test.ts's own identical beforeEach for why this is needed.
	beforeEach(() => {
		__resetVehicleShellHandleForTests();
		__resetInProcessVehicleRegistryForTests();
	});

	afterEach(() => {
		resetVehicleClientTargetResolverForTests();
		resetPapyrusClientForTests();
	});

	it("never touches pi.getAllTools/getActiveTools/setActiveTools until a session_start handler actually fires", async () => {
		const { baseUrl, stop } = emptyManifestServer();
		try {
			setVehicleClientTargetResolverForTests(() => ({ baseUrl, token: "test-token" }));
			setPapyrusClientConnectorForTests(() => Promise.resolve(fakeSessionRegisterClient()));

			let actionMethodCalls = 0;
			const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
			const api = {
				registerTool() {},
				registerCommand() {},
				on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
					if (event === "session_start") sessionStartHandlers.push(handler);
				},
				getAllTools() {
					actionMethodCalls++;
					return [];
				},
				getActiveTools() {
					actionMethodCalls++;
					return [];
				},
				setActiveTools() {
					actionMethodCalls++;
				},
				events: { emit() {} },
			} as unknown as ExtensionAPI;

			await registerPapyrus(api);

			// The top-level factory body itself must never reach registerNotesVehicle's
			// pi.getAllTools()/getActiveTools()/setActiveTools() calls -- if it did, this
			// would be the exact "Extension runtime not initialized" condition in a real
			// Pi session (silently swallowed by registerNotesVehicle's own try/catch here,
			// which is exactly why a call counter -- not "did it throw" -- is the only
			// reliable external signal).
			expect(actionMethodCalls).toBe(0);
			expect(sessionStartHandlers.length).toBeGreaterThanOrEqual(1);

			const ctx = {
				hasUI: false,
				cwd: "/workspace/papyrus",
				sessionManager: { getSessionId: () => "session-a" },
				ui: { notify() {} },
			};
			for (const handler of sessionStartHandlers) await handler(undefined, ctx);

			// session_start firing only starts the fire-and-forget resolve+register sequence --
			// poll for it actually reaching the real Vehicle registration calls instead of
			// assuming it lands synchronously.
			await waitFor(() => actionMethodCalls > 0);
			expect(actionMethodCalls).toBeGreaterThan(0);
		} finally {
			stop();
		}
	});
});
