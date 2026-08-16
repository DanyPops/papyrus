import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type BatchClient = Pick<PapyrusClient, "call">;
type BatchItemResult = { ok: true; result: unknown } | { ok: false; error: string };
type BatchResult = { results: BatchItemResult[] };

interface BatchContext extends CommandContext {
	readonly client: BatchClient;
	readonly json: boolean;
}

/** No further shape assertion here -- the service validates each item's own {op, input} shape;
 * this only needs a real JSON array to hand off. */
function parseItems(value: string): unknown[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) throw new Error("--items-json must be a JSON array");
	return parsed;
}

const runCommand = buildCommand({
	func: async function (this: BatchContext, flags: { itemsJson: unknown[] }) {
		const result = await this.client.call<Record<string, unknown>, BatchResult>("batch.execute", { items: flags.itemsJson });
		if (this.json) {
			this.process.stdout.write(JSON.stringify(result));
			return;
		}
		const lines = result.results.map((entry, index) =>
			entry.ok ? `[${index}] ok: ${JSON.stringify(entry.result)}` : `[${index}] failed: ${entry.error}`,
		);
		this.process.stdout.write(lines.join("\n"));
	},
	parameters: {
		flags: {
			itemsJson: {
				brief: 'JSON array of {"op": "<operation>", "input": {...}} entries -- each fans out exactly like a direct call to that operation',
				kind: "parsed",
				parse: parseItems,
				placeholder: "json",
			},
		},
	},
	docs: { brief: "Fan out N independent operations in one call, so N artifact mutations don't need N separate round-trips" },
});

const app = buildApplication(runCommand, { name: "batch", scanner: { caseStyle: "allow-kebab-for-camel" } });

export async function runBatchCli(args: string[], client: BatchClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
