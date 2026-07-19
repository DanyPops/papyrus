import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { SkillWorkflowRunResult } from "../../src/skill-execution.ts";
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
	if (skill.subtype === "workflow") {
		const definition = skill.extra["definition"] as Record<string, unknown> | undefined;
		const inputs = definition?.["inputs"] && typeof definition["inputs"] === "object"
			? Object.keys(definition["inputs"] as Record<string, unknown>).length
			: 0;
		const blueprints = definition?.["blueprints"] as Record<string, unknown> | undefined;
		const tasks = Array.isArray(blueprints?.["tasks"]) ? blueprints["tasks"].length : 0;
		return `workflow · ${inputs} inputs · ${tasks} tasks`;
	}
	const trigger = typeof skill.extra["trigger"] === "string" ? `when ${skill.extra["trigger"]}` : "manual";
	const tools = strings(skill.extra["tools"]);
	return [trigger, tools.join(", ")].filter(Boolean).join(" · ");
}

export function skillInvocationPrompt(skill: Artifact): string {
	if (skill.subtype === "artifact-template") {
		return [`Create an artifact using Papyrus template \"${skill.title}\".`, `template_id: ${skill.id}`, "Ask for or infer the title and all required template fields, then call papyrus_create."].join("\n");
	}
	if (skill.subtype === "workflow") {
		return [
			`Run Papyrus workflow Skill \"${skill.title}\" (${skill.id}).`,
			"Collect its required arguments, then call the skills domain tool with action=run.",
		].join("\n");
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
		actions: (skill) => [
			"Show details",
			skill.subtype === "artifact-template" ? "Use template" : skill.subtype === "workflow" ? "Run workflow" : "Invoke skill",
			skill.status === "active" ? "Disable" : "Enable",
		],
		handleAction: async (choice, skill, commandCtx) => {
			if (choice === "Show details") await showArtifactDetails(commandCtx, skill.id, "skills.show");
			else if (choice === "Run workflow") {
				const source = await commandCtx.ui.input("Workflow arguments JSON:", "{}");
				if (source === undefined) return;
				try {
					const arguments_ = JSON.parse(source) as unknown;
					if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
						throw new Error("arguments must be a JSON object");
					}
					const run = await callService<Record<string, unknown>, SkillWorkflowRunResult>("skills.run", {
						id: skill.id,
						arguments: arguments_ as Record<string, unknown>,
					});
					commandCtx.ui.notify(`Created ${run.runId} · ${run.created.tasks.length} tasks · ${run.rootTaskIds.length} ready roots`, "info");
				} catch (error) {
					commandCtx.ui.notify(`Workflow run failed: ${error instanceof Error ? error.message : error}`, "error");
				}
			} else if (choice === "Invoke skill" || choice === "Use template") {
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
