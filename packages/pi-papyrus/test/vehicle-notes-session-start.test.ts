/**
 * Regression for a real, live bug: registerNotesVehicle(pi) -> registerVehicleTools()
 * needs pi.getAllTools()/getActiveTools()/setActiveTools(), which throw "Extension
 * runtime not initialized" when called directly from an extension's top-level
 * factory body (Pi's runtime only finishes initializing after every extension's
 * factory has resolved). That error was silently swallowed by registerNotesVehicle's
 * own daemon-unreachable try/catch -- every notes.* tool was registered and "active"
 * by its own bookkeeping but never actually reached Pi's tool registry, invisible to
 * the model with zero visible sign why. Confirmed live, independently, in the
 * identical pi-tickets bug first.
 *
 * This spins up a real HTTP server answering /vehicle/manifest (empty operations is
 * enough -- registerVehicleTools() calls pi.getAllTools()/getActiveTools()/
 * setActiveTools() unconditionally right after fetching any manifest, regardless of
 * operation count) so registerNotesVehicle actually reaches those calls instead of
 * no-op'ing on an unresolved target.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPapyrus from "../extension/src/index.ts";
import { resetVehicleClientTargetResolverForTests, setVehicleClientTargetResolverForTests } from "../extension/src/service-client.ts";

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
	afterEach(() => {
		resetVehicleClientTargetResolverForTests();
	});

	it("never touches pi.getAllTools/getActiveTools/setActiveTools until a session_start handler actually fires", async () => {
		const { baseUrl, stop } = emptyManifestServer();
		try {
			setVehicleClientTargetResolverForTests(() => ({ baseUrl, token: "test-token" }));

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
			};
			for (const handler of sessionStartHandlers) await handler(undefined, ctx);

			// Now that session_start has actually fired, registerNotesVehicle must have run
			// and reached the real Vehicle registration calls.
			expect(actionMethodCalls).toBeGreaterThan(0);
		} finally {
			stop();
		}
	});
});
