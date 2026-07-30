/**
 * Real evidence, not an assumption: this is the exact real-world path a Pi
 * session takes -- resolving @danypops/papyrus as an actual npm/workspace
 * dependency of @danypops/pi-papyrus, not a same-repo relative import. That
 * boundary is where a consumer daemon in this house previously hit jiti's
 * documented "Map operation called on non-Map object" failure importing its
 * own daemon package's raw TypeScript from its extension.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { verifyLoadableUnderPi } from "@danypops/vehicle-client-pi/pi-load-harness";

const EXTENSION_ENTRY = resolve(import.meta.dir, "..", "extension", "src", "index.ts");
const PAPYRUS_BARREL = resolve(import.meta.dir, "..", "node_modules", "@danypops", "papyrus", "src", "index.ts");

function expectAllPathsOk(results: Awaited<ReturnType<typeof verifyLoadableUnderPi>>): void {
	for (const result of results) {
		expect(result.ok, `${result.path} failed: ${result.error ?? "(no error message)"}`).toBe(true);
	}
}

describe("pi-papyrus loads safely across the real @danypops/papyrus package boundary", () => {
	it("@danypops/papyrus's own published barrel, resolved through the real workspace symlink, loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(PAPYRUS_BARREL));
	});

	it("the extension entry point itself loads under every Pi extension load path", async () => {
		expectAllPathsOk(await verifyLoadableUnderPi(EXTENSION_ENTRY));
	});
});
