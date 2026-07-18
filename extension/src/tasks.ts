/**
 * tasks.ts — /tasks interactive panel.
 * Filterable list with status glyphs, advance status, run gates, show edges.
 * Follows the pi-extension-manager / pi-packed TUI idiom.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatMetadata } from "./artifact-format.ts";
import { callService } from "./service-client.ts";
import type { Artifact, GateResult } from "../../src/ops.ts";

const GLYPHS: Record<string, string> = {
	pending: "○",
	active: "●",
	done: "■",
	failed: "▲",
};

const STATUS_ACTIONS: Record<string, string[]> = {
	pending: ["Start", "Fail"],
	active: ["Complete (run gates)", "Fail"],
	done: [],
	failed: ["Retry"],
};

interface TaskRow {
	id: string;
	title: string;
	status: string;
	body: string;
	extra: Record<string, unknown>;
	edges?: { from: string; relation: string; to: string }[];
}

async function loadTasks(): Promise<TaskRow[]> {
	return callService<Record<string, unknown>, TaskRow[]>("tasks.list", { limit: 200 });
}

export async function showTasks(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tasks requires interactive mode", "warning");
		return;
	}
	let rows = await loadTasks();
	if (rows.length === 0) {
		const create = await ctx.ui.select("No tasks yet", ["Create a task", "Cancel"]);
		if (create === "Create a task") {
			const title = await ctx.ui.input("Task title:", "");
			if (title) {
				await callService("tasks.create", { title });
				rows = await loadTasks();
			}
		}
		if (rows.length === 0) return;
	}

	for (;;) {
		const action = await renderPanel(ctx, rows);
		if (!action) return;
		if (action.type === "refresh") { rows = await loadTasks(); continue; }
		if (action.type !== "action" || !action.row) continue;

		const choices = ["Show details", "Run gates", ...(STATUS_ACTIONS[action.row.status] ?? [])];
		const choice = await ctx.ui.select(action.row.title, choices);
		if (!choice) continue;

		if (choice === "Show details") {
			const art = await callService<Record<string, unknown>, Artifact | null>("tasks.show", { id: action.row.id });
			if (!art) { ctx.ui.notify("Not found", "error"); continue; }
			let out = `${GLYPHS[art.status] ?? "?"} ${art.title}\n\n${art.body || "(no body)"}`;
			if (art.edges?.length) out += `\n\nEdges:\n${art.edges.map((edge) => `  ${edge.from} --${edge.relation}--> ${edge.to}`).join("\n")}`;
			if (Object.keys(art.extra).length > 0) out += `\n\nMetadata:\n${formatMetadata(art.extra).map((line) => `  ${line}`).join("\n")}`;
			ctx.ui.notify(out, "info");
		} else if (choice === "Run gates") {
			try {
				const results = await callService<Record<string, unknown>, GateResult[]>("tasks.run_gates", { id: action.row.id });
				ctx.ui.notify(`Gates:\n${results.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target} — ${gate.output}`).join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(`Gates failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		} else {
			try {
				const operation = choice === "Start" ? "tasks.start" : choice === "Fail" ? "tasks.fail" : choice === "Retry" ? "tasks.retry" : "tasks.complete";
				if (operation === "tasks.complete") {
					const result = await callService<Record<string, unknown>, { artifact: Artifact; gates: GateResult[]; completed: boolean }>(operation, { id: action.row.id });
					action.row.status = result.artifact.status;
					const gates = result.gates.map((gate) => `${gate.passed ? "✓" : "✗"} ${gate.gate.type}: ${gate.gate.target}`).join("\n");
					ctx.ui.notify(result.completed ? `Completed ${result.artifact.id}${gates ? `\n${gates}` : ""}` : `Not complete; gates failed\n${gates}`, result.completed ? "info" : "warning");
				} else {
					const updated = await callService<Record<string, unknown>, Artifact>(operation, { id: action.row.id });
					action.row.status = updated.status;
					ctx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Task action failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		}
		rows = await loadTasks();
	}
}

interface PanelAction {
	type: "action" | "refresh";
	row?: TaskRow;
}

function renderPanel(ctx: ExtensionCommandContext, rows: TaskRow[]): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
		const searchInput = new Input();
		let searchActive = false;
		let filtered = [...rows];
		let selectedIndex = 0;
		const maxVisible = 20;

		function applyFilter(): void {
			const q = searchInput.getValue().trim().toLowerCase();
			filtered = q ? rows.filter((r) =>
				r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
			) : [...rows];
			selectedIndex = 0;
		}

		function statusLine(): string {
			const counts: Record<string, number> = {};
			for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
			return ["pending", "active", "done", "failed"]
				.filter((s) => (counts[s] ?? 0) > 0)
				.map((s) => `${GLYPHS[s] ?? s} ${counts[s]} ${s}`)
				.join(", ");
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold("Tasks");
				const hint = searchActive
					? rawKeyHint("esc", "clear")
					: rawKeyHint("enter", "actions") +
						theme.fg("muted", " · ") +
						rawKeyHint("/", "filter") +
						theme.fg("muted", " · ") +
						rawKeyHint("r", "refresh") +
						theme.fg("muted", " · ") +
						rawKeyHint("esc", "close");
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
				const line1 = truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, "");
				const line2 = truncateToWidth(theme.fg("muted", statusLine()), width, "");
				return [line1, line2];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				if (searchActive) lines.push(...searchInput.render(width));
				lines.push("");
				if (filtered.length === 0) {
					lines.push(theme.fg("muted", "  No tasks"));
					return lines;
				}
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
				const end = Math.min(start + maxVisible, filtered.length);
				for (let i = start; i < end; i++) {
					const row = filtered[i]!;
					const selected = i === selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					const glyph = GLYPHS[row.status] ?? "?";
					const statusColor = row.status === "active" ? "accent" : row.status === "done" ? "dim" : row.status === "failed" ? "warning" : "muted";
					const glyphStyled = theme.fg(statusColor, glyph);
					const title = selected ? theme.bold(row.title) : row.title;
					const gates = (row.extra?.["gates"] as any[])?.length;
					const gateStr = gates ? theme.fg("dim", ` [${gates} gate(s)]`) : "";
					lines.push(truncateToWidth(`${cursor} ${glyphStyled} ${title}${gateStr}`, width, ""));
				}
				const hasScroll = start > 0 || end < filtered.length;
				lines.push(theme.fg("muted", `  ${hasScroll ? `${selectedIndex + 1}/${filtered.length} ` : ""}task`));
				return lines;
			},
		};

		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());
		container.addChild(new Spacer(1));
		container.addChild(header);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (searchActive) {
					if (data === "\x1b") { searchActive = false; applyFilter(); }
					else if (data === "\r") { searchActive = false; }
					else { searchInput.handleInput(data); applyFilter(); }
					tui.requestRender();
					return;
				}
				switch (data) {
					case "\x1b[A": selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1); break;
					case "\x1b[B": selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1); break;
					case "/": searchActive = true; break;
					case "r": done({ type: "refresh" }); return;
					case "\r": {
						const row = filtered[selectedIndex];
						if (row) done({ type: "action", row });
						return;
					}
					case "\x1b": done(undefined); return;
					default: return;
				}
				tui.requestRender();
			},
		};
	});
}
