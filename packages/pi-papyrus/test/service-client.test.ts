/**
 * The real bug this retry policy fixes: the daemon binds a new random port
 * on every restart, but a client resolved once and cached for the rest of
 * the session would otherwise keep calling a dead port forever. These
 * exercise callService()'s retry-once-on-stale-connection behavior against
 * fake PapyrusClient-shaped objects (constructed directly, not a real
 * daemon) -- PapyrusClient's own request layer is already covered
 * elsewhere; this is specifically about the createRetryingClient seam.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { PapyrusClient } from "@danypops/papyrus";
import {
	callService,
	callServicePassive,
	papyrusClient,
	resetPapyrusClientForTests,
	setPapyrusClientConnectorForTests,
} from "../extension/src/service-client.ts";

afterEach(() => {
	resetPapyrusClientForTests();
});

function fakeConnectionRefused(): PapyrusClient {
	return {
		call: () => {
			throw new TypeError("fetch failed");
		},
	} as unknown as PapyrusClient;
}

function workingClient(result: unknown): PapyrusClient {
	return {
		call: () => Promise.resolve(result),
	} as unknown as PapyrusClient;
}

describe("papyrusClient", () => {
	it("resolves and reuses the same connected client across calls", async () => {
		let connectorCalls = 0;
		const client = workingClient({ ok: true });
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(client);
		});

		const first = await papyrusClient();
		const second = await papyrusClient();

		expect(first).toBe(client);
		expect(second).toBe(client);
		expect(connectorCalls).toBe(1);
	});
});

describe("callServicePassive", () => {
	it("attempts a missing daemon connection once instead of spending the startup retry budget", async () => {
		let connectorCalls = 0;
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.reject(new Error("daemon unavailable"));
		});

		await expect(callServicePassive("tasks.list", {})).rejects.toThrow("daemon unavailable");
		expect(connectorCalls).toBe(1);
	});
});

describe("callService recovers from a stale cached connection", () => {
	it("reconnects and retries once when the cached client's connection is stale, succeeding transparently", async () => {
		let connectorCalls = 0;
		const good = workingClient({ workspaceId: "abc" });
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(connectorCalls === 1 ? fakeConnectionRefused() : good);
		});

		const result = await callService("tasks.list", {});

		expect(result).toEqual({ workspaceId: "abc" });
		expect(connectorCalls).toBe(2);
	});

	it("gives up after one retry if the connection stays stale, rather than retrying forever", async () => {
		let connectorCalls = 0;
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(fakeConnectionRefused());
		});

		await expect(callService("tasks.list", {})).rejects.toThrow(TypeError);
		expect(connectorCalls).toBe(2);
	});

	it("does not retry a genuine domain-level error -- fails immediately rather than masking it", async () => {
		let connectorCalls = 0;
		const domainErrorClient: PapyrusClient = {
			call: () => {
				throw new Error('UnknownWorkspace: no workspace registered under id "x"');
			},
		} as unknown as PapyrusClient;
		setPapyrusClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(domainErrorClient);
		});

		await expect(callService("tasks.list", {})).rejects.toThrow(/UnknownWorkspace/);
		expect(connectorCalls).toBe(1);
	});
});
