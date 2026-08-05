import type { Artifact } from "@danypops/papyrus";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { showArtifactBrowser, showArtifactDetails } from "../artifact/artifact-browser.ts";
import { PLAYBOOK_STATUS_PRESENTATION } from "../artifact/artifact-status-presentation.ts";
import { matchArtifactByName } from "../domain-tools.ts";
import { callService } from "../service-client.ts";

const PLAYBOOK_COMPLETION_MAX_CANDIDATES = 100;

async function activePlaybooks(): Promise<Artifact[]> {
	return callService<Record<string, unknown>, Artifact[]>("playbooks.list", {
		status: "active",
		limit: PLAYBOOK_COMPLETION_MAX_CANDIDATES,
	});
}

/** `/playbook <tab>` completions -- title-prefix match, since that's what a human actually types, not a full-text search of body content. */
export async function playbookArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	try {
		const needle = argumentPrefix.trim().toLowerCase();
		const rows = await activePlaybooks();
		return rows
			.filter((row) => row.title.toLowerCase().startsWith(needle))
			.sort((a, b) => a.title.localeCompare(b.title))
			.map((row) => ({
				value: row.title,
				label: row.title,
				description: typeof row.extra.trigger === "string" ? row.extra.trigger : undefined,
			}));
	} catch {
		return null; // a Papyrus daemon hiccup degrades to "no suggestions", never breaks the command line
	}
}

interface PlaybookInvocationResponse {
	entryTaskId?: string;
	missingArguments?: string[];
}

/** Shared by /playbook <name> and the browser's own "Invoke" action: materializes real Tasks and focuses the entry one, then reports it -- invoke no longer returns rendered text (that's playbooks.preview now). */
async function invokeAndReport(id: string, label: string, ctx: ExtensionCommandContext): Promise<void> {
	const invocation = await callService<Record<string, unknown>, PlaybookInvocationResponse>("playbooks.invoke", { id });
	if (invocation.missingArguments) {
		ctx.ui.notify(`"${label}" needs: ${invocation.missingArguments.join(", ")}`, "error");
		return;
	}
	ctx.ui.setEditorText(`Run the "${label}" playbook -- work on the currently focused task.`);
	ctx.ui.notify(`"${label}" invoked: entry task ${invocation.entryTaskId} focused`, "info");
}

/** `/playbook <name>` (no args opens the full browser instead): resolves by exact title, then invokes it directly -- one step, not browse-then-select-then-invoke. */
export async function openPlaybookByName(name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!name.trim()) {
		await showPlaybooks(ctx);
		return;
	}
	try {
		const id = matchArtifactByName(await activePlaybooks(), name);
		await invokeAndReport(id, name.trim(), ctx);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

const PLAYBOOK_RELATIONS = ["references", "documents", "relates_to", "contains", "part_of"];

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function playbookRowMeta(playbook: Artifact): string {
	const trigger = typeof playbook.extra.trigger === "string" ? `when ${playbook.extra.trigger}` : "manual invocation";
	const tools = strings(playbook.extra.tools);
	return [trigger, tools.join(", ")].filter(Boolean).join(" \u00b7 ");
}

export async function showPlaybooks(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "playbook",
		title: "Playbooks",
		listOperation: "playbooks.list",
		statusOrder: ["active", "deprecated"],
		presentation: PLAYBOOK_STATUS_PRESENTATION,
		rowMeta: playbookRowMeta,
		actions: (playbook) => ["Show details", "Edit", "Invoke", "Link artifact", playbook.status === "active" ? "Disable" : "Enable"],
		handleAction: async (choice, playbook, commandCtx) => {
			if (choice === "Show details") {
				await showArtifactDetails(commandCtx, playbook.id, "playbooks.show");
				return;
			}
			if (choice === "Edit") {
				const title = await commandCtx.ui.input("Title:", playbook.title);
				if (title === undefined) return; // canceled
				const body = await commandCtx.ui.input("Body:", playbook.body);
				if (body === undefined) return; // canceled
				const updated = await callService<Record<string, unknown>, Artifact>("playbooks.update", { id: playbook.id, title, body });
				commandCtx.ui.notify(`Updated "${updated.title}"`, "info");
				return;
			}
			if (choice === "Invoke") {
				await invokeAndReport(playbook.id, playbook.title, commandCtx);
				return;
			}
			if (choice === "Link artifact") {
				const targetId = await commandCtx.ui.input("Target artifact id:", "");
				if (!targetId) return;
				const relation = await commandCtx.ui.select("Relation", PLAYBOOK_RELATIONS);
				if (!relation) return;
				await callService("graph.link", { from: playbook.id, relation, to: targetId });
				commandCtx.ui.notify(`Linked "${playbook.title}" via ${relation}`, "info");
				return;
			}
			const operation = choice === "Disable" ? "playbooks.disable" : "playbooks.enable";
			const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: playbook.id });
			commandCtx.ui.notify(`${updated.title} \u2192 [${updated.status}]`, "info");
		},
	});
}
