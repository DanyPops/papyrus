import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { NOTE_LIST_MAX_LIMIT } from "../../src/constants.ts";
import { NOTE_DISPOSITIONS } from "../../src/note-service.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import { showArtifactBrowser, showArtifactDetails } from "./artifact-browser.ts";
import { callService } from "./service-client.ts";

const NOTE_GLYPHS: Record<string, string> = { draft: "○", active: "●", archived: "■" };

export function noteRowMeta(note: Artifact): string {
	const history = Array.isArray(note.extra["noteHistory"]) ? note.extra["noteHistory"].length : 0;
	return `${history} event${history === 1 ? "" : "s"}`;
}

export function noteCaptureInput(request: string, projectRoot: string): Record<string, unknown> | null {
	const body = request.trim();
	if (!body) return null;
	return { body, project_root: projectRoot, actor: "human", source: "note-command" };
}

/**
 * The generic artifact browser (extension/src/artifact-browser.ts) requests a fixed 500-row
 * page by default, but notes.list enforces its own tighter NOTE_LIST_MAX_LIMIT (200) — an
 * unqualified /notes call exceeded that bound and the browser surfaced the daemon's rejection
 * as an opaque extension error instead of ever rendering. Passing an explicit limit here that
 * respects the Notes-specific bound is the fix; the generic browser's default stays as-is
 * since no other kind's list operation has a bound below 500.
 */
export function noteListInput(projectRoot: string): Record<string, unknown> {
	return { project_root: projectRoot, limit: NOTE_LIST_MAX_LIMIT };
}

export async function captureNote(request: string, ctx: ExtensionCommandContext): Promise<Artifact | null> {
	const input = noteCaptureInput(request, ctx.cwd);
	if (!input) {
		ctx.ui.notify("Usage: /note <request for later>", "warning");
		return null;
	}
	try {
		const note = await callService<Record<string, unknown>, Artifact>("notes.capture", input);
		ctx.ui.notify(`Captured note: ${note.title}`, "info");
		return note;
	} catch (error) {
		ctx.ui.notify(`Note capture failed: ${error instanceof Error ? error.message : error}`, "error");
		return null;
	}
}

export async function showNotes(ctx: ExtensionCommandContext): Promise<void> {
	await showArtifactBrowser(ctx, {
		kind: "note",
		title: "Notes inbox",
		listOperation: "notes.list",
		listInput: noteListInput(ctx.cwd),
		statusOrder: ["draft", "active", "archived"],
		glyphs: NOTE_GLYPHS,
		rowMeta: noteRowMeta,
		actions: (note) => [
			"Show details",
			...(note.status === "draft" ? ["Consume"] : []),
			"Promote",
			"Archive",
		],
		handleAction: async (choice, note, commandCtx) => {
			if (choice === "Show details") {
				await showArtifactDetails(commandCtx, note.id, "notes.show", { project_root: commandCtx.cwd });
				return;
			}
			if (choice === "Consume") {
				await callService("notes.consume", { id: note.id, project_root: commandCtx.cwd, actor: "human", source: "notes-tui" });
				commandCtx.ui.notify(`Consumed ${note.title}`, "info");
				return;
			}
			if (choice === "Promote") {
				const targetId = await commandCtx.ui.input("Resulting artifact id:", "");
				if (!targetId) return;
				const reason = await commandCtx.ui.input("Disposition note (optional):", "");
				await callService("notes.promote", {
					id: note.id,
					target_id: targetId,
					project_root: commandCtx.cwd,
					actor: "human",
					source: "notes-tui",
					...(reason ? { reason } : {}),
				});
				commandCtx.ui.notify(`Promoted ${note.title} → ${targetId}`, "info");
				return;
			}
			const disposition = await commandCtx.ui.select("Archive disposition", [...NOTE_DISPOSITIONS]);
			if (!disposition) return;
			const reason = await commandCtx.ui.input("Reason (optional):", "");
			await callService("notes.archive", {
				id: note.id,
				disposition,
				project_root: commandCtx.cwd,
				actor: "human",
				source: "notes-tui",
				...(reason ? { reason } : {}),
			});
			commandCtx.ui.notify(`Archived ${note.title} · ${disposition}`, "info");
		},
	});
}
