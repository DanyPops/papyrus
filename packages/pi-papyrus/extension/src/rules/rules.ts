import type { Artifact } from "@danypops/papyrus";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { artifactActivationEnabled, showArtifactBrowser, showArtifactDetails } from "../artifact/artifact-browser.ts";
import { RULE_STATUS_PRESENTATION, severityColor } from "../artifact/artifact-status-presentation.ts";
import { parseLabelInput } from "../artifact/binder-navigation.ts";
import { callService } from "../service-client.ts";

export function ruleRowMeta(rule: Artifact, theme: Theme): string {
	const severity = typeof rule.extra?.severity === "string" ? rule.extra.severity : "info";
	const severityText = theme.fg(severityColor(severity), severity.toUpperCase());
	const condition = typeof rule.extra?.condition === "string" ? `when ${rule.extra.condition}` : "always";
	return `${severityText} · ${condition}`;
}

export function ruleInjectionPreview(rule: Pick<Artifact, "title" | "body" | "extra">): string {
	const condition = typeof rule.extra.condition === "string" ? ` (when: ${rule.extra.condition})` : "";
	const action = rule.body || (typeof rule.extra.action === "string" ? rule.extra.action : "");
	return `• ${rule.title}${condition}\n  ${action}`;
}

export async function showRules(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "rule",
		title: "Rules",
		listOperation: "rules.list",
		statusOrder: ["active", "deprecated"],
		presentation: RULE_STATUS_PRESENTATION,
		hierarchical: true,
		rowMeta: ruleRowMeta,
		actions: (rule) => [
			"Show details",
			"Edit",
			"Preview injection",
			"Toggle activation flag",
			"Link gated task",
			rule.status === "active" ? "Disable" : "Enable",
		],
		handleAction: async (choice, rule, commandCtx) => {
			if (choice === "Show details") await showArtifactDetails(commandCtx, rule.id, "rules.show");
			else if (choice === "Edit") {
				const current = await callService<Record<string, unknown>, Artifact>("rules.show", { id: rule.id });
				const title = await commandCtx.ui.input("Title:", current.title);
				if (title === undefined) return; // canceled
				const body = await commandCtx.ui.input("Body:", current.body);
				if (body === undefined) return; // canceled
				const labels = await commandCtx.ui.input("Direct labels (comma-separated):", current.labels.join(", "));
				if (labels === undefined) return; // canceled
				const updated = await callService<Record<string, unknown>, Artifact>("rules.update", {
					id: rule.id,
					title,
					body,
					labels: parseLabelInput(labels),
				});
				commandCtx.ui.notify(`Updated "${updated.title}"`, "info");
			} else if (choice === "Preview injection") {
				const result = await callService<Record<string, unknown>, { preview: string; combinedLength: number; warning?: string }>(
					"rules.preview",
					{ id: rule.id },
				);
				const text = result.warning === undefined ? result.preview : `${result.preview}\n\n⚠ ${result.warning}`;
				commandCtx.ui.notify(text, result.warning === undefined ? "info" : "warning");
			} else if (choice === "Toggle activation flag") {
				const current = await callService<Record<string, unknown>, Artifact>("rules.show", { id: rule.id });
				const enabled = artifactActivationEnabled(current);
				await callService("rules.update", { id: rule.id, activation_enabled: !enabled });
				commandCtx.ui.notify(`${current.title} activation ${enabled ? "paused" : "resumed"}`, "info");
			} else if (choice === "Link gated task") {
				const taskId = await commandCtx.ui.input("Task artifact id:", "");
				if (taskId) await callService("rules.gate", { id: rule.id, task_id: taskId });
			} else {
				const operation = choice === "Disable" ? "rules.disable" : "rules.enable";
				const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: rule.id });
				commandCtx.ui.notify(`${updated.title} → [${updated.status}]`, "info");
			}
		},
	});
}
