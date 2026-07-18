import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/ops.ts";
import { showArtifactBrowser, showArtifactDetails } from "./artifact-browser.ts";
import { callService } from "./service-client.ts";

const SKILL_GLYPHS: Record<string, string> = { active: "●", deprecated: "○" };

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function skillRowMeta(skill: Artifact): string {
	if (skill.subtype === "artifact-template") {
		const target = typeof skill.extra["targetKind"] === "string" ? skill.extra["targetKind"] : "artifact";
		return `template → ${target}`;
	}
	const trigger = typeof skill.extra["trigger"] === "string" ? `when ${skill.extra["trigger"]}` : "manual";
	const tools = strings(skill.extra["tools"]);
	return [trigger, tools.join(", ")].filter(Boolean).join(" · ");
}

export function skillInvocationPrompt(skill: Artifact): string {
	if (skill.subtype === "artifact-template") {
		return [`Create an artifact using Papyrus template \"${skill.title}\".`, `template_id: ${skill.id}`, "Ask for or infer the title and all required template fields, then call papyrus_create."].join("\n");
	}
	const trigger = typeof skill.extra["trigger"] === "string" ? skill.extra["trigger"] : "manual invocation";
	const steps = strings(skill.extra["steps"]);
	const tools = strings(skill.extra["tools"]);
	return [
		`Apply Papyrus skill \"${skill.title}\" (${skill.id}).`,
		`Trigger: ${trigger}`,
		...(skill.body ? [`Context: ${skill.body}`] : []),
		...(steps.length > 0 ? ["Steps:", ...steps.map((step, index) => `${index + 1}. ${step}`)] : []),
		...(tools.length > 0 ? [`Tools: ${tools.join(", ")}`] : []),
	].join("\n");
}

export async function showSkills(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "skill",
		title: "Skills",
		listOperation: "skills.list",
		statusOrder: ["active", "deprecated"],
		glyphs: SKILL_GLYPHS,
		rowMeta: skillRowMeta,
		actions: (skill) => ["Show details", skill.subtype === "artifact-template" ? "Use template" : "Invoke skill", skill.status === "active" ? "Disable" : "Enable"],
		handleAction: async (choice, skill, commandCtx) => {
			if (choice === "Show details") await showArtifactDetails(commandCtx, skill.id, "skills.show");
			else if (choice === "Invoke skill" || choice === "Use template") {
				const invocation = await callService<Record<string, unknown>, string>("skills.invoke", { id: skill.id });
				commandCtx.ui.setEditorText(invocation);
				commandCtx.ui.notify("Invocation placed in the editor", "info");
			} else {
				const operation = choice === "Disable" ? "skills.disable" : "skills.enable";
				const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: skill.id });
				commandCtx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
			}
		},
	});
}
