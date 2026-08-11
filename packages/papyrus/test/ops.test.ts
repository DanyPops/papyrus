import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbPath } from "../src/constants.ts";
import { type Db, openDb } from "../src/db.ts";
import { createArtifact, getArtifact, linkArtifacts, queryArtifacts, runGates, runGatesAsync } from "../src/ops.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

function tmpDb(): { db: Db; dir: string } {
	const dir = tempDir("papyrus-");
	process.env.XDG_DATA_HOME = dir;
	const db = openDb(dbPath());
	return { db, dir };
}

describe("papyrus: four-kind model", () => {
	it("rejects unknown kind", () => {
		const { db } = tmpDb();
		expect(() => createArtifact(db, { kind: "frobnicate", title: "x" })).toThrow();
		db.close();
	});

	it("generates a UUID id when none is supplied, never a title-derived value, and never mutates the title", () => {
		// id is an opaque backend identity; title is pure human-authored content. Neither may
		// leak into the other -- the id must not contain any recognizable fragment of the
		// title (proving it isn't slugified from it), and the title must come back byte-for-
		// byte as supplied (proving nothing generated ever gets mixed into it).
		const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		const { db } = tmpDb();
		const title = "Some Human-Authored Title With Spaces";
		const artifact = createArtifact(db, { kind: "doc", title });
		expect(artifact.id).toMatch(UUID_V4_SHAPE);
		expect(artifact.title).toBe(title);
		expect(artifact.id.toLowerCase()).not.toContain("some");
		expect(artifact.id.toLowerCase()).not.toContain("human");
		const other = createArtifact(db, { kind: "doc", title });
		expect(other.id).not.toBe(artifact.id); // two artifacts with the same title never collide
		db.close();
	});

	it("round-trips title/body containing HTML-special characters byte-for-byte, never entity-encoded", () => {
		const title = "Data Hygiene Audit & Scrub <review> \"quoted\" 'single'";
		const body = "if (a < b && b > c) { console.log('done'); }";
		const { db } = tmpDb();
		const artifact = createArtifact(db, { kind: "playbook", title, body });
		expect(artifact.title).toBe(title);
		expect(artifact.body).toBe(body);
		const reloaded = getArtifact(db, artifact.id);
		expect(reloaded?.title).toBe(title);
		expect(reloaded?.body).toBe(body);
		db.close();
	});

	it("honors a caller-supplied id verbatim, unaffected by UUID generation", () => {
		const { db } = tmpDb();
		const artifact = createArtifact(db, { kind: "doc", title: "Explicit id", id: "caller-chosen-id" });
		expect(artifact.id).toBe("caller-chosen-id");
		db.close();
	});

	it("create + query each kind", () => {
		const { db } = tmpDb();
		const doc = createArtifact(db, { kind: "doc", title: "Architecture overview", subtype: "design" });
		const task = createArtifact(db, { kind: "task", title: "Implement SQLite layer" });
		const rule = createArtifact(db, {
			kind: "rule",
			title: "Run tests before commit",
			extra: { condition: "git commit", action: "bun test", severity: "block" },
		});
		const playbook = createArtifact(db, {
			kind: "playbook",
			title: "TDD workflow",
			extra: { trigger: "writing code", steps: ["write test", "implement", "refactor"], tools: ["bun test", "tsc"] },
		});

		expect(doc.kind).toBe("doc");
		expect(task.kind).toBe("task");
		expect(rule.kind).toBe("rule");
		expect(playbook.kind).toBe("playbook");

		expect(queryArtifacts(db, { kind: "doc" })).toHaveLength(1);
		expect(queryArtifacts(db, { kind: "task" })).toHaveLength(1);
		expect(queryArtifacts(db, { kind: "rule" })).toHaveLength(1);
		expect(queryArtifacts(db, { kind: "playbook" })).toHaveLength(1);
		db.close();
	});

	it("default status per kind", () => {
		const { db } = tmpDb();
		expect(createArtifact(db, { kind: "doc", title: "D" }).status).toBe("draft");
		expect(createArtifact(db, { kind: "task", title: "T" }).status).toBe("todo");
		expect(createArtifact(db, { kind: "rule", title: "R" }).status).toBe("active");
		expect(createArtifact(db, { kind: "playbook", title: "P" }).status).toBe("active");
		db.close();
	});

	it("default status per kind is immune to status row order (the root cause of a real production defect)", () => {
		// defaultStatusFor once picked whichever status row happened to be first by rowid --
		// correct on a freshly seeded database, but wrong on a migrated one where a legacy
		// status collided with a newly seeded name and kept the older, lower rowid. Reproduce
		// that adversarial row order directly for every kind and assert the documented default
		// still wins regardless of physical row order.
		const { db } = tmpDb();
		for (const [kind, correctDefault] of [
			["doc", "draft"],
			["task", "todo"],
			["rule", "active"],
			["playbook", "active"],
		] as const) {
			const rows = db.prepare("SELECT name FROM statuses WHERE kind = ?").all(kind) as Array<{ name: string }>;
			db.prepare("DELETE FROM statuses WHERE kind = ?").run(kind);
			for (const row of rows)
				if (row.name !== correctDefault) db.prepare("INSERT INTO statuses (name, kind) VALUES (?, ?)").run(row.name, kind);
			db.prepare("INSERT INTO statuses (name, kind) VALUES (?, ?)").run(correctDefault, kind); // documented default now rowid-last
			const rowidFirst = db.prepare("SELECT name FROM statuses WHERE kind = ? ORDER BY rowid LIMIT 1").get(kind) as { name: string };
			expect(rowidFirst.name).not.toBe(correctDefault); // sanity: the adversarial condition actually holds
			expect(createArtifact(db, { kind, title: `${kind}-adversarial` }).status).toBe(correctDefault);
		}
		db.close();
	});

	it("universal links — any kind to any kind", () => {
		const { db } = tmpDb();
		const doc = createArtifact(db, { kind: "doc", title: "Spec" });
		const task = createArtifact(db, { kind: "task", title: "Do it" });
		const rule = createArtifact(db, { kind: "rule", title: "Test first" });
		const playbook = createArtifact(db, { kind: "playbook", title: "TDD" });

		// task follows rule
		linkArtifacts(db, task.id!, "follows", rule.id!);
		// task implements doc
		linkArtifacts(db, task.id!, "implements", doc.id!);
		// playbook triggers task
		linkArtifacts(db, playbook.id!, "triggers", task.id!);
		// rule gates task
		linkArtifacts(db, rule.id!, "gates", task.id!);
		// doc documents playbook
		linkArtifacts(db, doc.id!, "documents", playbook.id!);
		// doc references doc (chaining)
		const doc2 = createArtifact(db, { kind: "doc", title: "Related spec" });
		linkArtifacts(db, doc.id!, "references", doc2.id!);

		const tree = getArtifact(db, task.id!, { tree: true })!;
		expect(tree.edges!.length).toBeGreaterThanOrEqual(4);
		db.close();
	});

	it("task with gates in extra", () => {
		const { db, dir } = tmpDb();
		const target = join(dir, "out.txt");
		writeFileSync(target, "hello world");

		const task = createArtifact(db, {
			kind: "task",
			title: "Gated task",
			extra: {
				gates: [
					{ type: "file-exists", target },
					{ type: "contains", target, expect: "hello" },
					{ type: "contains", target, expect: "missing" },
				],
			},
		});
		const results = runGates(db, task.id!);
		expect(results).toHaveLength(3);
		expect(results[0]!.passed).toBe(true);
		expect(results[1]!.passed).toBe(true);
		expect(results[2]!.passed).toBe(false);
		db.close();
	});

	// Real incident: a command gate with no explicit cwd inherited the Papyrus daemon's own
	// process cwd (its systemd unit's launch directory) instead of the task's project, so a gate
	// like `bun test` recursively discovered and ran every test file under every project on the
	// machine -- exhausting memory and crashing the bun process. These two tests prove `cwd` is
	// honored, for both the sync and async gate runners.
	it("runGates (sync): a command gate runs in the given cwd, not the process's own working directory", () => {
		const { db, dir } = tmpDb();
		writeFileSync(join(dir, "marker.txt"), "present");
		const task = createArtifact(db, {
			kind: "task",
			title: "CWD gate",
			extra: { gates: [{ type: "command", target: "ls", expect: "marker.txt" }] },
		});

		const withoutCwd = runGates(db, task.id!);
		expect(withoutCwd[0]?.passed).toBe(false);

		const withCwd = runGates(db, task.id!, { cwd: dir });
		expect(withCwd[0]?.passed).toBe(true);
		db.close();
	});

	it("runGatesAsync: a command gate runs in the given cwd, not the process's own working directory", async () => {
		const { db, dir } = tmpDb();
		writeFileSync(join(dir, "marker.txt"), "present");
		const task = createArtifact(db, {
			kind: "task",
			title: "CWD gate async",
			extra: { gates: [{ type: "command", target: "ls", expect: "marker.txt" }] },
		});

		const withoutCwd = await runGatesAsync(db, task.id!);
		expect(withoutCwd[0]?.passed).toBe(false);

		const withCwd = await runGatesAsync(db, task.id!, { cwd: dir });
		expect(withCwd[0]?.passed).toBe(true);
		db.close();
	});

	it("runGatesAsync: kills the whole process group on timeout, so a real grandchild does not survive it", async () => {
		// A prior implementation only ever signaled the immediate shell exec() spawned; a
		// backgrounded grandchild (like `bun` under `sh -c "bun test"`) was never killed by that
		// signal and kept running -- and consuming memory -- long after Papyrus considered the gate
		// timed out. `sleep 5 & ... ; wait` forces a real forked grandchild (not a tail-call-
		// optimized single process image) so this test can prove that grandchild is actually gone.
		const { db, dir } = tmpDb();
		const pidFile = join(dir, "child.pid");
		const task = createArtifact(db, {
			kind: "task",
			title: "Timeout kills the group",
			extra: { gates: [{ type: "command", target: `sh -c 'sleep 5 & echo $! > ${pidFile}; wait'` }] },
		});

		const results = await runGatesAsync(db, task.id!, { deadlineMs: Date.now() + 300 });
		expect(results[0]?.passed).toBe(false);
		expect(results[0]?.output).toContain("timed out");

		// Give the SIGKILL a moment to actually land before checking.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(Number.isInteger(grandchildPid)).toBe(true);
		expect(() => process.kill(grandchildPid, 0)).toThrow();
		db.close();
	});

	it("runGatesAsync: a gate's own explicit timeoutMs overrides the type default, not just the aggregate deadlineMs", async () => {
		// GATE_COMMAND_TIMEOUT_MS defaults to 30s -- proving this override actually takes effect
		// (not just being silently accepted and ignored, the exact bug this fixes) means the gate must
		// time out FAR sooner than that default once timeoutMs is set, without any aggregate deadlineMs
		// involved at all.
		const { db, dir } = tmpDb();
		const pidFile = join(dir, "child.pid");
		const task = createArtifact(db, {
			kind: "task",
			title: "Per-gate timeout override",
			extra: { gates: [{ type: "command", target: `sh -c 'sleep 5 & echo $! > ${pidFile}; wait'`, timeoutMs: 300 }] },
		});

		const started = Date.now();
		const results = await runGatesAsync(db, task.id!);
		const elapsedMs = Date.now() - started;
		expect(results[0]?.passed).toBe(false);
		expect(results[0]?.output).toContain("timed out after 300ms");
		expect(elapsedMs).toBeLessThan(5_000);

		await new Promise((resolve) => setTimeout(resolve, 300));
		const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(() => process.kill(grandchildPid, 0)).toThrow();
		db.close();
	});

	it("runGates (sync): a gate's own explicit timeoutMs overrides the type default too, not just the async path", () => {
		const { db } = tmpDb();
		const task = createArtifact(db, {
			kind: "task",
			title: "Per-gate timeout override sync",
			extra: { gates: [{ type: "command", target: "sleep 5", timeoutMs: 300 }] },
		});

		const started = Date.now();
		const results = runGates(db, task.id!);
		const elapsedMs = Date.now() - started;
		expect(results[0]?.passed).toBe(false);
		expect(elapsedMs).toBeLessThan(5_000);
		db.close();
	});

	// Real bug: execSync's return value is stdout only. A command that writes its actual result to
	// stderr (bun test's own per-test lines and pass/fail summary among them) always failed its
	// gate.expect match, regardless of whether the command truly passed.
	it("runGates (sync): a command gate's expect match sees stderr output too, not stdout only", () => {
		const { db } = tmpDb();
		const task = createArtifact(db, {
			kind: "task",
			title: "stderr gate",
			extra: { gates: [{ type: "command", target: "echo only-on-stderr 1>&2", expect: "only-on-stderr" }] },
		});
		const results = runGates(db, task.id!);
		expect(results[0]?.passed).toBe(true);
		db.close();
	});

	it("runGatesAsync: a command gate's expect match sees stderr output too, not stdout only", async () => {
		const { db } = tmpDb();
		const task = createArtifact(db, {
			kind: "task",
			title: "stderr gate async",
			extra: { gates: [{ type: "command", target: "echo only-on-stderr 1>&2", expect: "only-on-stderr" }] },
		});
		const results = await runGatesAsync(db, task.id!);
		expect(results[0]?.passed).toBe(true);
		db.close();
	});

	/**
	 * Real bug: runGates (sync)'s "test" case never checked gate.expect at all -- passed:true on any
	 * zero-exit test run, full stop -- while runGatesAsync's unified command+test branch does check
	 * it. Same expect string, same target, must agree between sync and async.
	 *
	 * target is a full `bun test <file>` command (matching every real gate/checklist example in
	 * this codebase, and the exact shape ab1463e2 used), not a bare pattern -- "test" must run it
	 * verbatim, not wrap it under vitest (see processGateCommand's own doc comment).
	 */
	describe("test-type gate: sync and async must agree on gate.expect, not just exit code", () => {
		function writeBunTestFile(dir: string, body: string): string {
			const path = join(dir, "gate.test.ts");
			writeFileSync(path, `import { test, expect } from "bun:test";\n${body}\n`);
			return path;
		}

		it("runGates (sync): fails when the test passes but gate.expect does not appear in the output", () => {
			const { db, dir } = tmpDb();
			const target = writeBunTestFile(dir, `test("passes", () => { console.log("actual output"); expect(1).toBe(1); });`);
			const task = createArtifact(db, {
				kind: "task",
				title: "test gate",
				extra: { gates: [{ type: "test", target: `bun test ${target}`, expect: "this string never appears" }] },
			});
			const results = runGates(db, task.id!, { cwd: dir });
			expect(results[0]?.passed).toBe(false);
			db.close();
		}, 30_000);

		it("runGatesAsync: fails when the test passes but gate.expect does not appear in the output (same target as the sync case)", async () => {
			const { db, dir } = tmpDb();
			const target = writeBunTestFile(dir, `test("passes", () => { console.log("actual output"); expect(1).toBe(1); });`);
			const task = createArtifact(db, {
				kind: "task",
				title: "test gate async",
				extra: { gates: [{ type: "test", target: `bun test ${target}`, expect: "this string never appears" }] },
			});
			const results = await runGatesAsync(db, task.id!, { cwd: dir });
			expect(results[0]?.passed).toBe(false);
			db.close();
		}, 30_000);

		it("runGates (sync): passes when the test passes and gate.expect does appear in the output", () => {
			const { db, dir } = tmpDb();
			const target = writeBunTestFile(dir, `test("passes", () => { console.log("a marker string"); expect(1).toBe(1); });`);
			const task = createArtifact(db, {
				kind: "task",
				title: "test gate ok",
				extra: { gates: [{ type: "test", target: `bun test ${target}`, expect: "a marker string" }] },
			});
			const results = runGates(db, task.id!, { cwd: dir });
			expect(results[0]?.passed).toBe(true);
			db.close();
		}, 30_000);

		it("runGates (sync): a full-command target runs verbatim instead of being wrapped and mis-parsed by vitest (real incident: task ab1463e2)", () => {
			const { db, dir } = tmpDb();
			const target = writeBunTestFile(dir, `test("passes", () => { expect(1).toBe(1); });`);
			const task = createArtifact(db, {
				kind: "task",
				title: "verbatim test gate",
				extra: { gates: [{ type: "test", target: `bun test ${target}` }] },
			});
			const results = runGates(db, task.id!, { cwd: dir });
			expect(results[0]?.passed).toBe(true);
			db.close();
		}, 30_000);

		it("runGatesAsync: a full-command target runs verbatim instead of being wrapped and mis-parsed by vitest (real incident: task ab1463e2)", async () => {
			const { db, dir } = tmpDb();
			const target = writeBunTestFile(dir, `test("passes", () => { expect(1).toBe(1); });`);
			const task = createArtifact(db, {
				kind: "task",
				title: "verbatim test gate async",
				extra: { gates: [{ type: "test", target: `bun test ${target}` }] },
			});
			const results = await runGatesAsync(db, task.id!, { cwd: dir });
			expect(results[0]?.passed).toBe(true);
			db.close();
		}, 30_000);
	});

	// Real bug: runGatesAsync matched gate.expect against output already truncated to
	// GATE_OUTPUT_LIMIT (200 chars) for display, so an expect string appearing only near the end of
	// a long, real command's output (exactly where a test runner's pass/fail summary lives) never
	// matched even though the command genuinely produced it.
	it("runGatesAsync: a command gate's expect match sees the full output, not just the first 200 characters kept for display", async () => {
		const { db } = tmpDb();
		const task = createArtifact(db, {
			kind: "task",
			title: "long output gate",
			extra: {
				gates: [
					{
						type: "command",
						target: "node -e \"console.log('x'.repeat(500)); console.log('FOUND-AT-THE-END')\"",
						expect: "FOUND-AT-THE-END",
					},
				],
			},
		});
		const results = await runGatesAsync(db, task.id!);
		expect(results[0]?.passed).toBe(true);
		db.close();
	});

	// Real gap (papyrus task d0eb81b7): GATE_OUTPUT_LIMIT was 200 characters, sliced from the
	// START of the buffer -- for a real, longer-running command (e.g. a full bun test run), the
	// meaningful pass/fail summary lives at the END, not the start, so a failing gate's own
	// `output` field carried none of the actually diagnostic content: just the first line or two
	// of banner/setup noise. Both the sync and async paths must show a real tail, not a head, and
	// enough of it to actually diagnose a failure from.
	describe("gate output carries a genuinely diagnostic tail, not a truncated head", () => {
		const LONG_OUTPUT_COMMAND = "node -e \"console.log('x'.repeat(2000)); console.log('DIAGNOSTIC-SUMMARY-AT-THE-END')\"";

		it("runGates (sync): a long command's displayed output ends with its own real tail, not truncated mid-noise", () => {
			const { db } = tmpDb();
			const task = createArtifact(db, {
				kind: "task",
				title: "long output gate (sync)",
				extra: { gates: [{ type: "command", target: LONG_OUTPUT_COMMAND }] },
			});
			const results = runGates(db, task.id!);
			expect(results[0]?.output).toContain("DIAGNOSTIC-SUMMARY-AT-THE-END");
			expect(results[0]?.output.length).toBeGreaterThan(200);
			db.close();
		});

		it("runGatesAsync: a long command's displayed output ends with its own real tail, not truncated mid-noise", async () => {
			const { db } = tmpDb();
			const task = createArtifact(db, {
				kind: "task",
				title: "long output gate (async)",
				extra: { gates: [{ type: "command", target: LONG_OUTPUT_COMMAND }] },
			});
			const results = await runGatesAsync(db, task.id!);
			expect(results[0]?.output).toContain("DIAGNOSTIC-SUMMARY-AT-THE-END");
			expect(results[0]?.output.length).toBeGreaterThan(200);
			db.close();
		});
	});

	it("rule with condition/action/severity in extra", () => {
		const { db } = tmpDb();
		const rule = createArtifact(db, {
			kind: "rule",
			title: "Always run tsc before commit",
			extra: { condition: "before git commit", action: "bun x tsc --noEmit", severity: "block" },
		});
		expect(rule.extra.condition).toBe("before git commit");
		expect(rule.extra.severity).toBe("block");
		db.close();
	});

	it("playbook with trigger/steps/tools in extra", () => {
		const { db } = tmpDb();
		const playbook = createArtifact(db, {
			kind: "playbook",
			title: "TDD cycle",
			extra: { trigger: "writing new code", steps: ["write failing test", "implement", "refactor"], tools: ["bun test", "tsc"] },
		});
		expect((playbook.extra.steps as string[]).length).toBe(3);
		expect((playbook.extra.tools as string[]).length).toBe(2);
		db.close();
	});

	it("full-text search across title and body", () => {
		const { db } = tmpDb();
		createArtifact(db, { kind: "doc", title: "SQLite architecture", body: "The WAL journal mode..." });
		createArtifact(db, { kind: "task", title: "Fix bug", body: "SQLite busy error on concurrent writes" });
		createArtifact(db, { kind: "doc", title: "Unrelated", body: "nothing here" });

		expect(queryArtifacts(db, { text: "SQLite" })).toHaveLength(2);
		expect(queryArtifacts(db, { text: "WAL" })).toHaveLength(1);
		expect(queryArtifacts(db, { text: "nothing" })).toHaveLength(1);
		db.close();
	});

	it("ids filter restricts to exactly the given ids, and an empty array is a real match-nothing rather than unset", () => {
		const { db } = tmpDb();
		const a = createArtifact(db, { kind: "task", title: "A" });
		const b = createArtifact(db, { kind: "task", title: "B" });
		createArtifact(db, { kind: "task", title: "C" });

		expect(
			queryArtifacts(db, { ids: [a.id, b.id] })
				.map((row) => row.id)
				.sort(),
		).toEqual([a.id, b.id].sort());
		expect(queryArtifacts(db, { ids: [] })).toEqual([]);
		db.close();
	});

	it("subgraph BFS from root", () => {
		const { db } = tmpDb();
		const root = createArtifact(db, { kind: "task", title: "Ship v1" });
		const t1 = createArtifact(db, { kind: "task", title: "Task A" });
		const t2 = createArtifact(db, { kind: "task", title: "Task B" });
		const doc = createArtifact(db, { kind: "doc", title: "Design doc" });
		const rule = createArtifact(db, { kind: "rule", title: "Test everything" });

		linkArtifacts(db, root.id!, "depends_on", t1.id!);
		linkArtifacts(db, t1.id!, "depends_on", t2.id!);
		linkArtifacts(db, t1.id!, "implements", doc.id!);
		linkArtifacts(db, t1.id!, "follows", rule.id!);

		const tree = getArtifact(db, root.id!, { tree: true })!;
		// BFS should reach: root → t1 → t2, doc, rule (5 artifacts, 4 edges)
		expect(tree.edges!.length).toBe(4);
		expect(tree.edges!.some((e) => e.from === t1.id && e.relation === "depends_on" && e.to === t2.id)).toBe(true);
		expect(tree.edges!.some((e) => e.from === t1.id && e.relation === "follows" && e.to === rule.id)).toBe(true);
		db.close();
	});

	it("bounds hierarchy traversal by depth and node count", () => {
		const { db } = tmpDb();
		const root = createArtifact(db, { kind: "task", title: "Epic" });
		const child = createArtifact(db, { kind: "task", title: "Child" });
		const grandchild = createArtifact(db, { kind: "task", title: "Grandchild" });
		const leaf = createArtifact(db, { kind: "task", title: "Leaf" });

		linkArtifacts(db, root.id, "contains", child.id);
		linkArtifacts(db, child.id, "part_of", root.id);
		linkArtifacts(db, child.id, "contains", grandchild.id);
		linkArtifacts(db, grandchild.id, "contains", leaf.id);
		linkArtifacts(db, leaf.id, "relates_to", child.id); // cycle without a root shortcut

		const oneLevel = getArtifact(db, root.id, { tree: true, depth: 1, maxNodes: 10 })!;
		expect(oneLevel.edges).toHaveLength(2);
		expect(oneLevel.edges!.every((edge) => [root.id, child.id].includes(edge.from) && [root.id, child.id].includes(edge.to))).toBe(true);

		const twoNodes = getArtifact(db, root.id, { tree: true, depth: 10, maxNodes: 2 })!;
		expect(twoNodes.edges).toHaveLength(2);
		expect(twoNodes.edges!.some((edge) => edge.to === grandchild.id)).toBe(false);
		db.close();
	});

	it("instantiates an artifact template with deep defaults", () => {
		const { db } = tmpDb();
		const template = createArtifact(db, {
			kind: "doc",
			subtype: "artifact-template",
			title: "Frontend task template",
			extra: {
				targetKind: "task",
				defaults: {
					body: "Deliver an interactive frontend.",
					labels: ["frontend"],
					extra: {
						checklist: ["Write failing test", "Implement", "Verify"],
						gates: [{ type: "command", target: "bun test" }],
					},
				},
				required: ["title", "extra.owner"],
			},
		});

		const task = createArtifact(db, {
			templateId: template.id,
			title: "Build documents frontend",
			extra: { owner: "agent", checklist: ["Override first"] },
		});

		expect(task.kind).toBe("task");
		expect(task.body).toBe("Deliver an interactive frontend.");
		expect(task.labels).toEqual(["frontend"]);
		expect(task.extra.owner).toBe("agent");
		expect(task.extra.checklist).toEqual(["Override first"]);
		expect(task.extra.gates).toEqual([{ type: "command", target: "bun test" }]);
		db.close();
	});

	it("rejects missing template requirements and target-kind mismatches", () => {
		const { db } = tmpDb();
		const template = createArtifact(db, {
			kind: "doc",
			subtype: "artifact-template",
			title: "Owned task",
			extra: { targetKind: "task", required: ["title", "extra.owner"] },
		});

		expect(() => createArtifact(db, { templateId: template.id, title: "No owner" })).toThrow("missing required template field");
		expect(() => createArtifact(db, { templateId: template.id, kind: "doc", title: "Wrong kind", extra: { owner: "agent" } })).toThrow(
			"targets kind",
		);
		db.close();
	});
});
