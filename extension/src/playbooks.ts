import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/domain/artifact.ts";
import { showArtifactBrowser, showArtifactDetails } from "./artifact-browser.ts";
import { PLAYBOOK_STATUS_PRESENTATION } from "./artifact-status-presentation.ts";
import { callService } from "./service-client.ts";

const PLAYBOOK_RELATIONS = ["references", "documents", "relates_to", "contains", "part_of"];

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function playbookRowMeta(playbook: Artifact): string {
	const trigger = typeof playbook.extra["trigger"] === "string" ? `when ${playbook.extra["trigger"]}` : "manual invocation";
	const tools = strings(playbook.extra["tools"]);
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
				const invocation = await callService<Record<string, unknown>, string>("playbooks.invoke", { id: playbook.id });
				commandCtx.ui.setEditorText(invocation);
				commandCtx.ui.notify("Invocation placed in the editor", "info");
				return;
			}
			if (choice === "Link artifact") {
				const targetId = await commandCtx.ui.input("Target artifact id:", "");
				if (!targetId) return;
				const relation = await commandCtx.ui.select("Relation", PLAYBOOK_RELATIONS);
				if (!relation) return;
				await callService("graph.link", { from: playbook.id, relation, to: targetId });
				commandCtx.ui.notify(`Linked ${playbook.id} --${relation}--> ${targetId}`, "info");
				return;
			}
			const operation = choice === "Disable" ? "playbooks.disable" : "playbooks.enable";
			const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: playbook.id });
			commandCtx.ui.notify(`${updated.id} \u2192 [${updated.status}]`, "info");
		},
	});
}
