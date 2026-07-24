/**
 * playbook-bridge.ts — materializes active Papyrus Playbooks as real SKILL.md files so they
 * show up in Pi's own native skill catalog and become /skill:name-invocable, through Pi's
 * unmodified, documented resources_discover mechanism (no Pi source touched).
 *
 * Playbooks live in SQLite, not on disk, so they can't satisfy Pi's skill-loading pipeline
 * directly (Skill.filePath is required there). This bridges the gap the other direction:
 * on every resources_discover (session start and /reload), wipe and rebuild a cache directory
 * from the current playbooks.list, so a disabled/removed/renamed Playbook's stale file is never
 * served. Any failure degrades to "no extra skills this cycle" -- a Papyrus daemon hiccup must
 * never break Pi's own resource discovery.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Artifact } from "../../src/domain/artifact.ts";
import { callService } from "./service-client.ts";

const PLAYBOOK_BRIDGE_MAX_PLAYBOOKS = 100;
const PLAYBOOK_BRIDGE_DESCRIPTION_MAX_CHARACTERS = 1000;

function slugify(title: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return slug.length > 0 ? slug : "playbook";
}

function playbookCacheDir(): string {
	const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
	return join(base, "papyrus", "playbooks");
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function playbookSkillMarkdown(playbook: Artifact): string {
	const trigger = typeof playbook.extra["trigger"] === "string" ? playbook.extra["trigger"] : "manual invocation";
	const steps = stringList(playbook.extra["steps"]);
	const tools = stringList(playbook.extra["tools"]);
	const description = trigger.replace(/\n/g, " ").slice(0, PLAYBOOK_BRIDGE_DESCRIPTION_MAX_CHARACTERS);
	return [
		"---",
		`name: ${slugify(playbook.title)}`,
		`description: ${description}`,
		"---",
		"",
		`# ${playbook.title}`,
		"",
		`Materialized from a live Papyrus playbook; edits here are lost on the next refresh. Edit the playbook itself instead (the playbooks tool, action=update), then /reload.`,
		"",
		`Trigger: ${trigger}`,
		"",
		...(playbook.body ? [`Context: ${playbook.body}`, ""] : []),
		...(steps.length > 0 ? ["## Steps", "", ...steps.map((step, index) => `${index + 1}. ${step}`), ""] : []),
		...(tools.length > 0 ? [`Tools: ${tools.join(", ")}`, ""] : []),
	].join("\n");
}

/** Exported for direct testing without a real ExtensionAPI. */
export async function materializePlaybookSkillPaths(): Promise<string[]> {
	const dir = playbookCacheDir();
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	const playbooks = await callService<Record<string, unknown>, Artifact[]>("playbooks.list", { status: "active", limit: PLAYBOOK_BRIDGE_MAX_PLAYBOOKS });
	if (playbooks.length === 0) return [];
	mkdirSync(dir, { recursive: true });
	const usedSlugs = new Set<string>();
	const paths: string[] = [];
	for (const playbook of playbooks) {
		let slug = slugify(playbook.title);
		if (usedSlugs.has(slug)) slug = `${slug}-${playbook.id.slice(0, 8)}`; // a real title collision, not the common case
		usedSlugs.add(slug);
		const skillDir = join(dir, slug);
		mkdirSync(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		writeFileSync(filePath, playbookSkillMarkdown(playbook), "utf8");
		paths.push(filePath);
	}
	return paths;
}

export function registerPlaybookBridge(pi: ExtensionAPI): void {
	pi.on("resources_discover", async () => {
		try {
			return { skillPaths: await materializePlaybookSkillPaths() };
		} catch {
			return {};
		}
	});
}
