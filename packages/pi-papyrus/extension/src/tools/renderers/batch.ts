import { BATCH_MAX_ITEMS } from "@danypops/papyrus";

/** Summarizes validated batch outcomes without copying nested results or error payloads. */
export function batchOutcomeSummary(output: unknown): string | undefined {
	if (typeof output !== "object" || output === null || !("results" in output)) return undefined;
	const results = output.results;
	if (!Array.isArray(results) || results.length === 0 || results.length > BATCH_MAX_ITEMS) return undefined;
	const statuses: boolean[] = [];
	for (const item of results) {
		if (typeof item !== "object" || item === null) return undefined;
		if (item.ok === true && "result" in item) statuses.push(true);
		else if (item.ok === false && typeof item.error === "string") statuses.push(false);
		else return undefined;
	}
	const succeeded = statuses.filter(Boolean).length;
	return [
		`Batch: ${succeeded} succeeded, ${statuses.length - succeeded} failed`,
		...statuses.map((ok, index) => `${index + 1}: ${ok ? "succeeded" : "failed"}`),
	].join("\n");
}
