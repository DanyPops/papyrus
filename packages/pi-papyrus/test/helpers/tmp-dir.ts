import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registry: string[] = [];

/**
 * Creates a real temp directory for a test and tracks it for cleanup via cleanupTempDirs().
 * Prevents the exact leak found in this repo: mkdtempSync scattered across 17 test files,
 * none of them ever cleaning up, which accumulated to 11,000+ stray /tmp/papyrus-*
 * directories (2.5GB) over a few days of running this suite repeatedly.
 */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	registry.push(dir);
	return dir;
}

/**
 * Call once per test file, at module top level (bun:test hooks must be registered during
 * collection, not dynamically inside a running test -- verified directly: calling afterAll
 * from inside an it() callback does not reliably defer to end-of-file):
 *   afterAll(cleanupTempDirs);
 */
export function cleanupTempDirs(): void {
	while (registry.length > 0) {
		const dir = registry.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
}
