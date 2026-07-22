import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN } from "../../src/constants.ts";

/**
 * Pi-native skills (SKILL.md) carry a real, permanent context tax independent of Papyrus:
 * per Pi's own docs, every discovered skill's name+description is injected into the system
 * prompt unconditionally at startup (the Agent Skills spec's "catalog" tier, ~50-100 tokens
 * per skill). This module measures that tax by replicating Pi's own documented discovery
 * rules (docs/skills.md "Locations" section) directly against the filesystem, rather than
 * trying to parse it back out of the assembled system prompt -- Pi does not document (and
 * this repo must not depend on) the exact wire format it uses to inject the catalog, so
 * re-deriving the same inputs Pi itself reads is the robust approach, not a fragile one.
 * Package-declared skills (pi.skills in package.json / packages' own skills/ directories)
 * are deliberately out of scope: enumerating every installed package for skill declarations
 * is a materially larger, slower scan than reading a handful of known directories, and this
 * tool is a budget estimate, not an exhaustive audit.
 */
export interface SkillCatalogEntry {
	name: string;
	description: string;
	location: string;
	characters: number;
	estimatedTokens: number;
}

export interface SkillCatalogFootprint {
	entries: SkillCatalogEntry[];
	totalCharacters: number;
	totalEstimatedTokens: number;
	scannedDirectories: string[];
}

export const SKILL_SCAN_MAX_DEPTH = 6;
export const SKILL_SCAN_MAX_DIRECTORIES = 2000;
export const SKILL_SCAN_MAX_SKILLS = 500;

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Extracts `name` and `description` from a SKILL.md's YAML frontmatter, tolerating the
 * folded (`>`) and literal (`|`) block-scalar forms real-world skills commonly use for
 * multi-line descriptions. Deliberately not a general YAML parser -- only the two fields
 * the Agent Skills spec requires are extracted; anything else in the frontmatter is ignored.
 */
export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	const lines = match[1]!.split(/\r?\n/);
	let name = "";
	let description = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const nameMatch = line.match(/^name:\s*(.*)$/);
		if (nameMatch) {
			name = unquote(nameMatch[1]!.trim());
			continue;
		}
		const descriptionMatch = line.match(/^description:\s*(.*)$/);
		if (!descriptionMatch) continue;
		const rest = descriptionMatch[1]!.trim();
		if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
			const collected: string[] = [];
			let cursor = index + 1;
			while (cursor < lines.length && (lines[cursor] === "" || /^\s+/.test(lines[cursor]!))) {
				collected.push(lines[cursor]!.trim());
				cursor++;
			}
			description = collected.join(rest.startsWith("|") ? "\n" : " ").trim();
			index = cursor - 1;
		} else {
			description = unquote(rest);
		}
	}
	if (!name || !description) return null;
	return { name, description };
}

/** True at the filesystem root on POSIX (`/`) and Windows (`C:\`, `D:\`, ...). */
function isFilesystemRoot(path: string): boolean {
	return dirname(path) === path;
}

/**
 * Global and project skill directories per Pi's own documented discovery rules, plus any
 * explicit paths configured in settings.json's `skills` array. Project directories are
 * collected walking from `cwd` up to the git repository root (or filesystem root when not
 * in a repo), matching "up to git repo root, or filesystem root when not in a repo" exactly.
 */
export function discoverSkillDirectories(homeDirectory: string, cwd: string, settingsSkills: readonly string[] = []): string[] {
	const directories = [join(homeDirectory, ".pi", "agent", "skills"), join(homeDirectory, ".agents", "skills")];
	let current = cwd;
	for (let depth = 0; depth < SKILL_SCAN_MAX_DIRECTORIES; depth++) {
		directories.push(join(current, ".pi", "skills"), join(current, ".agents", "skills"));
		if (existsSync(join(current, ".git")) || isFilesystemRoot(current)) break;
		current = dirname(current);
	}
	directories.push(...settingsSkills);
	return [...new Set(directories)];
}

interface ScanContext {
	entries: SkillCatalogEntry[];
	seenLocations: Set<string>;
	directoriesVisited: number;
}

/** Root-level .md files count as individual skills only in these two locations, per Pi's docs. */
function allowsRootMarkdownFiles(directory: string): boolean {
	return directory.endsWith(join(".pi", "agent", "skills")) || directory.endsWith(join(".pi", "skills"));
}

function recordSkillFile(context: ScanContext, path: string): void {
	if (context.seenLocations.has(path) || context.entries.length >= SKILL_SCAN_MAX_SKILLS) return;
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const parsed = parseSkillFrontmatter(content);
	if (!parsed) return;
	context.seenLocations.add(path);
	const characters = parsed.name.length + parsed.description.length;
	context.entries.push({
		name: parsed.name,
		description: parsed.description,
		location: path,
		characters,
		estimatedTokens: Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN),
	});
}

function walk(context: ScanContext, directory: string, depth: number, allowRootMarkdown: boolean): void {
	if (depth > SKILL_SCAN_MAX_DEPTH || context.directoriesVisited >= SKILL_SCAN_MAX_DIRECTORIES) return;
	context.directoriesVisited++;
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === "node_modules" || name === ".git") continue;
		const path = join(directory, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			const skillFile = join(path, "SKILL.md");
			if (existsSync(skillFile)) recordSkillFile(context, skillFile);
			else walk(context, path, depth + 1, false);
		} else if (allowRootMarkdown && depth === 0 && name.toLowerCase().endsWith(".md")) {
			recordSkillFile(context, path);
		}
	}
}

/** Bounded, best-effort scan: a missing or unreadable directory is silently skipped, not an error. */
export function scanSkillCatalogFootprint(directories: readonly string[]): SkillCatalogFootprint {
	const context: ScanContext = { entries: [], seenLocations: new Set(), directoriesVisited: 0 };
	const scanned: string[] = [];
	for (const directory of directories) {
		if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
		scanned.push(directory);
		walk(context, directory, 0, allowsRootMarkdownFiles(directory));
	}
	const entries = context.entries.sort((a, b) => b.characters - a.characters);
	return {
		entries,
		totalCharacters: entries.reduce((sum, entry) => sum + entry.characters, 0),
		totalEstimatedTokens: entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
		scannedDirectories: scanned,
	};
}
