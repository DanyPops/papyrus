import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePlaybookSkillPaths } from "../extension/src/playbook-bridge.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

const originalCacheHome = process.env["XDG_CACHE_HOME"];
let scratchDir: string | undefined;

afterEach(() => {
	resetPapyrusClientForTests();
	if (originalCacheHome === undefined) delete process.env["XDG_CACHE_HOME"];
	else process.env["XDG_CACHE_HOME"] = originalCacheHome;
	if (scratchDir) { rmSync(scratchDir, { recursive: true, force: true }); scratchDir = undefined; }
});

function useScratchCacheHome(): string {
	scratchDir = mkdtempSync(join(tmpdir(), "papyrus-playbook-bridge-"));
	process.env["XDG_CACHE_HOME"] = scratchDir;
	return join(scratchDir, "papyrus", "playbooks");
}

function mockPlaybooksList(playbooks: unknown[]): void {
	setPapyrusClientConnectorForTests(async () => ({
		async call(operation: string, input: any) {
			if (operation !== "playbooks.list") throw new Error(`unexpected operation ${operation}`);
			expect(input).toMatchObject({ status: "active" });
			return playbooks;
		},
	}) as any);
}

const PLAYBOOK = { id: "p1", kind: "playbook", subtype: "", title: "New Project", status: "active", body: "", labels: [], extra: { trigger: "starting from scratch", steps: ["Frame the problem", "State the goal"], tools: ["discuss"] }, created_at: "x", updated_at: "x" };

describe("playbook-bridge: materializes active Playbooks as real SKILL.md files for Pi's native catalog", () => {
	it("writes one SKILL.md per active playbook, with frontmatter and steps rendered", async () => {
		const dir = useScratchCacheHome();
		mockPlaybooksList([PLAYBOOK]);
		const paths = await materializePlaybookSkillPaths();
		expect(paths).toHaveLength(1);
		expect(paths[0]).toBe(join(dir, "new-project", "SKILL.md"));
		const content = readFileSync(paths[0]!, "utf8");
		expect(content).toContain("name: new-project");
		expect(content).toContain("description: starting from scratch");
		expect(content).toContain("1. Frame the problem");
		expect(content).toContain("2. State the goal");
		expect(content).toContain("Tools: discuss");
	});

	it("disambiguates a real title collision by suffixing the id, rather than overwriting one playbook with another", async () => {
		useScratchCacheHome();
		mockPlaybooksList([
			{ ...PLAYBOOK, id: "p1", title: "Same Title" },
			{ ...PLAYBOOK, id: "p2", title: "Same Title" },
		]);
		const paths = await materializePlaybookSkillPaths();
		expect(paths).toHaveLength(2);
		expect(new Set(paths).size).toBe(2);
	});

	it("wipes stale materialized files from a previous run -- a disabled/removed playbook is never left behind", async () => {
		const dir = useScratchCacheHome();
		mockPlaybooksList([PLAYBOOK]);
		await materializePlaybookSkillPaths();
		expect(existsSync(join(dir, "new-project", "SKILL.md"))).toBe(true);

		mockPlaybooksList([]); // the playbook got disabled/removed since the last discovery
		const paths = await materializePlaybookSkillPaths();
		expect(paths).toEqual([]);
		expect(existsSync(join(dir, "new-project"))).toBe(false);
	});

	it("returns no paths, and leaves no directory, when there are no active playbooks", async () => {
		const dir = useScratchCacheHome();
		mockPlaybooksList([]);
		const paths = await materializePlaybookSkillPaths();
		expect(paths).toEqual([]);
		expect(existsSync(dir)).toBe(false);
	});
});
