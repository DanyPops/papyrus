import { connectPapyrusClient, type PapyrusClient } from "../../src/client.ts";
import type { OperationName } from "../../src/service.ts";

let cached: PapyrusClient | undefined;

export async function papyrusClient(): Promise<PapyrusClient> {
	if (cached) return cached;
	cached = await connectPapyrusClient();
	return cached;
}

export async function callService<Input extends Record<string, unknown>, Output>(
	operation: OperationName,
	input: Input,
): Promise<Output> {
	try {
		return await (await papyrusClient()).call<Input, Output>(operation, input);
	} catch (error) {
		cached = undefined;
		throw error;
	}
}
