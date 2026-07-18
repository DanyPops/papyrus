import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/ops.ts";
import {
	linkFromArtifact,
	setArtifactStatus,
	showArtifactBrowser,
	showArtifactDetails,
} from "./artifact-browser.ts";

const RULE_GLYPHS: Record<string, string> = { active: "●", deprecated: "○" };

export function ruleRowMeta(rule: Artifact): string {
	const severity = typeof rule.extra["severity"] === "string" ? rule.extra["severity"].toUpperCase() : "INFO";
	const condition = typeof rule.extra["condition"] === "string" ? `when ${rule.extra["condition"]}` : "always";
	return `${severity} · ${condition}`;
}

/** Exact text used by the active-rule system-prompt block. */
export function ruleInjectionPreview(rule: Pick<Artifact, "title" | "body" | "extra">): string {
	const condition = typeof rule.extra["condition"] === "string" ? ` (when: ${rule.extra["condition"]})` : "";
	const action = rule.body || (typeof rule.extra["action"] === "string" ? rule.extra["action"] : "");
	return `• ${rule.title}${condition}\n  ${action}`;
}

export async function showRules(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "rule",
		title: "Rules",
		statusOrder: ["active", "deprecated"],
		glyphs: RULE_GLYPHS,
		rowMeta: ruleRowMeta,
		actions: (rule) => [
			"Show details",
			"Preview injection",
			"Link gated task",
			rule.status === "active" ? "Disable → deprecated" : "Enable → active",
		],
		handleAction: async (choice, rule, commandCtx) => {
			if (choice === "Show details") await showArtifactDetails(commandCtx, rule.id);
			else if (choice === "Preview injection") commandCtx.ui.notify(ruleInjectionPreview(rule), "info");
			else if (choice === "Link gated task") await linkFromArtifact(commandCtx, rule.id, "gates");
			else if (choice === "Disable → deprecated") await setArtifactStatus(commandCtx, rule.id, "deprecated");
			else if (choice === "Enable → active") await setArtifactStatus(commandCtx, rule.id, "active");
		},
	});
}
