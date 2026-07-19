import { readFileSync } from "node:fs";

function packageVersion(): string {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new Error("Papyrus package manifest must be an object");
	}
	const version = (manifest as Record<string, unknown>)["version"];
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("Papyrus package manifest has an invalid version");
	}
	return version;
}

/** Runtime package version; package.json is the single release source of truth. */
export const VERSION = packageVersion();
