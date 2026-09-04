import { afterEach, describe, expect, it } from "bun:test";
import { CONTEXT_HUB_CONTRIBUTION_CHANNEL } from "@danypops/jittor";
import type { PapyrusClient } from "@danypops/papyrus";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import registerPapyrus, { NoteOverlay, PAPYRUS_CONTEXT_INJECTION_DEADLINE_MS } from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";

afterEach(() => {
	resetPapyrusClientForTests();
	resetVehicleClientTargetResolverForTests();
});

describe("pi-papyrus startup", () => {
	it("registers interactive commands synchronously while their TUI modules remain on demand", () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		const harness = createExtensionHarness(registerPapyrus);

		expect(harness.commands).toEqual(
			expect.arrayContaining(["tasks", "docs", "note", "notes", "rules", "playbooks", "playbook", "discuss"]),
		);
	});

	it("does not hold session_start behind passive daemon connection work", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));
		const harness = createExtensionHarness(registerPapyrus);

		const outcome = await Promise.race([
			harness.boot().then(() => "started" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
		]);

		expect(outcome).toBe("started");
		await harness.shutdown();
	});

	it("does not hold prompt submission behind task-resume daemon work", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));
		const harness = createExtensionHarness(registerPapyrus);
		await harness.boot();

		const outcome = await Promise.race([
			harness.emit("input", { source: "interactive", text: "continue" }).then(() => "submitted" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
		]);

		expect(outcome).toBe("submitted");
		await harness.shutdown();
	});

	it("fails fast instead of spending daemon-restart backoff before provider dispatch", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));
		const harness = createExtensionHarness(registerPapyrus);
		await harness.boot();

		let connectorCalls = 0;
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.reject(new Error("daemon is running a newer version"));
		});
		const startedAt = performance.now();
		const result = await harness.emit("before_agent_start", {
			prompt: "continue",
			systemPrompt: "base",
			systemPromptOptions: { selectedTools: [] },
		});

		expect(performance.now() - startedAt).toBeLessThan(100);
		expect(connectorCalls).toBe(1);
		expect(result).toBeUndefined();
		await harness.shutdown();
	});

	it("bounds a hung context-injection connection before provider dispatch", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));
		const harness = createExtensionHarness(registerPapyrus);
		await harness.boot();
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));

		const startedAt = performance.now();
		const outcome = await Promise.race([
			harness
				.emit("before_agent_start", {
					prompt: "continue",
					systemPrompt: "base",
					systemPromptOptions: { selectedTools: [] },
				})
				.then(() => "released" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), PAPYRUS_CONTEXT_INJECTION_DEADLINE_MS + 500)),
		]);

		expect(outcome).toBe("released");
		expect(performance.now() - startedAt).toBeLessThan(PAPYRUS_CONTEXT_INJECTION_DEADLINE_MS + 250);
		await harness.shutdown();
	});

	it("reuses the latest complete bounded context when a later daemon probe fails", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		const client = {
			call: async (operation: string) => {
				switch (operation) {
					case "session.register":
						return { sessionId: "harness-session", secret: "secret" };
					case "rules.injectable":
						return [{ id: "rule-cache", title: "Cached rule", body: "cached rule marker", extra: {} }];
					case "playbooks.list":
						return [{ title: "Cached playbook marker", extra: { trigger: "cached trigger" } }];
					case "tasks.context":
						return "cached task summary marker";
					case "tasks.graph":
						return {
							nodes: [
								{
									task: { id: "task-cache", status: "todo", title: "cached graph marker", body: "graph body" },
									parentIds: [],
									childIds: [],
									dependencyIds: [],
								},
							],
							rootIds: ["task-cache"],
						};
					default:
						return undefined;
				}
			},
		} as unknown as PapyrusClient;
		setPapyrusClientConnectorForTests(() => Promise.resolve(client));
		const harness = createExtensionHarness(registerPapyrus);
		const contributions: unknown[] = [];
		harness.api.events.on(CONTEXT_HUB_CONTRIBUTION_CHANNEL, (payload) => contributions.push(payload));
		await harness.boot();

		const payload = {
			prompt: "continue",
			systemPrompt: "base",
			systemPromptOptions: { selectedTools: [] },
		};
		const live = await harness.emit<{ systemPrompt: string }>("before_agent_start", payload);
		expect(live?.systemPrompt).toContain("cached rule marker");
		expect(live?.systemPrompt).toContain("Cached playbook marker");
		expect(live?.systemPrompt).toContain("cached task summary marker");
		expect(JSON.stringify(contributions.at(-1))).toContain("cached graph marker");

		let connectorCalls = 0;
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.reject(new Error("daemon unavailable"));
		});
		const startedAt = performance.now();
		const cached = await harness.emit<{ systemPrompt: string }>("before_agent_start", payload);

		expect(performance.now() - startedAt).toBeLessThan(100);
		expect(connectorCalls).toBe(1);
		expect(cached).toEqual(live);
		expect(JSON.stringify(contributions.at(-1))).toContain("cached graph marker");
		await harness.shutdown();
	});

	it("ignores a deferred widget result after the overlay is disposed", async () => {
		let resolveRows!: (rows: unknown[]) => void;
		const deferredRows = new Promise<unknown[]>((resolve) => {
			resolveRows = resolve;
		});
		setPapyrusClientConnectorForTests(() => Promise.resolve({ call: () => deferredRows } as unknown as PapyrusClient));
		const overlay = new NoteOverlay();
		overlay.setProjectRoot("/workspace");

		const refresh = overlay.refresh();
		overlay.dispose();
		resolveRows([
			{
				id: "note-1",
				title: "stale note",
			},
		]);
		await refresh;

		expect(overlay.hasOpenNotes()).toBe(false);
	});
});
