import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { OperationName } from "../service.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type PlaybooksClient = Pick<PapyrusClient, "call">;

interface PlaybooksContext extends CommandContext {
	readonly client: PlaybooksClient;
	readonly json: boolean;
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

/**
 * No further shape assertion here -- --arguments-json is genuinely polymorphic (an array on
 * create, a {name: value} map on invoke) and --steps-json accepts a mix of plain prose strings
 * and structured step objects that a single string-array assertion would wrongly reject. The
 * service validates the real shape for whichever operation actually receives it. Typed as a
 * concrete array-or-object union rather than bare `unknown` -- Stricli's flag-type inference
 * doesn't correctly propagate a parser returning `unknown` through to the command function.
 */
function parseAny(value: string): unknown[] | Record<string, unknown> {
	return JSON.parse(value) as unknown[] | Record<string, unknown>;
}

function render(this: PlaybooksContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const createCommand = buildCommand({
	func: async function (
		this: PlaybooksContext,
		flags: {
			title: string;
			body?: string;
			trigger?: string;
			stepsJson?: unknown[] | Record<string, unknown>;
			toolsJson?: string[];
			labelsJson?: string[];
			extraJson?: Record<string, unknown>;
			argumentsJson?: unknown[] | Record<string, unknown>;
			projectRoot?: string;
			projectsJson?: string[];
		},
	) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("playbooks.create", {
			title: flags.title,
			body: flags.body,
			trigger: flags.trigger,
			steps: flags.stepsJson,
			tools: flags.toolsJson,
			labels: flags.labelsJson,
			extra: flags.extraJson,
			arguments: flags.argumentsJson,
			project_root: flags.projectRoot,
			projects: flags.projectsJson,
		});
		render.call(this, artifact, `Created playbook: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {
			title: { brief: "Playbook title", kind: "parsed", parse: String, placeholder: "text" },
			body: { brief: "Playbook body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			trigger: { brief: "When this playbook applies", kind: "parsed", parse: String, placeholder: "text", optional: true },
			stepsJson: {
				brief: "JSON array of steps (strings and/or {kind:'doc'|'rule'|'call'|'task',...} objects)",
				kind: "parsed",
				parse: parseAny,
				placeholder: "json",
				optional: true,
			},
			toolsJson: { brief: "JSON string array of tool names", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			extraJson: { brief: "JSON object of extra fields", kind: "parsed", parse: parseObject, placeholder: "json", optional: true },
			argumentsJson: {
				brief: "JSON array of declared argument definitions",
				kind: "parsed",
				parse: parseAny,
				placeholder: "json",
				optional: true,
			},
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
			projectsJson: {
				brief: "JSON string array of project id/name/alias/root references, taking precedence over --project-root",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
		},
	},
	docs: { brief: "Create a Playbook" },
});

const listCommand = buildCommand({
	func: async function (
		this: PlaybooksContext,
		flags: { status?: string; text?: string; limit?: number; projectRoot?: string; applicable?: boolean },
	) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("playbooks.list", {
			status: flags.status,
			text: flags.text,
			limit: flags.limit,
			project_root: flags.projectRoot,
			applicable: flags.applicable,
		});
		render.call(this, rows, rows.length === 0 ? "No playbooks found." : rows.map((row) => artifactLabel(row)).join("\n"));
	},
	parameters: {
		flags: {
			status: { brief: "Filter by status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			text: { brief: "Substring match against title/body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum playbooks to return", kind: "parsed", parse: numberParser, optional: true },
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
			applicable: {
				brief: "With --project-root: list global Playbooks plus Playbooks applicable to it, instead of exact membership",
				kind: "boolean",
				optional: true,
			},
		},
	},
	docs: { brief: "List Playbooks" },
});

const showCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("playbooks.show", { id });
		render.call(this, artifact, `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show one Playbook" },
});

const previewCommand = buildCommand({
	func: async function (this: PlaybooksContext, flags: { argumentsJson?: unknown[] | Record<string, unknown> }, id: string) {
		const rendered = await this.client.call<Record<string, unknown>, string>("playbooks.preview", { id, arguments: flags.argumentsJson });
		render.call(this, rendered, rendered);
	},
	parameters: {
		flags: {
			argumentsJson: {
				brief: "JSON object supplying argument values",
				kind: "parsed",
				parse: parseAny,
				placeholder: "json",
				optional: true,
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Render a Playbook's whole composition tree as text, creating nothing" },
});

const invokeCommand = buildCommand({
	func: async function (
		this: PlaybooksContext,
		flags: { argumentsJson?: unknown[] | Record<string, unknown>; runId?: string; projectRoot?: string },
		id: string,
	) {
		const invocation = await this.client.call<Record<string, unknown>, { entryTaskId: string; missingArguments?: string[] }>(
			"playbooks.invoke",
			{ id, arguments: flags.argumentsJson, run_id: flags.runId, project_root: flags.projectRoot },
		);
		render.call(
			this,
			invocation,
			invocation.missingArguments
				? `Missing required argument(s): ${invocation.missingArguments.join(", ")}.`
				: `Invoked: entry task ${invocation.entryTaskId} focused. Drive it forward with \`tasks start/submit/complete\` like any other task.`,
		);
	},
	parameters: {
		flags: {
			argumentsJson: {
				brief: "JSON object supplying argument values",
				kind: "parsed",
				parse: parseAny,
				placeholder: "json",
				optional: true,
			},
			runId: { brief: "Run id to associate with this invocation", kind: "parsed", parse: String, placeholder: "id", optional: true },
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Compile a Playbook's steps into real Tasks and focus the first one" },
});

function buildEnableDisableCommand(action: "enable" | "disable") {
	return buildCommand({
		func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(`playbooks.${action}` as OperationName, { id });
			render.call(this, artifact, artifactLabel(artifact));
		},
		parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] } },
		docs: { brief: `${action[0]!.toUpperCase()}${action.slice(1)} a Playbook` },
	});
}

const assignProjectCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string, projectRoot?: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("playbooks.assign_project", {
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
				{ brief: "Playbook id", parse: String, placeholder: "id" },
				{ brief: "New project scope, omit to unscope", parse: String, placeholder: "project-root", optional: true },
			],
		},
	},
	docs: { brief: "Reassign a Playbook's project scope, or unscope it" },
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
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.scope", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show a Playbook's real project scope" },
});

const setGlobalCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.set_global", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Make a Playbook apply in every project" },
});

const addProjectCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string, project: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.add_project", { id, project });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Playbook id", parse: String, placeholder: "id" },
				{ brief: "Project id/name/alias/root to add", parse: String, placeholder: "project" },
			],
		},
	},
	docs: { brief: "Add one project to a Playbook's membership" },
});

const removeProjectCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string, project: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.remove_project", { id, project });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Playbook id", parse: String, placeholder: "id" },
				{ brief: "Project id/name/alias/root to remove", parse: String, placeholder: "project" },
			],
		},
	},
	docs: { brief: "Remove one project from a Playbook's membership" },
});

const replaceProjectsCommand = buildCommand({
	func: async function (this: PlaybooksContext, flags: { projectsJson: string[] }, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.replace_projects", {
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
		positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Playbook's entire project membership" },
});

const setNoneCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.set_none", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Fully hide a Playbook -- never applicable, never injected, regardless of project" },
});

const addGroupCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string, group: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.add_group", { id, group });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Playbook id", parse: String, placeholder: "id" },
				{ brief: "Scope group id/name/alias to add", parse: String, placeholder: "group" },
			],
		},
	},
	docs: { brief: "Add one scope group to a Playbook's explicit scope" },
});

const removeGroupCommand = buildCommand({
	func: async function (this: PlaybooksContext, _flags: Record<string, never>, id: string, group: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.remove_group", { id, group });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Playbook id", parse: String, placeholder: "id" },
				{ brief: "Scope group id/name/alias to remove", parse: String, placeholder: "group" },
			],
		},
	},
	docs: { brief: "Remove one scope group from a Playbook's explicit scope" },
});

const replaceGroupsCommand = buildCommand({
	func: async function (this: PlaybooksContext, flags: { groupsJson: string[] }, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("playbooks.replace_groups", {
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
		positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Playbook's entire scope-group membership" },
});

const updateCommand = buildCommand({
	func: async function (
		this: PlaybooksContext,
		flags: { title?: string; body?: string; labelsJson?: string[]; trigger?: string; stepsJson?: unknown[] | Record<string, unknown> },
		id: string,
	) {
		if (
			flags.title === undefined &&
			flags.body === undefined &&
			flags.labelsJson === undefined &&
			flags.trigger === undefined &&
			flags.stepsJson === undefined
		)
			throw new Error("playbooks update requires --title, --body, --labels-json, --trigger, or --steps-json");
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("playbooks.update", {
			id,
			title: flags.title,
			body: flags.body,
			labels: flags.labelsJson,
			trigger: flags.trigger,
			steps: flags.stepsJson,
		});
		render.call(this, artifact, artifactLabel(artifact));
	},
	parameters: {
		flags: {
			title: { brief: "New title", kind: "parsed", parse: String, placeholder: "text", optional: true },
			body: { brief: "New body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			trigger: { brief: "New trigger -- replaces the existing one", kind: "parsed", parse: String, placeholder: "text", optional: true },
			stepsJson: {
				brief: "JSON array of steps -- REPLACES the entire existing step list, same shape as create's --steps-json",
				kind: "parsed",
				parse: parseAny,
				placeholder: "json",
				optional: true,
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Playbook id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Change a Playbook's title/body/labels/trigger/steps" },
});

function buildPairedIdCommand(
	operation: OperationName,
	fields: readonly [string, string],
	human: (artifact: CliArtifact, second: string) => string,
	brief: string,
) {
	return buildCommand({
		func: async function (this: PlaybooksContext, _flags: Record<string, never>, first: string, second: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(operation, {
				[fields[0]]: first,
				[fields[1]]: second,
			});
			render.call(this, artifact, human(artifact, second));
		},
		parameters: {
			flags: {},
			positional: {
				kind: "tuple",
				parameters: [
					{ brief: "First playbook id", parse: String, placeholder: "id" },
					{ brief: "Second playbook id", parse: String, placeholder: "id" },
				],
			},
		},
		docs: { brief },
	});
}

const app = buildApplication(
	buildRouteMap({
		routes: {
			create: createCommand,
			list: listCommand,
			show: showCommand,
			preview: previewCommand,
			invoke: invokeCommand,
			enable: buildEnableDisableCommand("enable"),
			disable: buildEnableDisableCommand("disable"),
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
			update: updateCommand,
			contain: buildPairedIdCommand(
				"playbooks.contain",
				["parent_id", "child_id"],
				(artifact, second) => `Nested: ${second} → ${artifactLabel(artifact)}`,
				"Nest a child Playbook inside a parent",
			),
			uncontain: buildPairedIdCommand(
				"playbooks.uncontain",
				["parent_id", "child_id"],
				(artifact, second) => `Removed ${second} from ${artifactLabel(artifact)}`,
				"Remove a parent/child Playbook nesting",
			),
			depend: buildPairedIdCommand(
				"playbooks.depend",
				["id", "dependency_id"],
				(artifact, second) => `Dependency added: ${artifactLabel(artifact)} waits for ${second}`,
				"Chain a prerequisite Playbook before another",
			),
			undepend: buildPairedIdCommand(
				"playbooks.undepend",
				["id", "dependency_id"],
				(artifact, second) => `Dependency removed: ${artifactLabel(artifact)} no longer waits for ${second}`,
				"Remove a Playbook dependency",
			),
		},
		docs: { brief: "Playbook operations" },
	}),
	{ name: "playbooks", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runPlaybooksCli(args: string[], client: PlaybooksClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
