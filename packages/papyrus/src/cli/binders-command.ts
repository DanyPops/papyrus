import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { OperationName } from "../service.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type BindersClient = Pick<PapyrusClient, "call">;

interface BindersContext extends CommandContext {
	readonly client: BindersClient;
	readonly json: boolean;
}

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("value must be a JSON string array");
	return parsed as string[];
}

function render(this: BindersContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const createCommand = buildCommand({
	func: async function (
		this: BindersContext,
		flags: { title: string; labelsJson?: string[]; parentId?: string; projectRoot?: string; projectsJson?: string[] },
	) {
		const binder = await this.client.call<Record<string, unknown>, CliArtifact>("binders.create", {
			title: flags.title,
			labels: flags.labelsJson,
			parent_id: flags.parentId,
			project_root: flags.projectRoot,
			projects: flags.projectsJson,
		});
		render.call(this, binder, `Created Binder: ${artifactLabel(binder)}`);
	},
	parameters: {
		flags: {
			title: { brief: "Binder name", kind: "parsed", parse: String, placeholder: "text" },
			labelsJson: {
				brief: "JSON string array of inherited labels",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
			parentId: { brief: "Parent Binder id", kind: "parsed", parse: String, placeholder: "id", optional: true },
			projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true },
			projectsJson: { brief: "JSON project-reference array", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
		},
	},
	docs: { brief: "Create a Binder" },
});

const listCommand = buildCommand({
	func: async function (this: BindersContext, flags: { text?: string; limit?: number; projectRoot?: string; applicable?: boolean }) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("binders.list", {
			text: flags.text,
			limit: flags.limit,
			project_root: flags.projectRoot,
			applicable: flags.applicable,
		});
		render.call(this, rows, rows.length === 0 ? "No Binders found." : rows.map(artifactLabel).join("\n"));
	},
	parameters: {
		flags: {
			text: { brief: "Substring match", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum Binders", kind: "parsed", parse: numberParser, optional: true },
			projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true },
			applicable: { brief: "Include global and project-applicable Binders", kind: "boolean", optional: true },
		},
	},
	docs: { brief: "List Binders" },
});

interface CliBinderTree {
	nodes: Array<{ binder: CliArtifact; path: string; effectiveLabels: string[] }>;
	artifacts: Array<{ artifactId: string; binderId?: string; inheritedLabels: string[]; effectiveLabels: string[] }>;
}

const treeCommand = buildCommand({
	func: async function (this: BindersContext, flags: { projectRoot?: string; artifactIdsJson?: string[] }) {
		const tree = await this.client.call<Record<string, unknown>, CliBinderTree>("binders.tree", {
			project_root: flags.projectRoot,
			artifact_ids: flags.artifactIdsJson,
		});
		const lines = tree.nodes.map((node) => `${node.path}${node.effectiveLabels.length ? ` [${node.effectiveLabels.join(", ")}]` : ""}`);
		render.call(this, tree, lines.length === 0 ? "/ (no Binders)" : lines.join("\n"));
	},
	parameters: {
		flags: {
			projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true },
			artifactIdsJson: {
				brief: "JSON artifact-id array to project",
				kind: "parsed",
				parse: parseStringArray,
				placeholder: "json",
				optional: true,
			},
		},
	},
	docs: { brief: "Show Binder hierarchy and effective labels" },
});

const showCommand = buildCommand({
	func: async function (this: BindersContext, flags: { projectRoot?: string }, id: string) {
		const node = await this.client.call<Record<string, unknown>, { binder: CliArtifact; path: string; effectiveLabels: string[] }>(
			"binders.show",
			{
				id,
				project_root: flags.projectRoot,
			},
		);
		render.call(this, node, `${node.path}${node.effectiveLabels.length ? ` [${node.effectiveLabels.join(", ")}]` : ""}`);
	},
	parameters: {
		flags: { projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Binder id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Show one Binder" },
});

const updateCommand = buildCommand({
	func: async function (this: BindersContext, flags: { title?: string; labelsJson?: string[]; projectRoot?: string }, id: string) {
		if (flags.title === undefined && flags.labelsJson === undefined) throw new Error("binders update requires --title or --labels-json");
		const binder = await this.client.call<Record<string, unknown>, CliArtifact>("binders.update", {
			id,
			title: flags.title,
			labels: flags.labelsJson,
			project_root: flags.projectRoot,
		});
		render.call(this, binder, artifactLabel(binder));
	},
	parameters: {
		flags: {
			title: { brief: "New Binder name", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "Replacement direct-label array", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Binder id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Rename or relabel a Binder" },
});

const moveCommand = buildCommand({
	func: async function (this: BindersContext, flags: { projectRoot?: string }, id: string, parentId?: string) {
		const node = await this.client.call<Record<string, unknown>, { path: string }>("binders.move", {
			id,
			parent_id: parentId,
			project_root: flags.projectRoot,
		});
		render.call(this, node, `Moved ${id} to ${node.path}`);
	},
	parameters: {
		flags: { projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true } },
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Binder id", parse: String, placeholder: "id" },
				{ brief: "Parent Binder id; omit for root", parse: String, placeholder: "parent-id", optional: true },
			],
		},
	},
	docs: { brief: "Move a Binder" },
});

const fileCommand = buildCommand({
	func: async function (this: BindersContext, flags: { projectRoot?: string }, artifactId: string, binderId: string) {
		const placement = await this.client.call<Record<string, unknown>, { effectiveLabels: string[] }>("binders.file", {
			artifact_id: artifactId,
			binder_id: binderId,
			project_root: flags.projectRoot,
		});
		render.call(this, placement, `Filed ${artifactId} in ${binderId}`);
	},
	parameters: {
		flags: { projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true } },
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Artifact id", parse: String, placeholder: "artifact-id" },
				{ brief: "Binder id", parse: String, placeholder: "binder-id" },
			],
		},
	},
	docs: { brief: "File an artifact in a Binder" },
});

const unfileCommand = buildCommand({
	func: async function (this: BindersContext, flags: { projectRoot?: string }, artifactId: string) {
		const placement = await this.client.call<Record<string, unknown>, unknown>("binders.unfile", {
			artifact_id: artifactId,
			project_root: flags.projectRoot,
		});
		render.call(this, placement, `Moved ${artifactId} to root`);
	},
	parameters: {
		flags: { projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "artifact-id" }] },
	},
	docs: { brief: "Move an artifact to Binder root" },
});

const removeCommand = buildCommand({
	func: async function (this: BindersContext, flags: { projectRoot?: string; reason?: string }, id: string) {
		const result = await this.client.call<Record<string, unknown>, unknown>("binders.remove", {
			id,
			project_root: flags.projectRoot,
			reason: flags.reason,
		});
		render.call(this, result, `Removed empty Binder ${id}`);
	},
	parameters: {
		flags: {
			projectRoot: { brief: "Project context", kind: "parsed", parse: String, placeholder: "path", optional: true },
			reason: { brief: "Audit reason", kind: "parsed", parse: String, placeholder: "text", optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Binder id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Remove an empty Binder" },
});

interface CliScope {
	artifactId: string;
	mode: string;
	members: Array<{ type: string; id: string }>;
}

function scopeLabel(scope: CliScope): string {
	return scope.mode === "all" ? "global" : `${scope.mode}: ${scope.members.map((member) => `${member.type}:${member.id}`).join(", ")}`;
}

function unaryScopeCommand(operation: "scope" | "set_global" | "set_none", brief: string) {
	return buildCommand({
		func: async function (this: BindersContext, _flags: Record<string, never>, id: string) {
			const scope = await this.client.call<Record<string, unknown>, CliScope>(`binders.${operation}` as OperationName, { id });
			render.call(this, scope, scopeLabel(scope));
		},
		parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Binder id", parse: String, placeholder: "id" }] } },
		docs: { brief },
	});
}

function memberCommand(operation: "add_project" | "remove_project" | "add_group" | "remove_group") {
	const key = operation.endsWith("project") ? "project" : "group";
	return buildCommand({
		func: async function (this: BindersContext, _flags: Record<string, never>, id: string, member: string) {
			const scope = await this.client.call<Record<string, unknown>, CliScope>(`binders.${operation}` as OperationName, {
				id,
				[key]: member,
			});
			render.call(this, scope, scopeLabel(scope));
		},
		parameters: {
			flags: {},
			positional: {
				kind: "tuple",
				parameters: [
					{ brief: "Binder id", parse: String, placeholder: "id" },
					{ brief: `${key} reference`, parse: String, placeholder: key },
				],
			},
		},
		docs: { brief: `${operation.startsWith("add") ? "Add" : "Remove"} a ${key}` },
	});
}

function replaceMembersCommand(operation: "replace_projects" | "replace_groups") {
	const key = operation === "replace_projects" ? "projects" : "groups";
	const flag = operation === "replace_projects" ? "projectsJson" : "groupsJson";
	return buildCommand({
		func: async function (this: BindersContext, flags: { projectsJson?: string[]; groupsJson?: string[] }, id: string) {
			const values = flags[flag];
			if (!values) throw new Error(`--${operation === "replace_projects" ? "projects-json" : "groups-json"} is required`);
			const scope = await this.client.call<Record<string, unknown>, CliScope>(`binders.${operation}` as OperationName, {
				id,
				[key]: values,
			});
			render.call(this, scope, scopeLabel(scope));
		},
		parameters: {
			flags: {
				projectsJson: {
					brief: "JSON project reference array",
					kind: "parsed",
					parse: parseStringArray,
					placeholder: "json",
					optional: true,
				},
				groupsJson: {
					brief: "JSON scope-group reference array",
					kind: "parsed",
					parse: parseStringArray,
					placeholder: "json",
					optional: true,
				},
			},
			positional: { kind: "tuple", parameters: [{ brief: "Binder id", parse: String, placeholder: "id" }] },
		},
		docs: { brief: `Replace Binder ${key}` },
	});
}

const app = buildApplication(
	buildRouteMap({
		routes: {
			create: createCommand,
			list: listCommand,
			tree: treeCommand,
			show: showCommand,
			update: updateCommand,
			move: moveCommand,
			file: fileCommand,
			unfile: unfileCommand,
			remove: removeCommand,
			scope: unaryScopeCommand("scope", "Show Binder scope"),
			"set-global": unaryScopeCommand("set_global", "Make a Binder global"),
			"set-none": unaryScopeCommand("set_none", "Hide a Binder"),
			"add-project": memberCommand("add_project"),
			"remove-project": memberCommand("remove_project"),
			"replace-projects": replaceMembersCommand("replace_projects"),
			"add-group": memberCommand("add_group"),
			"remove-group": memberCommand("remove_group"),
			"replace-groups": replaceMembersCommand("replace_groups"),
		},
		docs: { brief: "Binder hierarchy and inherited-label operations" },
	}),
	{ name: "binders", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runBindersCli(args: string[], client: BindersClient): Promise<string> {
	const json = args.includes("--json");
	return runStricliToString(
		app,
		args.filter((argument) => argument !== "--json"),
		{ client, json },
	);
}
