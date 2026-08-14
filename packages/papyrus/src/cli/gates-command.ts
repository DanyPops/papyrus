import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { GateResult } from "../gate/gate.ts";
import { runStricliToString } from "./stricli-run.ts";

type GatesClient = Pick<PapyrusClient, "call">;

interface GatesContext extends CommandContext {
	readonly client: GatesClient;
	readonly json: boolean;
}

const runGateCommand = buildCommand({
	func: async function (this: GatesContext, _flags: Record<string, never>, id: string) {
		const results = await this.client.call<Record<string, unknown>, GateResult[]>("gates.run", { id });
		if (this.json) {
			this.process.stdout.write(JSON.stringify(results));
			return;
		}
		this.process.stdout.write(
			results.length === 0
				? "No gates configured."
				: results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n"),
		);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [{ brief: "Artifact id to run gates against", parse: String, placeholder: "id" }],
		},
	},
	docs: { brief: "Run every gate configured on an artifact" },
});

const app = buildApplication(buildRouteMap({ routes: { run: runGateCommand }, docs: { brief: "Gate operations" } }), {
	name: "gates",
	scanner: { caseStyle: "allow-kebab-for-camel" },
});

export async function runGatesCli(args: string[], client: GatesClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
