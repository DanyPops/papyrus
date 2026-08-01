/**
 * Exercises the same PushChannel wiring serveMain() uses (real Bun.serve, real
 * WebSocket upgrade, real task mutation through the HTTP operation endpoint) --
 * serveMain() itself isn't unit-testable (it reads real env/dbPath as a process
 * composition root), so this rebuilds the identical wiring pattern against a
 * throwaway service instead of asserting against serveMain() as a black box.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { createApp, createPapyrusService } from "../src/service.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

const PROJECT_ROOT = "/workspace/papyrus";
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

function startFixtureDaemon(token: string) {
	const dir = tempDir("papyrus-push-daemon-");
	const service = createPapyrusService(join(dir, "papyrus.db"));
	const pushChannel = new PushChannel({ token });
	const app = createApp({
		service,
		token,
		onOperationExecuted: (operation) => {
			if (operation.startsWith("tasks.") && !TASK_READ_ONLY_OPERATIONS.has(operation)) {
				pushChannel.publish("tasks", { operation });
			}
		},
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request, bunServer) => {
			if (new URL(request.url).pathname === "/push") return pushChannel.upgrade(request, bunServer) ?? undefined;
			return app.fetch(request);
		},
		websocket: pushChannel.websocketHandlers(),
	});
	return { server, service, port: server.port! };
}

function waitForMessage(ws: WebSocket): Promise<{ topic: string; payload: unknown }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for a push message")), 5_000);
		ws.addEventListener(
			"message",
			(event) => {
				clearTimeout(timeout);
				resolve(JSON.parse(String(event.data)));
			},
			{ once: true },
		);
	});
}

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for the socket to open")), 5_000);
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

async function call(port: number, token: string, op: string, input: Record<string, unknown>): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${port}/api/v1/ops`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ op, input }),
	});
	const body = (await response.json()) as { result?: unknown; error?: string };
	if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
	return body.result;
}

describe("daemon PushChannel wiring, end to end", () => {
	it("a real mutating tasks.* operation publishes to a subscribed WebSocket", async () => {
		const token = "push-e2e-token";
		const { server, service, port } = startFixtureDaemon(token);
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/push?token=${token}`);
			await waitForOpen(ws);
			ws.send(JSON.stringify({ op: "subscribe", topic: "tasks" }));

			const pushed = waitForMessage(ws);
			const created = (await call(port, token, "tasks.create", { title: "Push me", project_root: PROJECT_ROOT })) as { id: string };
			const message = await pushed;
			expect(message).toEqual({ topic: "tasks", payload: { operation: "tasks.create" } });

			// A read-only operation must not trigger a second push.
			let sawSecondMessage = false;
			ws.addEventListener("message", () => {
				sawSecondMessage = true;
			});
			await call(port, token, "tasks.show", { id: created.id });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(sawSecondMessage).toBe(false);

			ws.close();
		} finally {
			service.close();
			await server.stop(true);
		}
	});

	it("an unauthenticated upgrade attempt is rejected", async () => {
		const token = "push-e2e-token-2";
		const { server, service, port } = startFixtureDaemon(token);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/push?token=wrong`, {
				headers: { upgrade: "websocket", connection: "upgrade" },
			});
			expect(response.status).toBe(401);
		} finally {
			service.close();
			await server.stop(true);
		}
	});
});
