import { createRetryingClient, type RetryingClient } from "@danypops/daemon-kit/pi-client";
import { connectPapyrusClient, type OperationName, type PapyrusClient } from "@danypops/papyrus";

type ClientConnector = () => Promise<PapyrusClient>;

let connector: ClientConnector = () => connectPapyrusClient();
const client: RetryingClient<PapyrusClient> = createRetryingClient<PapyrusClient>(() => connector(), { label: "Papyrus" });

export async function papyrusClient(): Promise<PapyrusClient> {
	return client.call(async (resolved) => resolved);
}

export async function callService<Input extends Record<string, unknown>, Output>(
	operation: OperationName,
	input: Input,
): Promise<Output> {
	return client.call((resolved) => resolved.call<Input, Output>(operation, input));
}

export function setPapyrusClientConnectorForTests(value: ClientConnector): void {
	connector = value;
	client.reset();
}

export function resetPapyrusClientForTests(): void {
	connector = () => connectPapyrusClient();
	client.reset();
}
