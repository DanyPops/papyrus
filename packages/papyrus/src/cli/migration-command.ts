import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type MigrationClient = Pick<PapyrusClient, "call">;
type MigrationResult = { from: number; to: number; applied: string[] };

interface MigrationContext extends CommandContext {
	readonly client: MigrationClient;
	readonly json: boolean;
}

const schemaCommand = buildCommand({
	func: async function (this: MigrationContext) {
		const result = await this.client.call<Record<string, never>, MigrationResult>("system.migrate", {});
		if (this.json) {
			this.process.stdout.write(JSON.stringify(result));
			return;
		}
		this.process.stdout.write(
			result.applied.length === 0
				? `Schema already current at version ${result.to}.`
				: `Migrated schema ${result.from} → ${result.to}: ${result.applied.join(", ")}`,
		);
	},
	parameters: { flags: {} },
	docs: { brief: "Run any pending schema migrations" },
});

const app = buildApplication(buildRouteMap({ routes: { schema: schemaCommand }, docs: { brief: "Migration operations" } }), {
	name: "migrate",
	scanner: { caseStyle: "allow-kebab-for-camel" },
});

export async function runMigrationCli(args: string[], client: MigrationClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
