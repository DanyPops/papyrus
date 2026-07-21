import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/domain/artifact.ts";
import { showArtifactBrowser, showArtifactDetails } from "./artifact-browser.ts";
import { DOC_STATUS_PRESENTATION } from "./artifact-status-presentation.ts";
import { callService } from "./service-client.ts";

const DOC_ACTIONS: Record<string, string[]> = {
	draft: ["Activate", "Archive"],
	active: ["Archive"],
	archived: ["Reopen"],
};
const DOC_RELATIONS = ["references", "documents", "supersedes", "relates_to", "contains", "part_of"];

export function documentRowMeta(document: Artifact, theme: Theme): string {
	const subtype = document.subtype ? theme.fg("accent", document.subtype) : "";
	return [subtype, document.labels.join(", ")].filter(Boolean).join(" · ");
}

export async function showDocs(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "doc",
		title: "Documents",
		listOperation: "docs.list",
		statusOrder: ["draft", "active", "archived"],
		presentation: DOC_STATUS_PRESENTATION,
		rowMeta: documentRowMeta,
		actions: (document) => ["Show details", "Link artifact", ...(DOC_ACTIONS[document.status] ?? [])],
		handleAction: async (choice, document, commandCtx) => {
			if (choice === "Show details") {
				await showArtifactDetails(commandCtx, document.id, "docs.show");
				return;
			}
			if (choice === "Link artifact") {
				const targetId = await commandCtx.ui.input("Target artifact id:", "");
				if (!targetId) return;
				const relation = await commandCtx.ui.select("Relation", DOC_RELATIONS);
				if (!relation) return;
				await callService("docs.link", { id: document.id, relation, target_id: targetId });
				commandCtx.ui.notify(`Linked ${document.id} --${relation}--> ${targetId}`, "info");
				return;
			}
			const operation = choice === "Activate" ? "docs.activate" : choice === "Archive" ? "docs.archive" : choice === "Reopen" ? "docs.reopen" : undefined;
			if (operation) {
				const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: document.id });
				commandCtx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
			}
		},
	});
}
