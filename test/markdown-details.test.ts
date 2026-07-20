import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showArtifactDetailView } from "../extension/src/artifact-detail-view.ts";
import { showTaskDetails } from "../extension/src/task-detail-view.ts";
import { createPapyrusMarkdownTheme, renderMarkdownBody } from "../extension/src/markdown.ts";
import type { Artifact } from "../src/domain/artifact.ts";

const markdown = [
	"# Themed heading",
	"",
	"Text with **bold**, *italic*, ~~removed~~, [link](https://example.test), and `inline`.",
	"",
	"> quoted text",
	"",
	"- first item",
	"- second item",
	"",
	"---",
	"",
	"```ts",
	"const value = 1;",
	"```",
	"",
	"| Name | Value |",
	"| --- | --- |",
	"| alpha | beta |",
].join("\n");

function trackingTheme() {
	const calls: string[] = [];
	const theme = {
		fg(token: string, text: string) { calls.push(token); return text; },
		bold(text: string) { calls.push("bold"); return text; },
		italic(text: string) { calls.push("italic"); return text; },
		underline(text: string) { calls.push("underline"); return text; },
		strikethrough(text: string) { calls.push("strikethrough"); return text; },
	} as unknown as Theme;
	return { theme, calls };
}

describe("Papyrus Markdown detail rendering", () => {
	it("propagates every Markdown semantic style from the active Theme", () => {
		const tracked = trackingTheme();
		let highlighted = false;
		const syntax = {
			highlightCode(code: string) { highlighted = true; return code.split("\n"); },
		} as Pick<MarkdownTheme, "highlightCode">;
		const markdownTheme = createPapyrusMarkdownTheme(() => tracked.theme, () => syntax);
		for (const key of ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet"] as const) markdownTheme[key](key);
		const lines = renderMarkdownBody(markdown, 50, () => tracked.theme, () => syntax);

		for (const token of ["mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "text"]) {
			expect(tracked.calls).toContain(token);
		}
		for (const decoration of ["bold", "italic", "underline", "strikethrough"]) expect(tracked.calls).toContain(decoration);
		expect(highlighted).toBe(true);
		expect(lines.join("\n")).not.toContain("**bold**");
		expect(lines.join("\n")).toContain("Themed heading");
		expect(lines.join("\n")).toContain("alpha");
	});

	it("keeps Markdown responsive at narrow widths and refreshes dynamic theme access", () => {
		const first = trackingTheme();
		const second = trackingTheme();
		let active = first.theme;
		const markdownTheme = createPapyrusMarkdownTheme(() => active, () => ({ highlightCode: (code: string) => code.split("\n") }));
		markdownTheme.heading("one");
		active = second.theme;
		markdownTheme.heading("two");
		expect(first.calls).toContain("mdHeading");
		expect(second.calls).toContain("mdHeading");

		const lines = renderMarkdownBody(markdown, 18, () => active, () => ({ highlightCode: (code: string) => code.split("\n") }));
		expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
	});

	it("themes generated detail chrome, metadata, and Task lifecycle semantics", async () => {
		const tracked = trackingTheme();
		const value: Artifact = {
			id: "detail-1", kind: "doc", title: "Theme detail", status: "active", subtype: "research",
			body: markdown, labels: ["theme"], extra: { owner: "human" },
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		};
		const ctx = {
			mode: "tui", hasUI: true, ui: {
				theme: tracked.theme,
				async custom(factory: any) {
					const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, tracked.theme, {}, () => {});
					component.render(60);
				},
			},
		} as unknown as ExtensionCommandContext;
		await showArtifactDetailView(ctx, value);
		await showTaskDetails(ctx, { ...value, kind: "task", subtype: "", status: "in-progress" });
		for (const token of ["accent", "borderMuted", "muted", "dim", "text", "warning"]) expect(tracked.calls).toContain(token);
	});

	it("re-renders the viewport from a changed active theme after invalidation", async () => {
		const first = trackingTheme();
		const second = trackingTheme();
		let active = first.theme;
		const value: Artifact = {
			id: "reload-1", kind: "doc", title: "Reload", status: "active", subtype: "research",
			body: "# Theme reload", labels: [], extra: {},
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		};
		const ctx = {
			mode: "tui", hasUI: true, ui: {
				get theme() { return active; },
				async custom(factory: any) {
					const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, active, {}, () => {});
					component.render(50);
					active = second.theme;
					component.invalidate();
					component.render(50);
				},
			},
		} as unknown as ExtensionCommandContext;
		await showArtifactDetailView(ctx, value);
		expect(first.calls).toContain("mdHeading");
		expect(second.calls).toContain("mdHeading");
		expect(second.calls).toContain("borderMuted");
	});

	it("contains no hardcoded ANSI colors in the Markdown adapter path", () => {
		for (const path of ["../extension/src/markdown.ts", "../extension/src/artifact-detail-view.ts", "../extension/src/task-detail-view.ts"]) {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			expect(source).not.toContain("\\x1b[");
			expect(source).not.toMatch(/38;[25]/);
		}
	});
});
