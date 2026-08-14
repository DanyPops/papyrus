import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { OperationName } from "../service.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type RulesClient = Pick<PapyrusClient, "call">;

interface RulesContext extends CommandContext {
	readonly client: RulesClient;
	readonly json: boolean;
	/** The caller's own project root -- distinct from any --project-root flag; only `injectable` uses this. */
	readonly callerProjectRoot: string;
}

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("value must be a JSON string array");
	return parsed as string[];
}

function parseObject(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("value must be a JSON object");
	return parsed as Record<string, unknown>;
}

function render(this: RulesContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const createCommand = buildCommand({
	func: async function (
		this: RulesContext,
		flags: {
			title: string;
			body?: string;
			condition?: string;
			ruleAction?: string;
			severity?: string;
			labelsJson?: string[];
			extraJson?: Record<string, unknown>;
			projectRoot?: string;
		},
	) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("rules.create", {
			title: flags.title,
			body: flags.body,
			condition: flags.condition,
			rule_action: flags.ruleAction,
			severity: flags.severity,
			labels: flags.labelsJson,
			extra: flags.extraJson,
			project_root: flags.projectRoot,
		});
		render.call(this, artifact, `Created rule: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {
			title: { brief: "Rule title", kind: "parsed", parse: String, placeholder: "text" },
			body: { brief: "Rule body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			condition: { brief: "When this rule applies", kind: "parsed", parse: String, placeholder: "text", optional: true },
			ruleAction: { brief: "What the rule requires", kind: "parsed", parse: String, placeholder: "text", optional: true },
			severity: { brief: "block|warn|info", kind: "parsed", parse: String, placeholder: "severity", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			extraJson: { brief: "JSON object of extra fields", kind: "parsed", parse: parseObject, placeholder: "json", optional: true },
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
		},
	},
	docs: { brief: "Create a Rule" },
});

const listCommand = buildCommand({
	func: async function (this: RulesContext, flags: { status?: string; text?: string; limit?: number; projectRoot?: string }) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("rules.list", {
			status: flags.status,
			text: flags.text,
			limit: flags.limit,
			project_root: flags.projectRoot,
		});
		render.call(this, rows, rows.length === 0 ? "No rules found." : rows.map((row) => artifactLabel(row)).join("\n"));
	},
	parameters: {
		flags: {
			status: { brief: "Filter by status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			text: { brief: "Substring match against title/body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum rules to return", kind: "parsed", parse: numberParser, optional: true },
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
		},
	},
	docs: { brief: "List Rules" },
});

const assignProjectCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string, projectRoot?: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("rules.assign_project", {
			id,
			project_root: projectRoot,
		});
		render.call(this, artifact, projectRoot ? `Assigned ${id} to ${projectRoot}` : `Unscoped ${id}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Rule id", parse: String, placeholder: "id" },
				{ brief: "New project scope, omit to unscope", parse: String, placeholder: "project-root", optional: true },
			],
		},
	},
	docs: { brief: "Reassign a Rule's project scope, or unscope it" },
});

interface CliArtifactScope {
	artifactId: string;
	mode: string;
	projectIds: string[];
	source: string;
}

function renderScope(scope: CliArtifactScope): string {
	return scope.mode === "global" ? "global (applies to every project)" : `projects: ${scope.projectIds.join(", ")}`;
}

const scopeCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.scope", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show a Rule's real project scope" },
});

const setGlobalCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.set_global", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Make a Rule apply in every project" },
});

const addProjectCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string, project: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.add_project", { id, project });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Rule id", parse: String, placeholder: "id" },
				{ brief: "Project id/name/alias/root to add", parse: String, placeholder: "project" },
			],
		},
	},
	docs: { brief: "Add one project to a Rule's membership" },
});

const removeProjectCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string, project: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.remove_project", { id, project });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Rule id", parse: String, placeholder: "id" },
				{ brief: "Project id/name/alias/root to remove", parse: String, placeholder: "project" },
			],
		},
	},
	docs: { brief: "Remove one project from a Rule's membership" },
});

const replaceProjectsCommand = buildCommand({
	func: async function (this: RulesContext, flags: { projectsJson: string[] }, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.replace_projects", {
			id,
			projects: flags.projectsJson,
		});
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {
			projectsJson: {
				brief: "JSON string array of project id/name/alias/root references",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Rule's entire project membership" },
});

const setNoneCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.set_none", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Fully hide a Rule -- never applicable, never injected, regardless of project" },
});

const addGroupCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string, group: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.add_group", { id, group });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Rule id", parse: String, placeholder: "id" },
				{ brief: "Scope group id/name/alias to add", parse: String, placeholder: "group" },
			],
		},
	},
	docs: { brief: "Add one scope group to a Rule's explicit scope" },
});

const removeGroupCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string, group: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.remove_group", { id, group });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Rule id", parse: String, placeholder: "id" },
				{ brief: "Scope group id/name/alias to remove", parse: String, placeholder: "group" },
			],
		},
	},
	docs: { brief: "Remove one scope group from a Rule's explicit scope" },
});

const replaceGroupsCommand = buildCommand({
	func: async function (this: RulesContext, flags: { groupsJson: string[] }, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("rules.replace_groups", {
			id,
			groups: flags.groupsJson,
		});
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {
			groupsJson: {
				brief: "JSON string array of scope group id/name/alias references",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Rule's entire scope-group membership" },
});

const showCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("rules.show", { id });
		render.call(this, artifact, `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show one Rule" },
});

const previewCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string) {
		const result = await this.client.call<Record<string, unknown>, { preview: string; combinedLength: number; warning?: string }>(
			"rules.preview",
			{ id },
		);
		const text = result.warning === undefined ? result.preview : `${result.preview}\n\n⚠ ${result.warning}`;
		render.call(this, result, text);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Render a Rule's own condition/action/body preview text" },
});

function buildEnableDisableCommand(action: "enable" | "disable") {
	return buildCommand({
		func: async function (this: RulesContext, _flags: Record<string, never>, id: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(`rules.${action}` as OperationName, { id });
			render.call(this, artifact, artifactLabel(artifact));
		},
		parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] } },
		docs: { brief: `${action[0]!.toUpperCase()}${action.slice(1)} a Rule` },
	});
}

const gateCommand = buildCommand({
	func: async function (this: RulesContext, _flags: Record<string, never>, id: string, taskId: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("rules.gate", { id, task_id: taskId });
		render.call(this, artifact, `Gated ${taskId} with rule ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Rule id", parse: String, placeholder: "rule-id" },
				{ brief: "Task id to gate", parse: String, placeholder: "task-id" },
			],
		},
	},
	docs: { brief: "Attach a Rule as a gate condition on a Task" },
});

const injectableCommand = buildCommand({
	func: async function (this: RulesContext) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("rules.injectable", {
			project_root: this.callerProjectRoot,
		});
		render.call(this, rows, rows.length === 0 ? "No injectable rules." : rows.map((row) => row.title).join("\n"));
	},
	parameters: { flags: {} },
	docs: { brief: "List Rules currently injectable into the agent system prompt for this project" },
});

const updateCommand = buildCommand({
	func: async function (this: RulesContext, flags: { title?: string; body?: string; labelsJson?: string[] }, id: string) {
		if (flags.title === undefined && flags.body === undefined && flags.labelsJson === undefined)
			throw new Error("rules update requires --title, --body, or --labels-json");
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("rules.update", {
			id,
			title: flags.title,
			body: flags.body,
			labels: flags.labelsJson,
		});
		render.call(this, artifact, artifactLabel(artifact));
	},
	parameters: {
		flags: {
			title: { brief: "New title", kind: "parsed", parse: String, placeholder: "text", optional: true },
			body: { brief: "New body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Rule id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Change a Rule's title/body/labels" },
});

const app = buildApplication(
	buildRouteMap({
		routes: {
			create: createCommand,
			list: listCommand,
			"assign-project": assignProjectCommand,
			scope: scopeCommand,
			"set-global": setGlobalCommand,
			"set-none": setNoneCommand,
			"add-project": addProjectCommand,
			"remove-project": removeProjectCommand,
			"replace-projects": replaceProjectsCommand,
			"add-group": addGroupCommand,
			"remove-group": removeGroupCommand,
			"replace-groups": replaceGroupsCommand,
			show: showCommand,
			preview: previewCommand,
			enable: buildEnableDisableCommand("enable"),
			disable: buildEnableDisableCommand("disable"),
			gate: gateCommand,
			injectable: injectableCommand,
			update: updateCommand,
		},
		docs: { brief: "Rule operations" },
	}),
	{ name: "rules", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runRulesCli(args: string[], client: RulesClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json, callerProjectRoot: projectRoot });
}
