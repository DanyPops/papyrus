import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type PapyrusToolRenderContext,
	renderPapyrusToolCall,
	renderPapyrusToolResult,
} from "../extension/src/tool-rendering/index.ts";
import {
	createArtifactDetails,
	createArtifactListDetails,
	createErrorDetails,
	createGateRunDetails,
	createGraphDetails,
	createInvocationDetails,
	createPreviewDetails,
	createTransitionDetails,
} from "../extension/src/tool-rendering/render-model.ts";
import type { Artifact } from "../src/domain/artifact.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function artifact(index = 1): Artifact {
	return {
		id: `task-${index}`,
		kind: "task",
		title: `Task ${index}`,
		status: index === 1 ? "todo" : "done",
		subtype: "architecture",
		body: "# Body\n\nContext mesh details.",
		labels: ["papyrus"],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function context(lastComponent?: unknown, _isPartial = false, isError = false): PapyrusToolRenderContext {
	return {
		lastComponent: lastComponent as PapyrusToolRenderContext["lastComponent"],
		isError,
	};
}

function result(details: unknown, content = "compact model result"): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

describe("Papyrus native tool rendering", () => {
	it("renders compact calls without echoing bodies", () => {
		const component = renderPapyrusToolCall("Tasks", { action: "create", id: "task-1", body: "private long body" }, theme);
		const output = component.render(40).join("\n");
		expect(output).toContain("Tasks");
		expect(output).toContain("create");
		expect(output).toContain("task-1");
		expect(output).not.toContain("private long body");
	});

	it("renders every typed outcome independently of model content", () => {
		const outcomes = [
			createArtifactDetails("tasks.show", artifact()),
			createArtifactListDetails("tasks.list", [artifact(1), artifact(2)]),
			createTransitionDetails("tasks.start", { ...artifact(), status: "in-progress" }, "todo", "in-progress"),
			createGraphDetails("tasks.graph", [artifact(1), artifact(2)], [{ from: "task-1", relation: "contains", to: "task-2" }]),
			createGateRunDetails("tasks.run_gates", "task-1", "Ship the feature", [{ passed: true, type: "command", target: "bun test", output: "ok" }]),
			createInvocationDetails("skills.run", "run-1", { tasks: ["task-1"], docs: ["doc-1"], rules: [], roots: ["task-1"] }),
			createPreviewDetails("rules.preview", "Rule preview", "Use the typed boundary."),
			createErrorDetails("tasks.show", "NOT_FOUND", "Task not found."),
		];
		for (const details of outcomes) {
			const component = renderPapyrusToolResult(result(details, "MODEL_ONLY_SENTINEL"), { expanded: true, isPartial: false }, theme, context());
			const lines = component.render(40);
			expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
			expect(lines.join("\n")).not.toContain("MODEL_ONLY_SENTINEL");
		}
	});

	it("prefers name over id in the compact call header, since id is a backend detail", () => {
		const byName = renderPapyrusToolCall("Tasks", { action: "show", name: "Fix the thing", id: "1307c008-7326-47fa-9551-9529aff1592c" }, theme);
		expect(byName.render(60).join("\n")).toContain("Fix the thing");
		expect(byName.render(60).join("\n")).not.toContain("1307c008");

		// id is still shown when it's genuinely the only identifying argument given.
		const byIdOnly = renderPapyrusToolCall("Tasks", { action: "show", id: "1307c008-7326-47fa-9551-9529aff1592c" }, theme);
		expect(byIdOnly.render(60).join("\n")).toContain("1307c008");
	});

	it("never echoes a raw artifact id in gate-run or transition summary text -- title only", () => {
		const gateRun = createGateRunDetails("tasks.run_gates", "6c6c7445-9c2a-41db-9b40-809d07432430", "Ship the diagnostics", []);
		const gateRunOutput = renderPapyrusToolResult(result(gateRun), { expanded: true, isPartial: false }, theme, context()).render(60).join("\n");
		expect(gateRunOutput).toContain("Ship the diagnostics");
		expect(gateRunOutput).not.toContain("6c6c7445");

		const transition = createTransitionDetails("tasks.start", artifact(), "todo", "in-progress");
		const transitionOutput = renderPapyrusToolResult(result(transition), { expanded: true, isPartial: false }, theme, context()).render(60).join("\n");
		expect(transitionOutput).toContain(transition.artifact.title);
		expect(transitionOutput).not.toContain(transition.artifact.id);
	});

	it("reuses artifact components and falls back safely for legacy details", () => {
		const first = renderPapyrusToolResult(result(createArtifactDetails("tasks.show", artifact())), { expanded: false, isPartial: false }, theme, context());
		const second = renderPapyrusToolResult(result(createArtifactDetails("tasks.show", artifact())), { expanded: true, isPartial: false }, theme, context(first));
		expect(second).toBe(first);
		expect(second.render(80).join("\n")).toContain("Context mesh details");

		const fallback = renderPapyrusToolResult(result({ legacy: true }, "legacy compact fallback"), { expanded: false, isPartial: false }, theme, context());
		expect(fallback.render(80).join("\n")).toContain("legacy compact fallback");
	});

	it("renders partial and error states through their native channels", () => {
		const partial = renderPapyrusToolResult(result(undefined), { expanded: false, isPartial: true }, theme, context(undefined, true));
		expect(partial.render(80).join("\n")).toContain("Working");
		const error = renderPapyrusToolResult(result(createErrorDetails("tasks.show", "FAILED", "Unable to show task.")), { expanded: false, isPartial: false }, theme, context(undefined, false, true));
		expect(error.render(80).join("\n")).toContain("Unable to show task");
	});

	it("wires every native Papyrus tool to the dual-channel renderer and native failures", () => {
		const domainTools = readFileSync(new URL("../extension/src/domain-tools.ts", import.meta.url), "utf8");
		const lowLevelTools = readFileSync(new URL("../extension/src/index.ts", import.meta.url), "utf8");
		expect(domainTools.match(/renderCall\(/g)).toHaveLength(6);
		expect(domainTools.match(/renderResult\(/g)).toHaveLength(6);
		expect(lowLevelTools.match(/renderCall\(/g)).toHaveLength(4);
		expect(lowLevelTools.match(/renderResult\(/g)).toHaveLength(4);
		expect(`${domainTools}\n${lowLevelTools}`).not.toMatch(/return text\(`[^`]*failed:/);
		expect(domainTools).toContain("createArtifactDetails");
		expect(domainTools).toContain("createArtifactListDetails");
		expect(lowLevelTools).toContain("createGraphDetails");
	});
});
