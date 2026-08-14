import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type ScopeGroupsClient = Pick<PapyrusClient, "call">;

interface ScopeGroupsContext extends CommandContext {
	readonly client: ScopeGroupsClient;
	readonly json: boolean;
}

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("value must be a JSON string array");
	return parsed as string[];
}

interface CliScopeGroup {
	id: string;
	name: string;
	aliases: string[];
}

interface CliScopeMember {
	type: "project" | "group";
	id: string;
}

function render(this: ScopeGroupsContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const listCommand = buildCommand({
	func: async function (this: ScopeGroupsContext, flags: { query?: string; limit?: number }) {
		const groups = await this.client.call<Record<string, unknown>, CliScopeGroup[]>("scope_groups.list", {
			query: flags.query,
			limit: flags.limit,
		});
		render.call(this, groups, groups.length === 0 ? "No registered scope groups." : groups.map((group) => group.name).join("\n"));
	},
	parameters: {
		flags: {
			query: { brief: "Filter by scope group name or alias", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum results", kind: "parsed", parse: numberParser, placeholder: "n", optional: true },
		},
	},
	docs: { brief: "List registered scope groups" },
});

const resolveCommand = buildCommand({
	func: async function (this: ScopeGroupsContext, _flags: Record<string, never>, reference: string) {
		const group = await this.client.call<Record<string, unknown>, CliScopeGroup>("scope_groups.resolve", { reference });
		render.call(this, group, group.name);
	},
	parameters: {
		flags: {},
		positional: { kind: "tuple", parameters: [{ brief: "Scope group id, name, or alias", parse: String, placeholder: "reference" }] },
	},
	docs: { brief: "Resolve a scope group reference to its canonical identity" },
});

const registerCommand = buildCommand({
	func: async function (this: ScopeGroupsContext, flags: { aliasesJson?: string[]; existingId?: string }, name: string) {
		const registered = await this.client.call<Record<string, unknown>, CliScopeGroup>("scope_groups.register", {
			name,
			aliases: flags.aliasesJson,
			existing_id: flags.existingId,
		});
		render.call(this, registered, registered.name);
	},
	parameters: {
		flags: {
			aliasesJson: { brief: "JSON string array of aliases", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			existingId: {
				brief: "Existing scope group id when renaming",
				kind: "parsed",
				parse: String,
				placeholder: "id",
				optional: true,
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Scope group name", parse: String, placeholder: "name" }] },
	},
	docs: { brief: "Register a new scope group, or rename an existing one" },
});

const showCommand = buildCommand({
	func: async function (this: ScopeGroupsContext, _flags: Record<string, never>, group: string) {
		const result = await this.client.call<Record<string, unknown>, { group: CliScopeGroup; members: CliScopeMember[] }>(
			"scope_groups.show",
			{ group },
		);
		render.call(
			this,
			result,
			`${result.group.name}: ${result.members.length === 0 ? "(no members)" : result.members.map((m) => `${m.type}:${m.id}`).join(", ")}`,
		);
	},
	parameters: {
		flags: {},
		positional: { kind: "tuple", parameters: [{ brief: "Scope group id, name, or alias", parse: String, placeholder: "group" }] },
	},
	docs: { brief: "Show a scope group's identity and its own direct membership" },
});

const addMemberCommand = buildCommand({
	func: async function (
		this: ScopeGroupsContext,
		_flags: Record<string, never>,
		group: string,
		memberType: string,
		memberReference: string,
	) {
		const result = await this.client.call<Record<string, unknown>, { group: CliScopeGroup; members: CliScopeMember[] }>(
			"scope_groups.add_member",
			{ group, member_type: memberType, member_reference: memberReference },
		);
		render.call(this, result, `${result.group.name}: ${result.members.length} member(s)`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Scope group id, name, or alias", parse: String, placeholder: "group" },
				{ brief: '"project" or "group"', parse: String, placeholder: "member-type" },
				{ brief: "Exact project or scope group id/name/alias/root reference", parse: String, placeholder: "member-reference" },
			],
		},
	},
	docs: { brief: "Add one member (a project, or another scope group) to a scope group" },
});

const removeMemberCommand = buildCommand({
	func: async function (
		this: ScopeGroupsContext,
		_flags: Record<string, never>,
		group: string,
		memberType: string,
		memberReference: string,
	) {
		const result = await this.client.call<Record<string, unknown>, { group: CliScopeGroup; members: CliScopeMember[] }>(
			"scope_groups.remove_member",
			{ group, member_type: memberType, member_reference: memberReference },
		);
		render.call(this, result, `${result.group.name}: ${result.members.length} member(s)`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Scope group id, name, or alias", parse: String, placeholder: "group" },
				{ brief: '"project" or "group"', parse: String, placeholder: "member-type" },
				{ brief: "Exact project or scope group id/name/alias/root reference", parse: String, placeholder: "member-reference" },
			],
		},
	},
	docs: { brief: "Remove one member from a scope group" },
});

const deleteCommand = buildCommand({
	func: async function (this: ScopeGroupsContext, _flags: Record<string, never>, group: string) {
		const result = await this.client.call<Record<string, unknown>, { deleted: boolean; id: string }>("scope_groups.delete", { group });
		render.call(this, result, `Deleted scope group ${result.id}`);
	},
	parameters: {
		flags: {},
		positional: { kind: "tuple", parameters: [{ brief: "Scope group id, name, or alias", parse: String, placeholder: "group" }] },
	},
	docs: { brief: "Delete a scope group outright (refuses if still referenced)" },
});

const app = buildApplication(
	buildRouteMap({
		routes: {
			list: listCommand,
			resolve: resolveCommand,
			register: registerCommand,
			show: showCommand,
			"add-member": addMemberCommand,
			"remove-member": removeMemberCommand,
			delete: deleteCommand,
		},
		docs: {
			brief: "Scope group operations -- named, reusable, possibly-nested collections of projects/groups for Doc/Rule/Playbook scoping",
		},
	}),
	{ name: "scope-groups", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runScopeGroupsCli(args: string[], client: ScopeGroupsClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
