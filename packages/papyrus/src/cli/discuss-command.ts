import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { OperationName } from "../service.ts";
import { runStricliToString } from "./stricli-run.ts";

type DiscussClient = Pick<PapyrusClient, "call">;

interface DiscussContext extends CommandContext {
	readonly client: DiscussClient;
	readonly json: boolean;
}

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("value must be a JSON string array");
	return parsed as string[];
}

function render(this: DiscussContext, result: unknown): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

async function call(this: DiscussContext, operation: OperationName, input: Record<string, unknown>): Promise<void> {
	render.call(this, await this.client.call<Record<string, unknown>, unknown>(operation, input));
}

const openCommand = buildCommand({
	func: async function (
		this: DiscussContext,
		flags: {
			title: string;
			actor: string;
			content: string;
			body?: string;
			labelsJson?: string[];
			blocksJson?: string[];
			optionsJson?: string[];
			optionsMode?: string;
			optionDescriptionsJson?: string[];
		},
	) {
		await call.call(this, "discuss.open", {
			title: flags.title,
			actor: flags.actor,
			content: flags.content,
			body: flags.body,
			labels: flags.labelsJson,
			blocks_task_ids: flags.blocksJson,
			options: flags.optionsJson,
			options_mode: flags.optionsMode,
			option_descriptions: flags.optionDescriptionsJson,
		});
	},
	parameters: {
		flags: {
			title: { brief: "Discussion title", kind: "parsed", parse: String, placeholder: "text" },
			actor: { brief: "Actor opening the discussion", kind: "parsed", parse: String, placeholder: "text" },
			content: { brief: "First round's content", kind: "parsed", parse: String, placeholder: "text" },
			body: { brief: "Longer body text", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			blocksJson: {
				brief: "JSON string array of task ids to block",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			optionsJson: {
				brief: "JSON string array of posed options",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			optionsMode: { brief: "single or multi", kind: "parsed", parse: String, placeholder: "mode", optional: true },
			optionDescriptionsJson: {
				brief: "JSON string array of option descriptions",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
		},
	},
	docs: { brief: "Open a new discussion" },
});

const replyCommand = buildCommand({
	func: async function (
		this: DiscussContext,
		flags: {
			actor: string;
			content: string;
			selectedJson?: string[];
			optionsJson?: string[];
			optionsMode?: string;
			optionDescriptionsJson?: string[];
		},
		id: string,
	) {
		await call.call(this, "discuss.reply", {
			id,
			actor: flags.actor,
			content: flags.content,
			selected: flags.selectedJson,
			options: flags.optionsJson,
			options_mode: flags.optionsMode,
			option_descriptions: flags.optionDescriptionsJson,
		});
	},
	parameters: {
		flags: {
			actor: { brief: "Actor replying", kind: "parsed", parse: String, placeholder: "text" },
			content: { brief: "Reply content", kind: "parsed", parse: String, placeholder: "text" },
			selectedJson: {
				brief: "JSON string array answering a pending posed choice",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			optionsJson: {
				brief: "JSON string array of posed options",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			optionsMode: { brief: "single or multi", kind: "parsed", parse: String, placeholder: "mode", optional: true },
			optionDescriptionsJson: {
				brief: "JSON string array of option descriptions",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Add a round to an existing discussion" },
});

const deferCommand = buildCommand({
	func: async function (this: DiscussContext, flags: { reason?: string }, id: string) {
		await call.call(this, "discuss.defer", { id, reason: flags.reason });
	},
	parameters: {
		flags: {
			reason: { brief: "Why this discussion is being deferred", kind: "parsed", parse: String, placeholder: "text", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Pause a discussion without settling it" },
});

const resumeCommand = buildCommand({
	func: async function (this: DiscussContext, _flags: Record<string, never>, id: string) {
		await call.call(this, "discuss.resume", { id });
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Resume a deferred discussion" },
});

const settleCommand = buildCommand({
	func: async function (this: DiscussContext, flags: { settlement: string }, id: string) {
		await call.call(this, "discuss.settle", { id, settlement: flags.settlement });
	},
	parameters: {
		flags: { settlement: { brief: "Final settlement text", kind: "parsed", parse: String, placeholder: "text" } },
		positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Settle a discussion" },
});

const blockCommand = buildCommand({
	func: async function (this: DiscussContext, flags: { taskId: string }, id: string) {
		await call.call(this, "discuss.block", { id, task_id: flags.taskId });
	},
	parameters: {
		flags: { taskId: { brief: "Task id to block", kind: "parsed", parse: String, placeholder: "id" } },
		positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Block a task's completion on this discussion" },
});

const unblockCommand = buildCommand({
	func: async function (this: DiscussContext, flags: { taskId: string }, id: string) {
		await call.call(this, "discuss.unblock", { id, task_id: flags.taskId });
	},
	parameters: {
		flags: { taskId: { brief: "Task id to unblock", kind: "parsed", parse: String, placeholder: "id" } },
		positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Remove a discussion's block on a task" },
});

const showCommand = buildCommand({
	func: async function (this: DiscussContext, _flags: Record<string, never>, id: string) {
		await call.call(this, "discuss.show", { id });
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show a discussion's full transcript" },
});

const roundsCommand = buildCommand({
	func: async function (this: DiscussContext, flags: { afterRound?: number; limit?: number }, id: string) {
		await call.call(this, "discuss.rounds", { id, after_round: flags.afterRound, limit: flags.limit });
	},
	parameters: {
		flags: {
			afterRound: { brief: "Only rounds after this number", kind: "parsed", parse: numberParser, optional: true },
			limit: { brief: "Maximum rounds to return", kind: "parsed", parse: numberParser, optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Discussion id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "List a discussion's rounds" },
});

const listCommand = buildCommand({
	func: async function (this: DiscussContext, flags: { state?: string; limit?: number }) {
		await call.call(this, "discuss.list", { state: flags.state, limit: flags.limit });
	},
	parameters: {
		flags: {
			state: { brief: "Filter to active|deferred|settled", kind: "parsed", parse: String, placeholder: "state", optional: true },
			limit: { brief: "Maximum discussions to return", kind: "parsed", parse: numberParser, optional: true },
		},
	},
	docs: { brief: "List discussions" },
});

const app = buildApplication(
	buildRouteMap({
		routes: {
			open: openCommand,
			reply: replyCommand,
			defer: deferCommand,
			resume: resumeCommand,
			settle: settleCommand,
			block: blockCommand,
			unblock: unblockCommand,
			show: showCommand,
			rounds: roundsCommand,
			list: listCommand,
		},
		docs: { brief: "Discussion operations" },
	}),
	{ name: "discuss", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runDiscussCli(args: string[], client: DiscussClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
