/**
 * playbook-bridge.ts — materializes active Papyrus Playbooks as their own /playbook:name slash
 * commands, one per playbook, the same one-entry-per-item autocomplete experience Pi's own
 * /skill:name gives real skills.
 *
 * /skill:name itself is a hardcoded core mechanism (Pi's interactive mode builds it directly
 * from its own skill loader) -- not something an extension can retarget to a different prefix.
 * pi.registerCommand(name, ...) accepts any string, colons included, so "playbook:<slug>"
 * registers and invokes as literally /playbook:<slug> -- a real, supported extension API, no
 * core touched.
 *
 * Real limitation: ExtensionAPI has no unregisterCommand. A disabled or renamed playbook's old
 * /playbook:<slug> command lingers until a full Pi restart -- registerCommand can only add or
 * overwrite, never remove. Mitigated two ways: registrations refresh on every resources_discover
 * (session start and /reload), so a renamed playbook's NEW slug appears promptly even though the
 * old one lingers; and each command's handler re-fetches the live playbook by id at invocation
 * time rather than baking in stale content, so even a lingering stale name fails cleanly with a
 * real error instead of running deleted content.
 */

import type { Artifact } from "@danypops/papyrus";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildActivationContext } from "../context/activation-context.ts";
import { callService } from "../service-client.ts";

export const PLAYBOOK_BRIDGE_MAX_PLAYBOOKS = 100;

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug.length > 0 ? slug : "playbook";
}

async function activePlaybooks(projectRoot?: string, capabilities: readonly string[] = []): Promise<Artifact[]> {
	return callService<Record<string, unknown>, Artifact[]>("playbooks.list", {
		status: "active",
		limit: PLAYBOOK_BRIDGE_MAX_PLAYBOOKS,
		...(projectRoot === undefined
			? {}
			: {
					project_root: projectRoot,
					applicable: true,
					activated: true,
					activation_context: buildActivationContext(projectRoot, "", capabilities),
				}),
	});
}

/** Exported for direct testing without a real ExtensionAPI. */
export function playbookCommandName(title: string): string {
	return `playbook:${slugify(title)}`;
}

/**
 * One line per active Playbook for context injection -- the passive, every-turn surfacing that
 * gives the model the same "this exists and might match my task" awareness Pi's own Skill catalog
 * gives real Skills, without a file-based bridge. See buildContextInjection (rules and open tasks
 * already work this way).
 */
export function playbookInjectionPreview(playbook: Pick<Artifact, "title" | "extra">): string {
	const trigger = typeof playbook.extra.trigger === "string" ? playbook.extra.trigger : "manual invocation";
	return `• ${playbook.title} (when: ${trigger})`;
}

/** Exported for direct testing without a real ExtensionAPI: what would be registered right now. */
export async function planPlaybookCommandRegistrations(
	projectRoot?: string,
	capabilities: readonly string[] = [],
): Promise<Array<{ name: string; id: string; title: string; trigger: string }>> {
	const playbooks = await activePlaybooks(projectRoot, capabilities);
	const usedNames = new Set<string>();
	return playbooks.map((playbook) => {
		let name = playbookCommandName(playbook.title);
		if (usedNames.has(name)) name = `${name}-${playbook.id.slice(0, 8)}`; // a real title collision, not the common case
		usedNames.add(name);
		const trigger = typeof playbook.extra.trigger === "string" ? playbook.extra.trigger : "manual invocation";
		return { name, id: playbook.id, title: playbook.title, trigger };
	});
}

export function registerPlaybookBridge(pi: ExtensionAPI): void {
	const refresh = async (projectRoot?: string) => {
		try {
			const registrations = await planPlaybookCommandRegistrations(projectRoot, pi.getActiveTools?.() ?? []);
			for (const { name, id, title, trigger } of registrations) {
				pi.registerCommand(name, {
					description: trigger,
					handler: async (_args, ctx) => {
						try {
							if (ctx.cwd) {
								const currentlyActive = await activePlaybooks(ctx.cwd, pi.getActiveTools?.() ?? []);
								if (!currentlyActive.some((playbook) => playbook.id === id)) {
									ctx.ui.notify(`"${title}" is not enabled for this project context`, "error");
									return;
								}
							}
							// Re-fetched live, not captured at registration time: a lingering stale
							// command (renamed or disabled since, since registerCommand can't be
							// unregistered) must fail cleanly, never run deleted/stale content.
							// invoke materializes real Tasks and focuses the entry one -- it no longer
							// returns rendered text to drop into the editor (that's playbooks.preview
							// now). The editor gets a short kickoff prompt instead; the actual step
							// content surfaces via the normal Task Focus system-prompt pointer.
							const invocation = await callService<Record<string, unknown>, { entryTaskId?: string; missingArguments?: string[] }>(
								"playbooks.invoke",
								{ id },
							);
							if (invocation.missingArguments) {
								ctx.ui.notify(`"${title}" needs: ${invocation.missingArguments.join(", ")}`, "error");
								return;
							}
							ctx.ui.setEditorText(`Run the "${title}" playbook -- work on the currently focused task.`);
							ctx.ui.notify(`"${title}" invoked: entry task ${invocation.entryTaskId} focused`, "info");
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
					},
				});
			}
		} catch {
			// A Papyrus daemon hiccup must never break Pi's own resource discovery -- degrades to
			// "no new/updated playbook commands this cycle", not a broken session start.
		}
	};
	pi.on("resources_discover", async (event) => {
		await refresh(event?.cwd);
		return {};
	});
}
