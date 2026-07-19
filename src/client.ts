import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_PROBE_TIMEOUT_MS } from "./constants.ts";
import { daemonStateDir, readDaemonHandle } from "./daemon-state.ts";
import type { OperationName, SchemaState } from "./service.ts";

export type FetchAdapter = (request: Request) => Promise<Response>;

export class PapyrusClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly fetchAdapter: FetchAdapter = (request) => fetch(request),
		private readonly timeoutMs: number = DAEMON_CLIENT_TIMEOUT_MS,
	) {}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const request = new Request(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
				...init.headers,
			},
			signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
		});
		const response = await this.fetchAdapter(request);
		const body = await response.json() as { error?: string } & T;
		if (!response.ok) throw new Error(body.error ?? `Papyrus daemon HTTP ${response.status}`);
		return body;
	}

	health(): Promise<{ ok: true; version: string; schema: SchemaState }> {
		return this.request("/health");
	}

	async operations(): Promise<OperationName[]> {
		const body = await this.request<{ operations: OperationName[] }>("/api/v1/ops");
		return body.operations;
	}

	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		const body = await this.request<{ result: Output }>("/api/v1/ops", {
			method: "POST",
			body: JSON.stringify({ op: operation, input }),
		});
		return body.result;
	}
}

export async function connectPapyrusClient(dir: string = daemonStateDir()): Promise<PapyrusClient> {
	const handle = readDaemonHandle(dir);
	if (!handle) throw new Error("Papyrus daemon is not running; install/start papyrus.service");
	const probe = new PapyrusClient(handle.baseUrl, handle.token, (request) => fetch(request), DAEMON_PROBE_TIMEOUT_MS);
	try {
		await probe.health();
		return new PapyrusClient(handle.baseUrl, handle.token);
	} catch {
		throw new Error("Papyrus daemon state is stale or unreachable; restart papyrus.service");
	}
}
