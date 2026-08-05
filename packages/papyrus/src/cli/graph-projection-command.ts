import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, run } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";

type GraphProjectionClient = Pick<PapyrusClient, "call">;

interface GraphProjectionContext extends CommandContext {
	readonly client: GraphProjectionClient;
	readonly json: boolean;
}

function parseBatchJson(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--batch-json must be a JSON object");
	return parsed as Record<string, unknown>;
}

const applyCommand = buildCommand({
	func: async function (this: GraphProjectionContext, flags: { batchJson: Record<string, unknown> }) {
		const result = await this.client.call<Record<string, unknown>, unknown>("graph_projection.apply", flags.batchJson);
		this.process.stdout.write(this.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
	},
	parameters: {
		flags: {
			batchJson: {
				brief: "JSON-encoded projection batch to apply",
				kind: "parsed",
				parse: parseBatchJson,
				placeholder: "json",
			},
		},
	},
	docs: {
		brief: "Apply a projection batch",
	},
});

const checkpointCommand = buildCommand({
	func: async function (this: GraphProjectionContext, flags: { producerId: string }) {
		const result = await this.client.call<Record<string, unknown>, unknown>("graph_projection.checkpoint", {
			producer_id: flags.producerId,
		});
		if (this.json) {
			this.process.stdout.write(JSON.stringify(result));
			return;
		}
		this.process.stdout.write(
			result === null ? `No projection checkpoint for producer "${flags.producerId}".` : JSON.stringify(result, null, 2),
		);
	},
	parameters: {
		flags: {
			producerId: {
				brief: "Producer id to look up the checkpoint for",
				kind: "parsed",
				parse: String,
				placeholder: "id",
			},
		},
	},
	docs: {
		brief: "Look up a producer's projection checkpoint",
	},
});

const app = buildApplication(
	buildRouteMap({
		routes: { apply: applyCommand, checkpoint: checkpointCommand },
		docs: { brief: "Graph projection operations" },
	}),
	{ name: "graph-projection", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

/** Same (args, client) => Promise<string> contract as every other run*Cli export -- test/cli-parity.test.ts depends on it. */
export async function runGraphProjectionCli(args: string[], client: GraphProjectionClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	const chunks: string[] = [];
	const errors: string[] = [];
	const fakeProcess: {
		stdout: { write: (text: string) => void };
		stderr: { write: (text: string) => void };
		exitCode?: number | string | null;
	} = {
		stdout: { write: (text: string) => chunks.push(text) },
		stderr: { write: (text: string) => errors.push(text) },
	};
	await run(app, positional, { client, json, process: fakeProcess });
	if (fakeProcess.exitCode)
		throw new Error(errors.join("").trim() || `graph-projection command failed with exit code ${fakeProcess.exitCode}`);
	return chunks.join("");
}
