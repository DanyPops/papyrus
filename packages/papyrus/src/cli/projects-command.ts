import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { runStricliToString } from "./stricli-run.ts";

type ProjectsClient = Pick<PapyrusClient, "call">;

interface ProjectsContext extends CommandContext {
	readonly client: ProjectsClient;
	readonly json: boolean;
}

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("value must be a JSON string array");
	return parsed as string[];
}

interface CliProject {
	id: string;
	name: string;
	aliases: string[];
	projectRoot: string;
}

function render(this: ProjectsContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const listCommand = buildCommand({
	func: async function (this: ProjectsContext, flags: { query?: string; limit?: number }) {
		const projects = await this.client.call<Record<string, unknown>, CliProject[]>("projects.list", {
			query: flags.query,
			limit: flags.limit,
		});
		render.call(
			this,
			projects,
			projects.length === 0 ? "No registered projects." : projects.map((project) => `${project.name} — ${project.projectRoot}`).join("\n"),
		);
	},
	parameters: {
		flags: {
			query: { brief: "Filter by project name, alias, or root", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum results", kind: "parsed", parse: numberParser, placeholder: "n", optional: true },
		},
	},
	docs: { brief: "List registered projects (shared by Tasks, Docs, Rules, and Playbooks)" },
});

const resolveCommand = buildCommand({
	func: async function (this: ProjectsContext, _flags: Record<string, never>, reference: string) {
		const project = await this.client.call<Record<string, unknown>, CliProject>("projects.resolve", { reference });
		render.call(this, project, `${project.name} — ${project.projectRoot}`);
	},
	parameters: {
		flags: {},
		positional: { kind: "tuple", parameters: [{ brief: "Project id, name, alias, or root", parse: String, placeholder: "reference" }] },
	},
	docs: { brief: "Resolve a project reference to its canonical identity" },
});

const registerCommand = buildCommand({
	func: async function (this: ProjectsContext, flags: { name?: string; aliasesJson?: string[]; existingId?: string }, projectRoot: string) {
		const registered = await this.client.call<Record<string, unknown>, CliProject>("projects.register", {
			project_root: projectRoot,
			name: flags.name,
			aliases: flags.aliasesJson,
			existing_id: flags.existingId,
		});
		render.call(this, registered, `${registered.name} — ${registered.projectRoot}`);
	},
	parameters: {
		flags: {
			name: { brief: "Stable project display name", kind: "parsed", parse: String, placeholder: "name", optional: true },
			aliasesJson: { brief: "JSON string array of aliases", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			existingId: {
				brief: "Existing project id when renaming or moving",
				kind: "parsed",
				parse: String,
				placeholder: "id",
				optional: true,
			},
		},
		positional: { kind: "tuple", parameters: [{ brief: "Project root path", parse: String, placeholder: "project-root" }] },
	},
	docs: { brief: "Register a new project, or rename/move an existing one" },
});

const app = buildApplication(
	buildRouteMap({
		routes: { list: listCommand, resolve: resolveCommand, register: registerCommand },
		docs: {
			brief:
				"Shared project catalog operations (compatibility delegates: tasks projects/resolve-project/register-project do the identical thing)",
		},
	}),
	{ name: "projects", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runProjectsCli(args: string[], client: ProjectsClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
