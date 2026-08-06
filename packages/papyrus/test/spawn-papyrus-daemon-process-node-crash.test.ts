/**
 * spawnPapyrusDaemonProcess (src/client.ts) is Node-specific defense: a spawn() failure
 * surfaces asynchronously as an unlistened "error" event only under real Node, not Bun
 * (Bun's own spawn() throws synchronously at the call site instead -- see
 * @danypops/vehicle-client's spawn-error-uncaught-crash.test.ts for that comparison). Since
 * this whole suite runs under `bun test`, proving the fix means running the REAL compiled
 * client.ts under real Node, not a hand-copied duplicate of its body that could silently
 * drift from the shipped code.
 *
 * Bun.build() compiles client.ts here (its own package.json marks "./daemon-client" as the
 * one Vehicle subpath safe to import raw under Node -- everything else, including
 * "./version", is plain TypeScript that Node's type-stripper refuses under node_modules), so
 * the resulting artifact is Node-runnable while keeping @danypops/vehicle-client/daemon-client
 * as a real, unmodified external import.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Built inside packages/papyrus itself, not the bare OS tempdir tempDir() uses elsewhere in
 * this suite -- Node resolves the bundle's own "@danypops/vehicle-client/daemon-client"
 * import by walking up from the bundle file's own directory, and only packages/papyrus has
 * that dependency installed.
 */
const BUILD_ROOT = join(import.meta.dir, "..", ".node-crash-test-build");

afterAll(() => rmSync(BUILD_ROOT, { recursive: true, force: true }));

async function buildClientForNode(outDir: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [join(import.meta.dir, "..", "src", "client.ts")],
		target: "node",
		external: ["@danypops/vehicle-client/daemon-client"],
		outdir: outDir,
	});
	if (!result.success) throw new Error(`build failed: ${result.logs.map(String).join("\n")}`);
	return join(outDir, "client.js");
}

function runUnderNode(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn("node", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

describe("spawnPapyrusDaemonProcess under real Node -- the real production auto-spawn incident", () => {
	it("a missing binPath is logged and swallowed, never crashes the host process", async () => {
		mkdirSync(BUILD_ROOT, { recursive: true });
		const dir = mkdtempSync(join(BUILD_ROOT, "run-"));
		const clientPath = await buildClientForNode(dir);

		const scriptPath = join(dir, "run.mjs");
		writeFileSync(
			scriptPath,
			`
				import { spawnPapyrusDaemonProcess } from ${JSON.stringify(clientPath)};
				spawnPapyrusDaemonProcess("/definitely/does/not/exist/cli.ts", ["serve"], { detached: true, stdio: "ignore" });
				setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING"), 300);
				`,
		);

		const result = await runUnderNode(scriptPath);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("REACHED_END_WITHOUT_CRASHING");
		expect(result.stderr).toContain("Papyrus daemon auto-spawn failed: spawn /definitely/does/not/exist/cli.ts ENOENT");
		expect(result.stderr).not.toContain("Uncaught");
	}, 15_000);
});
