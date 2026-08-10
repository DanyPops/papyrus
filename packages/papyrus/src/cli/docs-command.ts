import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { OperationName } from "../service.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type DocsClient = Pick<PapyrusClient, "call">;

interface DocsContext extends CommandContext {
	readonly client: DocsClient;
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

function render(this: DocsContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const createCommand = buildCommand({
	func: async function (
		this: DocsContext,
		flags: {
			title: string;
			body?: string;
			subtype?: string;
			labelsJson?: string[];
			extraJson?: Record<string, unknown>;
			templateId?: string;
			projectRoot?: string;
		},
	) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("docs.create", {
			title: flags.title,
			body: flags.body,
			subtype: flags.subtype,
			labels: flags.labelsJson,
			extra: flags.extraJson,
			template_id: flags.templateId,
			project_root: flags.projectRoot,
		});
		render.call(this, artifact, `Created document: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {
			title: { brief: "Document title", kind: "parsed", parse: String, placeholder: "text" },
			body: { brief: "Document body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			subtype: { brief: "Document subtype", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			extraJson: { brief: "JSON object of extra fields", kind: "parsed", parse: parseObject, placeholder: "json", optional: true },
			templateId: { brief: "Template to instantiate from", kind: "parsed", parse: String, placeholder: "id", optional: true },
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
		},
	},
	docs: { brief: "Create a Doc" },
});

const listCommand = buildCommand({
	func: async function (this: DocsContext, flags: { status?: string; text?: string; limit?: number; projectRoot?: string }) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("docs.list", {
			status: flags.status,
			text: flags.text,
			limit: flags.limit,
			project_root: flags.projectRoot,
		});
		render.call(this, rows, rows.length === 0 ? "No documents found." : rows.map((row) => artifactLabel(row)).join("\n"));
	},
	parameters: {
		flags: {
			status: { brief: "Filter by status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			text: { brief: "Substring match against title/body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum docs to return", kind: "parsed", parse: numberParser, optional: true },
			projectRoot: { brief: "Project scope", kind: "parsed", parse: String, placeholder: "path", optional: true },
		},
	},
	docs: { brief: "List Docs" },
});

const assignProjectCommand = buildCommand({
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string, projectRoot?: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("docs.assign_project", { id, project_root: projectRoot });
		render.call(this, artifact, projectRoot ? `Assigned ${id} to ${projectRoot}` : `Unscoped ${id}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Document id", parse: String, placeholder: "id" },
				{ brief: "New project scope, omit to unscope", parse: String, placeholder: "project-root", optional: true },
			],
		},
	},
	docs: { brief: "Reassign a Doc's project scope, or unscope it" },
});

const showCommand = buildCommand({
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("docs.show", { id });
		render.call(this, artifact, `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Document id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show one Doc" },
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
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("docs.scope", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Document id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show a Doc's real project scope" },
});

const setGlobalCommand = buildCommand({
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("docs.set_global", { id });
		render.call(this, scope, renderScope(scope));
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Document id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Make a Doc apply in every project" },
});

const addProjectCommand = buildCommand({
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string, project: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("docs.add_project", { id, project });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Document id", parse: String, placeholder: "id" },
				{ brief: "Project id/name/alias/root to add", parse: String, placeholder: "project" },
			],
		},
	},
	docs: { brief: "Add one project to a Doc's membership" },
});

const removeProjectCommand = buildCommand({
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string, project: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("docs.remove_project", { id, project });
		render.call(this, scope, renderScope(scope));
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Document id", parse: String, placeholder: "id" },
				{ brief: "Project id/name/alias/root to remove", parse: String, placeholder: "project" },
			],
		},
	},
	docs: { brief: "Remove one project from a Doc's membership" },
});

const replaceProjectsCommand = buildCommand({
	func: async function (this: DocsContext, flags: { projectsJson: string[] }, id: string) {
		const scope = await this.client.call<Record<string, unknown>, CliArtifactScope>("docs.replace_projects", {
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
		positional: { kind: "tuple", parameters: [{ brief: "Document id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Replace a Doc's entire project membership" },
});

function buildStatusTransitionCommand(action: "activate" | "archive" | "reopen") {
	return buildCommand({
		func: async function (this: DocsContext, _flags: Record<string, never>, id: string) {
			const artifact = await this.client.call<Record<string, unknown>, CliArtifact>(`docs.${action}` as OperationName, { id });
			render.call(this, artifact, artifactLabel(artifact));
		},
		parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Document id", parse: String, placeholder: "id" }] } },
		docs: { brief: `${action[0]!.toUpperCase()}${action.slice(1)} a Doc` },
	});
}

const linkCommand = buildCommand({
	func: async function (this: DocsContext, _flags: Record<string, never>, id: string, relation: string, targetId: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("docs.link", { id, relation, target_id: targetId });
		render.call(this, artifact, `Linked ${id} --${relation}--> ${targetId}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Document id", parse: String, placeholder: "id" },
				{ brief: "Relation name", parse: String, placeholder: "relation" },
				{ brief: "Target artifact id", parse: String, placeholder: "target-id" },
			],
		},
	},
	docs: { brief: "Link a Doc to another artifact" },
});

const updateCommand = buildCommand({
	func: async function (this: DocsContext, flags: { title?: string; body?: string; labelsJson?: string[] }, id: string) {
		if (flags.title === undefined && flags.body === undefined && flags.labelsJson === undefined)
			throw new Error("docs update requires --title, --body, or --labels-json");
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("docs.update", {
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
		positional: { kind: "tuple", parameters: [{ brief: "Document id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Change a Doc's title/body/labels" },
});

const app = buildApplication(
	buildRouteMap({
		routes: {
			create: createCommand,
			list: listCommand,
			"assign-project": assignProjectCommand,
			scope: scopeCommand,
			"set-global": setGlobalCommand,
			"add-project": addProjectCommand,
			"remove-project": removeProjectCommand,
			"replace-projects": replaceProjectsCommand,
			show: showCommand,
			activate: buildStatusTransitionCommand("activate"),
			archive: buildStatusTransitionCommand("archive"),
			reopen: buildStatusTransitionCommand("reopen"),
			link: linkCommand,
			update: updateCommand,
		},
		docs: { brief: "Doc operations" },
	}),
	{ name: "docs", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runDocsCli(args: string[], client: DocsClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
