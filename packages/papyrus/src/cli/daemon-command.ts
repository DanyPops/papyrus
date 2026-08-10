import type { DaemonDiagnosis } from "@danypops/vehicle-server/daemon-lifecycle";
import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { runStricliToString } from "./stricli-run.ts";

export interface DaemonDiagnoseClient {
	diagnose(): Promise<DaemonDiagnosis>;
}

interface DaemonContext extends CommandContext {
	readonly client: DaemonDiagnoseClient;
	readonly json: boolean;
}

function renderHistoryLine(event: DaemonDiagnosis["history"][number]): string {
	const reason = event.reason ? ` (${event.reason})` : "";
	return `${event.at}  ${event.type}${reason}  pid=${event.pid} instance=${event.instanceId}`;
}

const diagnoseCommand = buildCommand({
	func: async function (this: DaemonContext) {
		const diagnosis = await this.client.diagnose();
		if (this.json) {
			this.process.stdout.write(JSON.stringify(diagnosis));
			return;
		}
		const lines = [
			`instance ${diagnosis.instanceId} (pid ${diagnosis.pid}, ${diagnosis.provenance}), started ${diagnosis.startedAt}`,
			"",
			"recent history:",
			...(diagnosis.history.length === 0 ? ["  (none)"] : diagnosis.history.map((event) => `  ${renderHistoryLine(event)}`)),
		];
		this.process.stdout.write(lines.join("\n"));
	},
	parameters: { flags: {} },
	docs: { brief: "Show this daemon's identity and recent start/stop/already_running history" },
});

const app = buildApplication(buildRouteMap({ routes: { diagnose: diagnoseCommand }, docs: { brief: "Daemon operations" } }), {
	name: "daemon",
	scanner: { caseStyle: "allow-kebab-for-camel" },
});

export async function runDaemonCli(args: string[], client: DaemonDiagnoseClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
