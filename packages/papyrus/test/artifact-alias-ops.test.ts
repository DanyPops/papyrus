import { afterAll, describe, expect, it } from "bun:test";
import { type Db, openDb } from "../src/db.ts";
import { createArtifact, getArtifact, getArtifactByAlias, updateArtifactContent } from "../src/ops.ts";
import { cleanupTempDirs } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

function openTempDb(): Db {
	return openDb(":memory:");
}

describe("createArtifact: alias", () => {
	it("auto-generates a unique alias from title", () => {
		const db = openTempDb();
		const artifact = createArtifact(db, { kind: "task", title: "Fix the timeout bug" });
		expect(artifact.alias).toBe("fix-the-timeout-bug");
	});

	it("dedupes two artifacts sharing the same title with a numeric suffix", () => {
		const db = openTempDb();
		const first = createArtifact(db, { kind: "task", title: "Fix the timeout bug" });
		const second = createArtifact(db, { kind: "task", title: "Fix the timeout bug" });
		expect(first.alias).toBe("fix-the-timeout-bug");
		expect(second.alias).toBe("fix-the-timeout-bug-2");
	});

	it("accepts an explicit alias override", () => {
		const db = openTempDb();
		const artifact = createArtifact(db, { kind: "task", title: "Fix the timeout bug", alias: "timeout-fix" });
		expect(artifact.alias).toBe("timeout-fix");
	});

	it("rejects an explicit alias that collides with an existing one -- a real conflict, not a silent suffix", () => {
		const db = openTempDb();
		createArtifact(db, { kind: "task", title: "First", alias: "shared-alias" });
		expect(() => createArtifact(db, { kind: "task", title: "Second", alias: "shared-alias" })).toThrow(/alias "shared-alias" is already/);
	});

	it("rejects an explicit alias that fails format validation", () => {
		const db = openTempDb();
		expect(() => createArtifact(db, { kind: "task", title: "Bad alias", alias: "Not Valid!" })).toThrow(/not a valid alias/);
	});
});

describe("getArtifactByAlias", () => {
	it("resolves an artifact by its alias", () => {
		const db = openTempDb();
		const artifact = createArtifact(db, { kind: "task", title: "Findable by alias" });
		expect(getArtifactByAlias(db, artifact.alias)?.id).toBe(artifact.id);
	});

	it("returns null for an alias nobody has", () => {
		const db = openTempDb();
		expect(getArtifactByAlias(db, "no-such-alias")).toBeNull();
	});
});

describe("updateArtifactContent: alias rename", () => {
	it("renames an artifact's alias, validated the same way as creation", () => {
		const db = openTempDb();
		const artifact = createArtifact(db, { kind: "task", title: "Renameable" });
		const updated = updateArtifactContent(db, artifact.id, { alias: "renamed-alias" });
		expect(updated?.alias).toBe("renamed-alias");
		expect(getArtifact(db, artifact.id)?.alias).toBe("renamed-alias");
	});

	it("rejects renaming to an alias already taken by another artifact", () => {
		const db = openTempDb();
		createArtifact(db, { kind: "task", title: "Taken", alias: "taken-alias" });
		const other = createArtifact(db, { kind: "task", title: "Other" });
		expect(() => updateArtifactContent(db, other.id, { alias: "taken-alias" })).toThrow(/alias "taken-alias" is already/);
	});
});
