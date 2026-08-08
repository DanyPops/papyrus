/**
 * Confirms the real, live token-bloat concern this exists for: with dozens of manifest
 * operations, registerNotesVehicle must NOT activate every single one from turn one --
 * only its core set plus the two Vehicle Shell meta-tools (tools_list, tools_man). See
 * @danypops/vehicle-client-pi's vehicle-shell.ts for the underlying decaying-TTL mechanism;
 * this test only proves pi-papyrus actually opted in and wired a sane core set, not the
 * mechanism itself (already covered upstream).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { PapyrusClient } from "@danypops/papyrus";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerPapyrus from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";
import { waitFor } from "./support/wait-for.ts";

function fakeSessionRegisterClient(): PapyrusClient {
	return { call: () => Promise.resolve({ sessionId: "session-a", secret: "test-secret" }) } as unknown as PapyrusClient;
}

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

/** A realistically-sized manifest (mirrors the real live count that motivated this feature: dozens
 * of operations across several domains) -- large enough that "activate everything" vs. "activate
 * only the core set" is a meaningfully different, assertable outcome. */
function realisticManifestOperations() {
	const names = [
		"tasks.list",
		"tasks.create",
		"tasks.start",
		"tasks.submit",
		"tasks.complete",
		"tasks.context",
		"tasks.depend",
		"tasks.undepend",
		"tasks.contain",
		"tasks.uncontain",
		"tasks.graph",
		"tasks.plan",
		"docs.list",
		"docs.create",
		"docs.archive",
		"docs.reopen",
		"docs.link",
		"rules.list",
		"rules.create",
		"rules.enable",
		"rules.disable",
		"playbooks.list",
		"playbooks.create",
		"playbooks.invoke",
		"notes.capture",
		"notes.list",
		"discuss.open",
		"discuss.reply",
		"artifact.query",
	];
	return names.map((name) => ({
		name,
		version: 1,
		description: `Run ${name}.`,
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		available: true,
	}));
}

function manifestServer(): { baseUrl: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/vehicle/manifest") {
				return Response.json({ name: "papyrus", version: "1.0.0", description: "Papyrus.", operations: realisticManifestOperations() });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("registerNotesVehicle opts into Vehicle Shell activation", () => {
	afterEach(() => {
		resetVehicleClientTargetResolverForTests();
		resetPapyrusClientForTests();
	});

	it("activates only the core operations plus tools_list/tools_man -- not all 29 registered operations", async () => {
		const { baseUrl, stop } = manifestServer();
		try {
			setVehicleClientTargetResolverForTests(() => ({ baseUrl, token: "test-token" }));
			setPapyrusClientConnectorForTests(() => Promise.resolve(fakeSessionRegisterClient()));

			const registeredTools: ToolDefinition[] = [];
			let activeTools: string[] = [];
			const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
			const api = {
				registerTool(tool: ToolDefinition) {
					registeredTools.push(tool);
				},
				registerCommand() {},
				on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
					if (event === "session_start") sessionStartHandlers.push(handler);
				},
				getAllTools: () => registeredTools.map((tool) => ({ name: tool.name })),
				getActiveTools: () => activeTools,
				setActiveTools: (names: string[]) => {
					activeTools = names;
				},
				events: { emit() {} },
			} as unknown as ExtensionAPI;

			await registerPapyrus(api);
			const ctx = { hasUI: false, cwd: "/workspace/papyrus", sessionManager: { getSessionId: () => "session-a" } };
			for (const handler of sessionStartHandlers) await handler(undefined, ctx);

			// session_start firing only starts the fire-and-forget resolve+register sequence (see
			// registerVehicleToolsWhenReady) -- poll for real registrations to land before asserting.
			await waitFor(() => registeredTools.length >= 29 + 2);

			// Every operation is still registered (reachable via tools_man)...
			expect(registeredTools.length).toBeGreaterThanOrEqual(29 + 2);
			// ...but only a small subset is actually active from turn one.
			expect(activeTools).toContain("tools_list");
			expect(activeTools).toContain("tools_man");
			expect(activeTools).toContain("tasks_create");
			expect(activeTools.length).toBeLessThan(registeredTools.length / 2);

			// tools_list really does describe the inactive ones -- proving they're reachable, not lost.
			const list = registeredTools.find((tool) => tool.name === "tools_list");
			expect(list).toBeDefined();
			const listResult = (await list!.execute(
				"call-1",
				{ query: "docs.archive" } as never,
				undefined as never,
				undefined as never,
				ctx as never,
			)) as {
				content: Array<{ text: string }>;
			};
			expect(listResult.content[0]?.text).toContain("docs.archive");
			expect(activeTools).not.toContain("docs_archive");
		} finally {
			stop();
		}
	});
});
