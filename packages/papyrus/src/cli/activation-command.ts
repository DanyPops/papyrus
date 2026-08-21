import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type ActivationClient = Pick<PapyrusClient, "call">;
interface ActivationCliContext extends CommandContext {
	readonly client: ActivationClient;
	readonly json: boolean;
	readonly callerProjectRoot: string;
}

interface ActivationAuditOutput {
	summary: {
		total: number;
		enabled: number;
		disabled: number;
		global: number;
		explicit: number;
		hidden: number;
		estimatedEnabledTokens: number;
	};
	entries: Array<{ enabled: boolean; kind: string; title: string; reason: string }>;
}

function parseObject(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("value must be a JSON object");
	return parsed as Record<string, unknown>;
}

const auditCommand = buildCommand({
	func: async function (
		this: ActivationCliContext,
		flags: { projectRoot?: string; activationContextJson?: Record<string, unknown>; sessionId?: string },
	) {
		const result = await this.client.call<Record<string, unknown>, ActivationAuditOutput>("activation.audit", {
			project_root: flags.projectRoot ?? this.callerProjectRoot,
			activation_context: flags.activationContextJson,
			session_id: flags.sessionId,
		});
		if (this.json) this.process.stdout.write(JSON.stringify(result));
		else {
			const summary = result.summary;
			const lines = [
				`${summary.enabled}/${summary.total} enabled; ${summary.disabled} disabled; ${summary.estimatedEnabledTokens} estimated tokens`,
				`scope: ${summary.global} global, ${summary.explicit} explicit, ${summary.hidden} hidden`,
				...result.entries.map((entry) => `${entry.enabled ? "enabled" : "disabled"} [${entry.kind}] ${entry.title} — ${entry.reason}`),
			];
			this.process.stdout.write(lines.join("\n"));
		}
	},
	parameters: {
		flags: {
			projectRoot: { brief: "Project root (defaults to caller cwd)", kind: "parsed", parse: String, placeholder: "path", optional: true },
			activationContextJson: {
				brief: "Trusted activation context as JSON",
				kind: "parsed",
				parse: parseObject,
				placeholder: "json",
				optional: true,
			},
			sessionId: { brief: "Agent session id", kind: "parsed", parse: String, placeholder: "id", optional: true },
		},
	},
	docs: { brief: "Audit Rule and Playbook activation decisions for a project context" },
});

const app = buildApplication(buildRouteMap({ routes: { audit: auditCommand }, docs: { brief: "Conditional activation operations" } }), {
	name: "activation",
	scanner: { caseStyle: "allow-kebab-for-camel" },
});

export async function runActivationCli(args: string[], client: ActivationClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	return runStricliToString(
		app,
		args.filter((arg) => arg !== "--json"),
		{ client, json, callerProjectRoot: projectRoot },
	);
}
