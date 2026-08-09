/**
 * Regression for a real, live bug: registerNotesVehicle(pi) built a bare
 * `new RemoteVehicleClient({baseUrl, token})` once at session_start and
 * captured it forever in every registered tool's closure. The Papyrus
 * daemon rebinds a new random port on every restart; that bare client had
 * no way to notice its baseUrl had died, so every Vehicle-projected tool
 * (tasks.*, docs.*, rules.*, playbooks.*, notes.*, artifact.*) failed with
 * a bare connection error for the rest of the Pi session until the whole
 * extension reloaded.
 *
 * Fixed by wrapping the client in createReconnectingVehicleClient(),
 * re-resolving currentVehicleClientTarget() (this test's own injected
 * resolver) on every reconnect attempt instead of once. This test proves
 * the fix end to end: register against a real server, invoke successfully,
 * kill that server and start a genuinely new one on a new port (updating
 * the injected resolver, exactly like a real restart rewrites the handle
 * file), then invoke the SAME already-registered tool again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { PapyrusClient } from "@danypops/papyrus";
import { bindVehicleOperation, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerPapyrus from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";
import { waitFor } from "./support/wait-for.ts";

/**
 * session_start also calls callService("session.register", ...) through the OLD action-dispatch
 * path (see index.ts), unrelated to the Vehicle target this test overrides below -- left
 * unmocked, it hits the real connectPapyrusClient() and auto-spawns a real daemon subprocess
 * against this machine's real, ambient daemonStateDir(). See vehicle-notes-session-start.test.ts
 * for the same fix and its full rationale.
 */
function fakeSessionRegisterClient(): PapyrusClient {
	return {
		call: () => Promise.resolve({ sessionId: "session-a", secret: "test-secret" }),
	} as unknown as PapyrusClient;
}

const passthroughSchema = defineVehicleSchema<Record<string, unknown>>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
});

const LIMITS = { defaultTimeoutMs: 2_000, maxTimeoutMs: 5_000, maxRequestBytes: 4_096, maxResponseBytes: 4_096 } as const;

const Ping = defineVehicleOperation({
	name: "test.ping",
	version: 1,
	description: "Returns a counter bumped on every call, so a test can tell which server instance actually answered.",
	input: passthroughSchema,
	output: passthroughSchema,
	permissions: [],
	effect: "read",
	idempotency: { mode: "safe" },
	limits: LIMITS,
});

function startServer(instanceLabel: string): { baseUrl: string; stop: () => void } {
	const registry = new VehicleRegistry({ name: "test-vehicle", version: "1.0.0", description: "Test Vehicle" });
	registry.register(
		"test-owner",
		bindVehicleOperation(Ping, () => async () => ({ answeredBy: instanceLabel })),
	);
	const app = createVehicleHttpApp({ registry, token: "test-token" });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("registerNotesVehicle survives a daemon restart without a Pi extension reload", () => {
	afterEach(() => {
		resetVehicleClientTargetResolverForTests();
		resetPapyrusClientForTests();
	});

	it("a tool registered against the original daemon keeps working after it restarts on a new port", async () => {
		let current = startServer("first");
		let resolvedBaseUrl = current.baseUrl;
		setVehicleClientTargetResolverForTests(() => ({ baseUrl: resolvedBaseUrl, token: "test-token" }));
		setPapyrusClientConnectorForTests(() => Promise.resolve(fakeSessionRegisterClient()));

		const registeredTools = new Map<string, ToolDefinition<never, never>>();
		const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
		const api = {
			registerTool(tool: ToolDefinition<never, never>) {
				registeredTools.set(tool.name, tool);
			},
			registerCommand() {},
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				if (event === "session_start") sessionStartHandlers.push(handler);
			},
			getAllTools() {
				return [...registeredTools.values()];
			},
			getActiveTools() {
				return [...registeredTools.keys()];
			},
			setActiveTools() {},
			events: { emit() {} },
		} as unknown as ExtensionAPI;

		await registerPapyrus(api);
		const ctx = { hasUI: false, cwd: "/workspace/papyrus", sessionManager: { getSessionId: () => "session-a" } };
		for (const handler of sessionStartHandlers) await handler(undefined, ctx);

		// session_start firing only starts the fire-and-forget resolve+register sequence (see
		// registerVehicleToolsWhenReady) -- poll for the tool actually landing in the registry.
		await waitFor(() => registeredTools.has("test_ping"));
		const tool = registeredTools.get("test_ping");
		expect(tool).toBeDefined();

		const execute = tool!.execute as unknown as (
			toolCallId: string,
			input: unknown,
			signal: AbortSignal,
			onUpdate: undefined,
			context: unknown,
		) => Promise<{ details?: { output?: unknown } }>;
		const toolContext = { sessionManager: { getSessionId: () => "session-a" } };

		// First call succeeds against the original daemon.
		const first = await execute("call-1", {}, new AbortController().signal, undefined, toolContext);
		expect(first.details?.output).toEqual({ answeredBy: "first" });

		// Simulate a real restart: the old process is gone, a new one binds a new random port.
		// The injected resolver stands in for the handle file being rewritten.
		current.stop();
		current = startServer("second");
		resolvedBaseUrl = current.baseUrl;

		// No sacrificial failed call, no reload, no re-registration: pre-dispatch identity
		// resolution sees the rewritten handle's new base URL, discards the old cached client,
		// and the SAME tool object's first post-restart invocation reaches the new daemon.
		const second = await execute("call-2", {}, new AbortController().signal, undefined, toolContext);
		expect(second.details?.output).toEqual({ answeredBy: "second" });

		current.stop();
	});
});
