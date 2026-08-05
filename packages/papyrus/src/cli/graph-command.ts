import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { ArtifactEventPage } from "../artifact/artifact-event.ts";
import type { PapyrusClient } from "../client.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type GraphClient = Pick<PapyrusClient, "call">;

interface GraphContext extends CommandContext {
	readonly client: GraphClient;
	readonly json: boolean;
}

const linkCommand = buildCommand({
	func: async function (this: GraphContext, _flags: Record<string, never>, from: string, relation: string, to: string) {
		const result = await this.client.call<Record<string, unknown>, { ok: boolean }>("graph.link", { from, relation, to });
		this.process.stdout.write(this.json ? JSON.stringify(result) : `Linked ${from} --${relation}--> ${to}`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Source artifact id", parse: String, placeholder: "from" },
				{ brief: "Relation name", parse: String, placeholder: "relation" },
				{ brief: "Target artifact id", parse: String, placeholder: "to" },
			],
		},
	},
	docs: { brief: "Link two artifacts" },
});

const unlinkCommand = buildCommand({
	func: async function (this: GraphContext, _flags: Record<string, never>, from: string, relation: string, to: string) {
		const result = await this.client.call<Record<string, unknown>, { removed: boolean }>("graph.unlink", { from, relation, to });
		if (this.json) {
			this.process.stdout.write(JSON.stringify(result));
			return;
		}
		this.process.stdout.write(
			result.removed ? `Unlinked ${from} --${relation}--> ${to}` : `No such relationship: ${from} --${relation}--> ${to}`,
		);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Source artifact id", parse: String, placeholder: "from" },
				{ brief: "Relation name", parse: String, placeholder: "relation" },
				{ brief: "Target artifact id", parse: String, placeholder: "to" },
			],
		},
	},
	docs: { brief: "Remove a relationship between two artifacts" },
});

const treeCommand = buildCommand({
	func: async function (this: GraphContext, flags: { depth?: number; maxNodes?: number }, id: string) {
		const artifact = await this.client.call<
			Record<string, unknown>,
			CliArtifact & { edges?: Array<{ from: string; relation: string; to: string }> }
		>("graph.tree", { id, depth: flags.depth, max_nodes: flags.maxNodes });
		if (this.json) {
			this.process.stdout.write(JSON.stringify(artifact));
			return;
		}
		const edges = artifact.edges ?? [];
		this.process.stdout.write(
			edges.length === 0
				? `${artifactLabel(artifact)} — no edges`
				: `${artifactLabel(artifact)}\n${edges.map((edge) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`,
		);
	},
	parameters: {
		flags: {
			depth: { brief: "Traversal depth", kind: "parsed", parse: numberParser, optional: true },
			maxNodes: { brief: "Maximum nodes to traverse", kind: "parsed", parse: numberParser, optional: true },
		},
		positional: { kind: "tuple", parameters: [{ brief: "Artifact id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Show an artifact's relationship tree" },
});

const statusCommand = buildCommand({
	func: async function (this: GraphContext, _flags: Record<string, never>, id: string, status: string) {
		const artifact = await this.client.call<Record<string, unknown>, CliArtifact>("graph.status", { id, status });
		this.process.stdout.write(this.json ? JSON.stringify(artifact) : `Updated ${artifact.id} → [${artifact.status}]`);
	},
	parameters: {
		flags: {},
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Artifact id", parse: String, placeholder: "id" },
				{ brief: "New status", parse: String, placeholder: "status" },
			],
		},
	},
	docs: { brief: "Transition an artifact's status" },
});

const historyCommand = buildCommand({
	func: async function (
		this: GraphContext,
		flags: {
			id?: string;
			actor?: string;
			sessionId?: string;
			since?: string;
			limit?: number;
			cursor?: number;
			direction?: string;
		},
	) {
		const page = await this.client.call<Record<string, unknown>, ArtifactEventPage>("graph.history", {
			id: flags.id,
			actor: flags.actor,
			session_id: flags.sessionId,
			since: flags.since,
			limit: flags.limit,
			cursor: flags.cursor,
			direction: flags.direction,
		});
		if (this.json) {
			this.process.stdout.write(JSON.stringify(page));
			return;
		}
		if (page.events.length === 0) {
			this.process.stdout.write("No recorded events.");
			return;
		}
		this.process.stdout.write(
			page.events
				.map((event) => {
					const transition =
						event.fromStatus || event.toStatus ? ` ${event.fromStatus ?? "\u2205"} \u2192 ${event.toStatus ?? "\u2205"}` : "";
					const relation = event.relation ? ` ${event.relation} \u2192 ${event.relatedId}` : "";
					return `${event.occurredAt} ${event.artifactId} ${event.type}${transition}${relation} \u00b7 ${event.actor}/${event.source}${event.sessionId ? ` \u00b7 ${event.sessionId}` : ""}`;
				})
				.join("\n"),
		);
	},
	parameters: {
		flags: {
			id: { brief: "Filter to one artifact id", kind: "parsed", parse: String, optional: true },
			actor: { brief: "Filter to one actor", kind: "parsed", parse: String, optional: true },
			sessionId: { brief: "Filter to one session id", kind: "parsed", parse: String, optional: true },
			since: { brief: "Filter to events at or after this RFC3339 timestamp", kind: "parsed", parse: String, optional: true },
			limit: { brief: "Maximum events to return", kind: "parsed", parse: numberParser, optional: true },
			cursor: { brief: "Pagination cursor", kind: "parsed", parse: numberParser, optional: true },
			direction: { brief: "Sort direction (asc|desc)", kind: "parsed", parse: String, optional: true },
		},
	},
	docs: { brief: "Query the mutation event history" },
});

const app = buildApplication(
	buildRouteMap({
		routes: { link: linkCommand, unlink: unlinkCommand, tree: treeCommand, status: statusCommand, history: historyCommand },
		docs: { brief: "Graph operations" },
	}),
	{ name: "graph", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runGraphCli(args: string[], client: GraphClient): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json });
}
