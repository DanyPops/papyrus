import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const hook = join(import.meta.dir, "..", ".githooks", "pre-push");

describe("repository ownership guard", () => {
	it("allows the canonical DanyPops repository", () => {
		const result = spawnSync(hook, ["origin", "git@personal.github.com:DanyPops/papyrus.git"], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("blocks an explicit old-owner fallback", () => {
		const result = spawnSync(hook, ["fallback", "https://github.com/dpopsuev/papyrus.git"], { encoding: "utf8" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("BLOCKED");
		expect(result.stderr).toContain("Do not bypass this guard");
	});
});
