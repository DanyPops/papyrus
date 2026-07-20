import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { ArtifactCard } from "./artifact-card.ts";
import { ArtifactListCard, TaskHierarchyPreview } from "./artifact-list.ts";
import { parsePapyrusToolDetails, type PapyrusToolDetails } from "./render-model.ts";

const CALL_VALUE_MAX_CHARACTERS = 80;

export interface PapyrusToolRenderContext {
	lastComponent: Component | undefined;
	isError: boolean;
}

function primaryArgument(args: Record<string, unknown>): string | undefined {
	for (const key of ["id", "title", "text", "query", "kind", "template_id"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.slice(0, CALL_VALUE_MAX_CHARACTERS);
	}
	return undefined;
}

/** Compact native call header that never echoes bodies or structured payloads. */
export function renderPapyrusToolCall(label: string, args: Record<string, unknown>, theme: Theme): Component {
	const action = typeof args.action === "string" ? args.action : "call";
	const primary = primaryArgument(args);
	const text = [
		theme.fg("toolTitle", theme.bold(label)),
		theme.fg("muted", action),
		...(primary ? [theme.fg("accent", primary)] : []),
	].join("  ");
	return new Text(text, 0, 0);
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
		.map((entry) => entry.text)
		.join("\n");
}

function simpleDetailsText(details: Exclude<PapyrusToolDetails, { kind: "artifact" | "artifact-list" | "graph" }>): string {
	switch (details.kind) {
		case "transition":
			return `✓ ${details.artifact.id}  ${details.fromStatus} → ${details.toStatus}\n${details.artifact.title}`;
		case "gate-run": {
			const passed = details.gates.filter((gate) => gate.passed).length;
			return [
				`${passed}/${details.gates.length} gates passed for ${details.artifactId}`,
				...details.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.type}: ${gate.target}${gate.output ? ` — ${gate.output}` : ""}`),
			].join("\n");
		}
		case "invocation":
			return [
				`✓ Run ${details.runId}`,
				`${details.created.tasks.length} tasks · ${details.created.docs.length} docs · ${details.created.rules.length} rules`,
				...(details.created.roots.length ? [`Roots: ${details.created.roots.join(", ")}`] : []),
			].join("\n");
		case "preview":
			return `${details.title}\n${details.content}${details.completeness.truncated ? `\n[truncated ${details.completeness.omitted} characters]` : ""}`;
		case "error":
			return `${details.code}: ${details.message}`;
	}
}

/** Render structured details for humans while preserving compact model content as fallback. */
export function renderPapyrusToolResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PapyrusToolRenderContext,
): Component {
	if (options.isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
	const details = parsePapyrusToolDetails(result.details);
	if (!details) return new Text(theme.fg("toolOutput", textContent(result)), 0, 0);

	if (details.kind === "artifact") {
		const previous = context.lastComponent instanceof ArtifactCard ? context.lastComponent : undefined;
		if (previous) {
			previous.update(details, theme, options.expanded);
			return previous;
		}
		return new ArtifactCard(details, theme, options.expanded);
	}
	if (details.kind === "artifact-list") {
		const previous = context.lastComponent instanceof ArtifactListCard ? context.lastComponent : undefined;
		if (previous) {
			previous.update(details, theme, options.expanded);
			return previous;
		}
		return new ArtifactListCard(details, theme, options.expanded);
	}
	if (details.kind === "graph") {
		const previous = context.lastComponent instanceof TaskHierarchyPreview ? context.lastComponent : undefined;
		if (previous) {
			previous.update(details, theme, options.expanded);
			return previous;
		}
		return new TaskHierarchyPreview(details, theme, options.expanded);
	}

	const color = details.kind === "error" || context.isError ? "error" : "toolOutput";
	return new Text(theme.fg(color, simpleDetailsText(details)), 0, 0);
}
