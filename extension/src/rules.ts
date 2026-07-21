import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/domain/artifact.ts";
import { showArtifactBrowser, showArtifactDetails } from "./artifact-browser.ts";
import { RULE_STATUS_PRESENTATION, severityColor } from "./artifact-status-presentation.ts";
import { callService } from "./service-client.ts";

export function ruleRowMeta(rule: Artifact, theme: Theme): string {
	const severity = typeof rule.extra["severity"] === "string" ? rule.extra["severity"] : "info";
	const severityText = theme.fg(severityColor(severity), severity.toUpperCase());
	const condition = typeof rule.extra["condition"] === "string" ? `when ${rule.extra["condition"]}` : "always";
	return `${severityText} · ${condition}`;
}

export function ruleInjectionPreview(rule: Pick<Artifact, "title" | "body" | "extra">): string {
	const condition = typeof rule.extra["condition"] === "string" ? ` (when: ${rule.extra["condition"]})` : "";
	const action = rule.body || (typeof rule.extra["action"] === "string" ? rule.extra["action"] : "");
	return `• ${rule.title}${condition}\n  ${action}`;
}

export async function showRules(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "rule",
		title: "Rules",
		listOperation: "rules.list",
		statusOrder: ["active", "deprecated"],
		presentation: RULE_STATUS_PRESENTATION,
		rowMeta: ruleRowMeta,
		actions: (rule) => ["Show details", "Preview injection", "Link gated task", rule.status === "active" ? "Disable" : "Enable"],
		handleAction: async (choice, rule, commandCtx) => {
			if (choice === "Show details") await showArtifactDetails(commandCtx, rule.id, "rules.show");
			else if (choice === "Preview injection") {
				const preview = await callService<Record<string, unknown>, string>("rules.preview", { id: rule.id });
				commandCtx.ui.notify(preview, "info");
			} else if (choice === "Link gated task") {
				const taskId = await commandCtx.ui.input("Task artifact id:", "");
				if (taskId) await callService("rules.gate", { id: rule.id, task_id: taskId });
			} else {
				const operation = choice === "Disable" ? "rules.disable" : "rules.enable";
				const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: rule.id });
				commandCtx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
			}
		},
	});
}
