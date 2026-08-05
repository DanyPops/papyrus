import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import type { PapyrusClient } from "../client.ts";
import type { NoteHistoryPage } from "../domain/note-event.ts";
import { artifactLabel, type CliArtifact } from "./shared.ts";
import { runStricliToString } from "./stricli-run.ts";

type NoteClient = Pick<PapyrusClient, "call">;

interface NoteContext extends CommandContext {
	readonly client: NoteClient;
	readonly json: boolean;
	readonly projectRoot: string;
}

function renderResult(this: NoteContext, result: unknown, human: string): void {
	this.process.stdout.write(this.json ? JSON.stringify(result) : human);
}

const captureCommand = buildCommand({
	func: async function (this: NoteContext, flags: { title?: string }, request: string) {
		const result = (await this.client.call("notes.capture", {
			body: request,
			...(flags.title ? { title: flags.title } : {}),
			project_root: this.projectRoot,
			actor: "human",
			source: "cli",
		})) as CliArtifact;
		renderResult.call(this, result, `Captured: ${artifactLabel(result)}`);
	},
	parameters: {
		flags: { title: { brief: "Optional title", kind: "parsed", parse: String, placeholder: "text", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Request text to capture", parse: String, placeholder: "request" }] },
	},
	docs: { brief: "Capture a deferred request as a note, without creating work" },
});

const listCommand = buildCommand({
	func: async function (this: NoteContext, flags: { status?: string; text?: string; limit?: number }) {
		const result = (await this.client.call("notes.list", {
			project_root: this.projectRoot,
			...(flags.status ? { status: flags.status } : {}),
			...(flags.text ? { text: flags.text } : {}),
			...(flags.limit === undefined ? {} : { limit: flags.limit }),
		})) as CliArtifact[];
		renderResult.call(
			this,
			result,
			result.length > 0 ? result.map((note) => `[${note.status}] ${artifactLabel(note)}`).join("\n") : "No open notes.",
		);
	},
	parameters: {
		flags: {
			status: { brief: "Filter by status (draft|active|archived)", kind: "parsed", parse: String, placeholder: "status", optional: true },
			text: { brief: "Substring match against title/body", kind: "parsed", parse: String, placeholder: "text", optional: true },
			limit: { brief: "Maximum notes to return", kind: "parsed", parse: numberParser, optional: true },
		},
	},
	docs: { brief: "List open (draft/active) notes, or a specific status" },
});

const showCommand = buildCommand({
	func: async function (this: NoteContext, _flags: Record<string, never>, id: string) {
		const result = (await this.client.call("notes.show", { id, project_root: this.projectRoot })) as CliArtifact;
		renderResult.call(this, result, `${artifactLabel(result)}\n\n${result.body ?? ""}`.trimEnd());
	},
	parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "Note id", parse: String, placeholder: "id" }] } },
	docs: { brief: "Show one note" },
});

const historyCommand = buildCommand({
	func: async function (this: NoteContext, flags: { limit?: number }, id: string) {
		const page = await this.client.call<Record<string, unknown>, NoteHistoryPage>("notes.history", {
			id,
			project_root: this.projectRoot,
			direction: "desc",
			...(flags.limit === undefined ? {} : { limit: flags.limit }),
		});
		const human =
			page.events.length === 0
				? `No recorded history for ${id}.`
				: [...page.events]
						.reverse()
						.map(
							(event) =>
								`${event.occurredAt} ${event.type} · ${event.actor}/${event.source}${event.relatedId ? ` · ${event.relatedId}` : ""}${event.disposition ? ` · ${event.disposition}` : ""}${event.reason ? ` · ${event.reason}` : ""}`,
						)
						.join("\n");
		renderResult.call(this, page, human);
	},
	parameters: {
		flags: { limit: { brief: "Maximum events to return", kind: "parsed", parse: numberParser, optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Note id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "This note's own event history" },
});

const consumeCommand = buildCommand({
	func: async function (this: NoteContext, flags: { reason?: string }, id: string) {
		const result = (await this.client.call("notes.consume", {
			id,
			project_root: this.projectRoot,
			actor: "agent",
			source: "cli",
			...(flags.reason ? { reason: flags.reason } : {}),
		})) as CliArtifact;
		renderResult.call(this, result, `Consumed: ${artifactLabel(result)}`);
	},
	parameters: {
		flags: { reason: { brief: "Why this note was considered", kind: "parsed", parse: String, placeholder: "text", optional: true } },
		positional: { kind: "tuple", parameters: [{ brief: "Note id", parse: String, placeholder: "id" }] },
	},
	docs: { brief: "Mark a note as considered" },
});

const promoteCommand = buildCommand({
	func: async function (this: NoteContext, flags: { reason?: string }, id: string, targetId: string) {
		const result = (await this.client.call("notes.promote", {
			id,
			target_id: targetId,
			project_root: this.projectRoot,
			actor: "agent",
			source: "cli",
			...(flags.reason ? { reason: flags.reason } : {}),
		})) as CliArtifact;
		renderResult.call(this, result, `Promoted: ${artifactLabel(result)} → ${targetId}`);
	},
	parameters: {
		flags: { reason: { brief: "Why this note was promoted", kind: "parsed", parse: String, placeholder: "text", optional: true } },
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Note id", parse: String, placeholder: "id" },
				{ brief: "Target artifact id it was promoted into", parse: String, placeholder: "target-id" },
			],
		},
	},
	docs: { brief: "Link a note to the artifact it was promoted into, then archive it" },
});

const archiveCommand = buildCommand({
	func: async function (this: NoteContext, flags: { reason?: string }, id: string, disposition: string) {
		const result = (await this.client.call("notes.archive", {
			id,
			disposition,
			project_root: this.projectRoot,
			actor: "human",
			source: "cli",
			...(flags.reason ? { reason: flags.reason } : {}),
		})) as CliArtifact;
		renderResult.call(this, result, `Archived: ${artifactLabel(result)} · ${disposition}`);
	},
	parameters: {
		flags: { reason: { brief: "Why this note was archived", kind: "parsed", parse: String, placeholder: "text", optional: true } },
		positional: {
			kind: "tuple",
			parameters: [
				{ brief: "Note id", parse: String, placeholder: "id" },
				{ brief: "completed|duplicate|declined|superseded", parse: String, placeholder: "disposition" },
			],
		},
	},
	docs: { brief: "Archive a note with an explicit disposition" },
});

const app = buildApplication(
	buildRouteMap({
		routes: {
			capture: captureCommand,
			list: listCommand,
			show: showCommand,
			history: historyCommand,
			consume: consumeCommand,
			promote: promoteCommand,
			archive: archiveCommand,
		},
		docs: { brief: "Note operations" },
	}),
	{ name: "notes", scanner: { caseStyle: "allow-kebab-for-camel" } },
);

export async function runNoteCli(args: string[], client: NoteClient, projectRoot: string = process.cwd()): Promise<string> {
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	return runStricliToString(app, positional, { client, json, projectRoot });
}
