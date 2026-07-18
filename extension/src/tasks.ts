/**
 * tasks.ts — /tasks interactive panel.
 * Filterable list with status glyphs, advance status, run gates, show edges.
 * Follows the pi-extension-manager / pi-packed TUI idiom.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const GLYPHS: Record<string, string> = {
	pending: "○",
	active: "●",
	done: "■",
	failed: "▲",
};

const STATUS_FLOW: Record<string, string[]> = {
	pending: ["active", "failed"],
	active: ["done", "failed"],
	done: [],
	failed: ["pending"], // retry
};

interface TaskRow {
	id: string;
	title: string;
	status: string;
	body: string;
	extra: Record<string, unknown>;
	edges?: { from: string; relation: string; to: string }[];
}

async function loadTasks(ops: typeof import("../../src/ops.ts")): Promise<TaskRow[]> {
	// openDb pattern — same as the tools
	const { openDb } = await import("../../src/db.ts");
	const { queryArtifacts, getArtifact } = ops;
	const xdg = process.env["XDG_DATA_HOME"] || `${process.env["HOME"]}/.local/share`;
	const db = openDb(`${xdg}/papyrus/papyrus.db`);
	try {
		const rows = queryArtifacts(db, { kind: "task", limit: 200 });
		return rows.map((r: any) => ({
			id: r.id,
			title: r.title,
			status: r.status,
			body: r.body,
			extra: r.extra,
		}));
	} finally {
		db.close();
	}
}

function withDb<T>(fn: (db: any, ops: any) => T): Promise<T> {
	return (async () => {
		const ops = await import("../../src/ops.ts");
		const { openDb } = await import("../../src/db.ts");
		const xdg = process.env["XDG_DATA_HOME"] || `${process.env["HOME"]}/.local/share`;
		const db = openDb(`${xdg}/papyrus/papyrus.db`);
		try { return fn(db, ops); } finally { db.close(); }
	})();
}

export async function showTasks(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tasks requires interactive mode", "warning");
		return;
	}
	const ops = await import("../../src/ops.ts");
	let rows = await loadTasks(ops);
	if (rows.length === 0) {
		const create = await ctx.ui.select("No tasks yet", ["Create a task", "Cancel"]);
		if (create === "Create a task") {
			const title = await ctx.ui.input("Task title:", "");
			if (title) {
				await withDb((db, ops) => ops.createArtifact(db, { kind: "task", title }));
				rows = await loadTasks(ops);
			}
		}
		if (rows.length === 0) return;
	}

	for (;;) {
		const action = await renderPanel(ctx, rows);
		if (!action) return;

		if (action.type === "refresh") {
			rows = await loadTasks(ops);
			continue;
		}

		if (action.type === "action" && action.row) {
			const choices = ["Show details", "Run gates", ...(STATUS_FLOW[action.row.status] ?? []).map((s) => `Advance → ${s}`)];
			const choice = await ctx.ui.select(action.row.title, choices);
			if (!choice) continue;

			if (choice === "Show details") {
				const art = await withDb((db, ops) => ops.getArtifact(db, action.row!.id, { tree: true }));
				if (!art) { ctx.ui.notify("Not found", "error"); continue; }
				let out = `${GLYPHS[art.status] ?? "?"} ${art.title}\n\n${art.body || "(no body)"}`;
				if (art.edges?.length) {
					out += `\n\nEdges:\n${art.edges.map((e: any) => `  ${e.from} --${e.relation}--> ${e.to}`).join("\n")}`;
				}
				const gates = art.extra?.["gates"] as any[] | undefined;
				if (gates?.length) {
					out += `\n\nGates (${gates.length}):\n${gates.map((g: any) => `  ${g.type}: ${g.target}${g.expect ? ` = ${g.expect}` : ""}`).join("\n")}`;
				}
				ctx.ui.notify(out, "info");
			} else if (choice === "Run gates") {
				try {
					const results = await withDb((db, ops) => ops.runGates(db, action.row!.id));
					const lines = results.map((g: any) => `${g.passed ? "✓" : "✗"} ${g.gate.type}: ${g.gate.target} — ${g.output}`);
					ctx.ui.notify(`Gates:\n${lines.join("\n")}`, "info");
				} catch (e) {
					ctx.ui.notify(`Gates failed: ${e instanceof Error ? e.message : e}`, "error");
				}
			} else if (choice.startsWith("Advance → ")) {
				const newStatus = choice.replace("Advance → ", "");
				try {
					const updated = await withDb((db, ops) => ops.updateStatus(db, action.row!.id, newStatus));
					if (updated) {
						action.row.status = updated.status;
						ctx.ui.notify(`${updated.id} → [${updated.status}]`, "info");
					}
				} catch (e) {
					ctx.ui.notify(`Status change failed: ${e instanceof Error ? e.message : e}`, "error");
				}
			}
		}
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
