import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type LogClient = Pick<PapyrusClient, "call">;

interface LogContext extends CommandContext {
	readonly client: LogClient;
	readonly json: boolean;
	readonly projectRoot: string;
}

function parseFieldsJson(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--fields-json must be a JSON object");
	return parsed as Record<string, unknown>;
}

const appendCommand = buildCommand({
	func: async function (
		this: LogContext,
		flags: {
			source: string;
			sourceLabel?: string;
			level: string;
			message: string;
			operationId: string;
			sessionId?: string;
			occurredAt?: string;
			fieldsJson?: Record<string, unknown>;
			global: boolean;
		},
	) {
		const result = await this.client.call("logs.append", {
			source_id: flags.source,
			...(flags.sourceLabel ? { source_label: flags.sourceLabel } : {}),
			...(flags.global ? {} : { project_root: this.projectRoot }),
			level: flags.level,
			message: flags.message,
			operation_id: flags.operationId,
			...(flags.fieldsJson ? { fields: flags.fieldsJson } : {}),
			...(flags.sessionId ? { session_id: flags.sessionId } : {}),
			...(flags.occurredAt ? { occurred_at: flags.occurredAt } : {}),
		});
		this.process.stdout.write(this.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
	},
	parameters: {
		flags: {
			source: { brief: "Log source id", kind: "parsed", parse: String, placeholder: "id" },
			sourceLabel: { brief: "Human-readable source label", kind: "parsed", parse: String, placeholder: "text", optional: true },
			level: { brief: "Log level (debug|info|warning|error)", kind: "parsed", parse: String, placeholder: "level" },
			message: { brief: "Log message text", kind: "parsed", parse: String, placeholder: "text" },
			operationId: { brief: "Idempotency key for this append", kind: "parsed", parse: String, placeholder: "id" },
			sessionId: { brief: "Session id to attribute this entry to", kind: "parsed", parse: String, placeholder: "id", optional: true },
			occurredAt: { brief: "ISO timestamp override", kind: "parsed", parse: String, placeholder: "iso", optional: true },
			fieldsJson: { brief: "JSON-encoded structured fields", kind: "parsed", parse: parseFieldsJson, placeholder: "json", optional: true },
			global: { brief: "Append outside any project scope", kind: "boolean" },
		},
	},
	docs: { brief: "Append a log entry" },
});

const queryCommand = buildCommand({
	func: async function (this: LogContext, flags: { source: string; since?: string; level?: string; limit?: number }) {
		const result = await this.client.call<Record<string, unknown>, { entries: unknown[]; truncated: boolean }>("logs.query", {
			source_id: flags.source,
			...(flags.since ? { since: flags.since } : {}),
			...(flags.level ? { level: flags.level } : {}),
			...(flags.limit === undefined ? {} : { limit: flags.limit }),
		});
		if (this.json) {
			this.process.stdout.write(JSON.stringify(result));
			return;
		}
		const lines = result.entries.map((entry) => JSON.stringify(entry));
		this.process.stdout.write(
			[...lines, result.truncated ? "(truncated -- more entries exist beyond this page)" : `(${lines.length} entries)`].join("\n"),
		);
	},
	parameters: {
		flags: {
			source: { brief: "Log source id", kind: "parsed", parse: String, placeholder: "id" },
			since: { brief: "Only entries at or after this ISO timestamp", kind: "parsed", parse: String, placeholder: "iso", optional: true },
			level: { brief: "Filter to one level", kind: "parsed", parse: String, placeholder: "level", optional: true },
			limit: { brief: "Maximum entries to return", kind: "parsed", parse: numberParser, optional: true },
		},
	},
	docs: { brief: "Query log entries" },
});

const app = buildApplication(buildRouteMap({ routes: { append: appendCommand, query: queryCommand }, docs: { brief: "Log operations" } }), {
	name: "log",
	scanner: { caseStyle: "allow-kebab-for-camel" },
});

export async function runLogCli(args: string[], client: LogClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json, projectRoot });
}
