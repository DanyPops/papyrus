import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../papyrus/test/helpers/tmp-dir.ts";
import { buildActivationContext } from "../extension/src/context/activation-context.ts";

afterAll(cleanupTempDirs);

describe("buildActivationContext", () => {
	test("derives bounded language, extension, and capability signals", () => {
		const root = tempDir("pi-papyrus-activation-");
		writeFileSync(join(root, "tsconfig.json"), "{}");
		writeFileSync(join(root, "Cargo.toml"), "[package]");
		const context = buildActivationContext(root, "Update src/index.ts and crates/core/src/lib.rs", ["read", "edit"]);
		expect(context).toEqual({
			languages: ["rust", "typescript"],
			file_extensions: [".rs", ".ts"],
			session_capabilities: ["edit", "read"],
		});
	});
});
