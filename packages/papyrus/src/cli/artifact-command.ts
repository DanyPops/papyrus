import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type ArtifactClient = Pick<PapyrusClient, "call">;

interface ArtifactContext extends CommandContext {
	readonly client: ArtifactClient;
	readonly json: boolean;
	readonly projectRoot: string;
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

function render(this: ArtifactContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const createCommand = buildCommand({
	func: async function (
		this: ArtifactContext,
		flags: {
			kind?: string;
			title?: string;
			body?: string;
			status?: string;
			subtype?: string;
			labelsJson?: string[];
			extraJson?: Record<string, unknown>;
			templateId?: string;
		},
	) {
		if (!flags.kind && !flags.templateId) throw new Error("artifact create requires --kind (or --template-id)");
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("artifact.create", {
			kind: flags.kind,
			title: flags.title,
			body: flags.body,
			status: flags.status,
			subtype: flags.subtype,
			labels: flags.labelsJson,
			extra: flags.extraJson,
			template_id: flags.templateId,
			...(flags.kind === "task" ? { project_root: this.projectRoot } : {}),
		});
		render.call(this, artifact, `Created: ${artifactLabel(artifact)}`);
	},
	parameters: {
		flags: {
			kind: { brief: "Artifact kind", kind: "parsed", parse: String, placeholder: "kind", optional: true },
			title: { brief: "Title", kind: "parsed", parse: String, placeholder: "text", optional: true },
			body: { brief: "Body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			status: { brief: "Initial status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			subtype: { brief: "Subtype", kind: "parsed", parse: String, placeholder: "text", optional: true },
			labelsJson: { brief: "JSON string array of labels", kind: "parsed", parse: parseStringArray, placeholder: "json", optional: true },
			extraJson: { brief: "JSON object of extra fields", kind: "parsed", parse: parseObject, placeholder: "json", optional: true },
			templateId: { brief: "Template to instantiate from", kind: "parsed", parse: String, placeholder: "id", optional: true },
		},
	},
	docs: { brief: "Create an artifact of any kind" },
});

const queryCommand = buildCommand({
	func: async function (this: ArtifactContext, flags: { kind?: string; status?: string; text?: string; limit?: number }) {
		const rows = await this.client.call<Record<string, unknown>, CliArtifact[]>("artifact.query", {
			kind: flags.kind,
			status: flags.status,
			text: flags.text,
			limit: flags.limit,
		});
		render.call(this, rows, rows.length === 0 ? "No artifacts found." : rows.map((row) => artifactLabel(row)).join("\n"));
	},
	parameters: {
		flags: {
			kind: { brief: "Filter by kind", kind: "parsed", parse: String, placeholder: "kind", optional: true },
			status: { brief: "Filter by status", kind: "parsed", parse: String, placeholder: "status", optional: true },
			text: { brief: "Substring match against title/body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum artifacts to return", kind: "parsed", parse: numberParser, optional: true },
		},
	},
	docs: { brief: "Query artifacts across every kind" },
});

const showCommand = buildCommand({
	func: async function (this: ArtifactContext, flags: { depth?: number; maxNodes?: number }, id: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("artifact.show", {
			id,
			depth: flags.depth,
			max_nodes: flags.maxNodes,
		});
		render.call(this, artifact, `${artifactLabel(artifact)}\n\n${artifact.body ?? ""}`);
	},
	parameters: {
		flags: {
			depth: { brief: "Edge traversal depth", kind: "parsed", parse: numberParser, optional: true },
			maxNodes: { brief: "Maximum traversed nodes", kind: "parsed", parse: numberParser, optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Show one artifact by id, regardless of kind" },
});

const removeCommand = buildCommand({
	func: async function (this: ArtifactContext, flags: { reason?: string }, id: string) {
		const record = await this.client.call<
			Record<string, unknown>,
			{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string }
		>("artifact.remove", { id, reason: flags.reason });
		render.call(this, record, `Trashed ${record.artifactId}: eligible for purge at ${record.purgeAfter}`);
	},
	parameters: {
		flags: { reason: { brief: "Why this artifact was removed", kind: "parsed", parse: String, placeholder: "text", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Move an artifact to a time-gated trash" },
});

const removeSubtreeCommand = buildCommand({
	func: async function (this: ArtifactContext, flags: { reason?: string }, id: string) {
		const outcome = await this.client.call<Record<string, unknown>, { removed: string[]; skipped: string[] }>("artifact.remove_subtree", {
			id,
			reason: flags.reason,
		});
		render.call(
			this,
			outcome,
			`Trashed ${outcome.removed.length} artifact(s)${outcome.skipped.length > 0 ? `, skipped ${outcome.skipped.length} already-trashed` : ""}.`,
		);
	},
	parameters: {
		flags: { reason: { brief: "Why this subtree was removed", kind: "parsed", parse: String, placeholder: "text", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Trash an artifact and its whole contains subtree" },
});

const restoreCommand = buildCommand({
	func: async function (this: ArtifactContext, _flags: Record<string, never>, id: string) {
		const outcome = await this.client.call<Record<string, unknown>, { restored: boolean }>("artifact.restore", { id });
		render.call(this, outcome, outcome.restored ? `Restored ${id}` : `${id} was not trashed`);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Restore a trashed artifact" },
});

const trashStatusCommand = buildCommand({
	func: async function (this: ArtifactContext, _flags: Record<string, never>, id: string) {
		const record = await this.client.call<
			Record<string, unknown>,
			{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string } | null
		>("artifact.trash_status", { id });
		render.call(
			this,
			record,
			record ? `${record.artifactId}: trashed at ${record.trashedAt}, purge eligible at ${record.purgeAfter}` : `${id} is not trashed`,
		);
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show one artifact's trash status" },
});

const trashListCommand = buildCommand({
	func: async function (this: ArtifactContext) {
		const rows = await this.client.call<
			Record<string, unknown>,
			Array<{ artifactId: string; trashedAt: string; purgeAfter: string; reason?: string }>
		>("artifact.trash_list", {});
		render.call(
			this,
			rows,
			rows.length === 0 ? "Trash is empty." : rows.map((row) => `${row.artifactId}: purge eligible at ${row.purgeAfter}`).join("\n"),
		);
	},
	parameters: { flags: {} },
	docs: { brief: "List every trashed artifact" },
});

const app = buildApplication(
	buildRouteMap({
		routes: {
			create: createCommand,
			query: queryCommand,
			show: showCommand,
			remove: removeCommand,
			"remove-subtree": removeSubtreeCommand,
			restore: restoreCommand,
			"trash-status": trashStatusCommand,
			"trash-list": trashListCommand,
		},
		docs: { brief: "Artifact operations" },
	}),
	{ name: "artifact", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runArtifactCli(args: string[], client: ArtifactClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json, projectRoot });
}
