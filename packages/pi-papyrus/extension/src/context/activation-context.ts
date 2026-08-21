import { existsSync } from "node:fs";
import { extname, join } from "node:path";

export interface ActivationContextInput {
	languages?: string[];
	file_extensions?: string[];
	session_capabilities?: string[];
}

const LANGUAGE_MARKERS: ReadonlyArray<{ language: string; files: string[] }> = [
	{ language: "typescript", files: ["tsconfig.json"] },
	{ language: "javascript", files: ["package.json"] },
	{ language: "rust", files: ["Cargo.toml"] },
	{ language: "go", files: ["go.mod"] },
	{ language: "python", files: ["pyproject.toml", "requirements.txt"] },
	{ language: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
	{ language: "kotlin", files: ["build.gradle.kts"] },
	{ language: "swift", files: ["Package.swift"] },
	{ language: "zig", files: ["build.zig"] },
];

const PATH_TOKEN = /(?:^|[\s"'`(])([^\s"'`()]+\.[A-Za-z0-9]{1,10})(?=$|[\s"'`),:])/g;
const MAX_EXTENSIONS = 32;
const MAX_CAPABILITIES = 32;

/** Derives only bounded, deterministic turn signals. It never executes project code or interprets free-form predicates. */
export function buildActivationContext(cwd: string, prompt: string, selectedTools: readonly string[] = []): ActivationContextInput {
	const languages = LANGUAGE_MARKERS.filter((entry) => entry.files.some((file) => existsSync(join(cwd, file))))
		.map((entry) => entry.language)
		.sort();
	const extensions = new Set<string>();
	for (const match of prompt.matchAll(PATH_TOKEN)) {
		const extension = extname(match[1]!).toLowerCase();
		if (extension) extensions.add(extension);
		if (extensions.size >= MAX_EXTENSIONS) break;
	}
	const capabilities = [...new Set(selectedTools.filter((tool) => tool.length > 0))].sort().slice(0, MAX_CAPABILITIES);
	return {
		...(languages.length > 0 ? { languages } : {}),
		...(extensions.size > 0 ? { file_extensions: [...extensions].sort() } : {}),
		...(capabilities.length > 0 ? { session_capabilities: capabilities } : {}),
	};
}
