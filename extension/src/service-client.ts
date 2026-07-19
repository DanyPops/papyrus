import { connectPapyrusClient, type PapyrusClient } from "../../src/client.ts";
import type { OperationName } from "../../src/service.ts";

type ClientConnector = () => Promise<PapyrusClient>;

let connector: ClientConnector = () => connectPapyrusClient();
let cached: PapyrusClient | undefined;

export async function papyrusClient(): Promise<PapyrusClient> {
	if (cached) return cached;
	cached = await connector();
	return cached;
}

function staleConnection(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|connection refused/i.test(error.message);
}

export async function callService<Input extends Record<string, unknown>, Output>(
	operation: OperationName,
	input: Input,
): Promise<Output> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			return await (await papyrusClient()).call<Input, Output>(operation, input);
		} catch (error) {
			cached = undefined;
			if (attempt === 1 || !staleConnection(error)) throw error;
		}
	}
	throw new Error("Papyrus daemon client retry exhausted");
}

export function setPapyrusClientConnectorForTests(value: ClientConnector): void {
	cached = undefined;
	connector = value;
}

export function resetPapyrusClientForTests(): void {
	cached = undefined;
	connector = () => connectPapyrusClient();
}
