/**
 * Regression fixture for papyrus-defect-session-scoped-task-focus-was-built-and-teste-qu88:
 * session-scoped Task Focus was correct at the unit/single-action level (see
 * test/task-focus-scope.test.ts) but was never exercised as multiple genuinely concurrent
 * sessions interleaving realistic sequences of work -- create, focus, pause, unpause,
 * refocus -- against one shared daemon operation layer, which is exactly the shape of the
 * live symptom (a different session's Focus action silently overwrote this one's).
 *
 * Simulates three simulated sessions (mirroring the standalone Discourse multi-agent
 * coordination proof's shape: independent identities sharing one durable backend) whose
 * operations are interleaved step-by-step, not run session-by-session to completion, so a
 * bug that only shows up under real interleaving (not "session A finishes, then session B
 * starts") cannot hide.
 */
import { describe, expect, it } from "bun:test";
import { createPapyrusService } from "../src/service.ts";

const PROJECT_ROOT = "/workspace/papyrus";

interface CliArtifact { id: string; title: string; status: string }
interface FocusState { artifact: CliArtifact; status: "active" | "paused" } 

describe("session-scoped Task Focus survives interleaved multi-session work without any session observing or mutating another's Focus", () => {
	it("three sessions each create, focus, pause, unpause, and refocus, interleaved step by step", async () => {
		const service = createPapyrusService(":memory:");
		const sessions = ["session-alice", "session-bob", "session-carol"] as const;

		// Step 1 (interleaved): each session creates its own artifact. Artifacts are shared
		// Context Mesh state by design -- every session can see every artifact -- but Focus is not.
		const tasksBySession: Record<string, CliArtifact> = {};
		for (const sessionId of sessions) {
			tasksBySession[sessionId] = await service.execute("tasks.create", {
				title: `${sessionId}'s task`, project_root: PROJECT_ROOT,
			}) as CliArtifact;
		}
		// A second task per session, to focus/refocus onto later.
		const secondTasksBySession: Record<string, CliArtifact> = {};
		for (const sessionId of sessions) {
			secondTasksBySession[sessionId] = await service.execute("tasks.create", {
				title: `${sessionId}'s second task`, project_root: PROJECT_ROOT,
			}) as CliArtifact;
		}

		// Every session can see every artifact -- shared graph, not shared Focus.
		const allTasks = await service.execute("tasks.list", { project_root: PROJECT_ROOT, session_id: "session-alice" }) as CliArtifact[];
		expect(allTasks).toHaveLength(6);

		// Step 2 (interleaved): each session focuses its own first task, one after another,
		// not batched -- if Focus were a single shared slot, each successive focus call would
		// silently clobber the previous session's.
		for (const sessionId of sessions) {
			await service.execute("tasks.focus", { id: tasksBySession[sessionId]!.id, session_id: sessionId });
		}
		for (const sessionId of sessions) {
			const active = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: sessionId }) as CliArtifact | null;
			expect(active?.id).toBe(tasksBySession[sessionId]!.id);
		}

		// Step 3 (interleaved): pause alice, leave bob and carol active, in between other
		// sessions' operations -- not "pause everyone then check everyone."
		await service.execute("tasks.pause", { actor: "test", source: "test", session_id: "session-alice", reason: "manual pause" });
		const bobStillActive = await service.execute("tasks.focused", { project_root: PROJECT_ROOT, session_id: "session-bob" }) as FocusState | null;
		expect(bobStillActive?.status).toBe("active");
		const aliceNowPaused = await service.execute("tasks.focused", { project_root: PROJECT_ROOT, session_id: "session-alice" }) as FocusState | null;
		expect(aliceNowPaused?.status).toBe("paused");
		const carolStillActive = await service.execute("tasks.focused", { project_root: PROJECT_ROOT, session_id: "session-carol" }) as FocusState | null;
		expect(carolStillActive?.status).toBe("active");

		// Step 4 (interleaved): carol refocuses onto her second task while alice is still
		// paused and bob is untouched -- three different Focus states coexisting.
		await service.execute("tasks.focus", { id: secondTasksBySession["session-carol"]!.id, session_id: "session-carol" });
		const carolRefocused = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "session-carol" }) as CliArtifact | null;
		expect(carolRefocused?.id).toBe(secondTasksBySession["session-carol"]!.id);

		// Step 5: unpause alice. Bob and carol must be completely unaffected by this.
		await service.execute("tasks.unpause", { actor: "test", source: "test", session_id: "session-alice" });
		const aliceResumed = await service.execute("tasks.focused", { project_root: PROJECT_ROOT, session_id: "session-alice" }) as FocusState | null;
		expect(aliceResumed?.status).toBe("active");
		expect(aliceResumed?.artifact.id).toBe(tasksBySession["session-alice"]!.id); // still her original task, not clobbered
		const bobUnaffected = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "session-bob" }) as CliArtifact | null;
		expect(bobUnaffected?.id).toBe(tasksBySession["session-bob"]!.id);
		const carolUnaffected = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "session-carol" }) as CliArtifact | null;
		expect(carolUnaffected?.id).toBe(secondTasksBySession["session-carol"]!.id);

		// Step 6: bob clears his focus entirely. Alice and carol must be completely unaffected.
		await service.execute("tasks.clear_focus", { actor: "test", source: "test", session_id: "session-bob" });
		expect(await service.execute("tasks.focused", { project_root: PROJECT_ROOT, session_id: "session-bob" })).toBeNull();
		const aliceStillThere = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "session-alice" }) as CliArtifact | null;
		expect(aliceStillThere?.id).toBe(tasksBySession["session-alice"]!.id);
		const carolStillThere = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "session-carol" }) as CliArtifact | null;
		expect(carolStillThere?.id).toBe(secondTasksBySession["session-carol"]!.id);

		// Final cross-check: each session's own context injection reflects only its own
		// focus, never leaking another session's task title.
		const aliceContext = await service.execute("tasks.context", { project_root: PROJECT_ROOT, session_id: "session-alice" }) as string;
		expect(aliceContext).toContain("session-alice's task");
		expect(aliceContext).not.toContain("session-carol's second task");

		service.close();
	});

	it("a caller that omits session_id entirely uses the shared global scope, isolated from every explicitly-scoped session", async () => {
		const service = createPapyrusService(":memory:");
		const globalTask = await service.execute("tasks.create", { title: "unscoped work", project_root: PROJECT_ROOT }) as CliArtifact;
		const scopedTask = await service.execute("tasks.create", { title: "session-scoped work", project_root: PROJECT_ROOT }) as CliArtifact;

		await service.execute("tasks.focus", { id: globalTask.id }); // no session_id -- global scope
		await service.execute("tasks.focus", { id: scopedTask.id, session_id: "session-dedicated" });

		const globalActive = await service.execute("tasks.active", { project_root: PROJECT_ROOT }) as CliArtifact | null;
		expect(globalActive?.id).toBe(globalTask.id);
		const scopedActive = await service.execute("tasks.active", { project_root: PROJECT_ROOT, session_id: "session-dedicated" }) as CliArtifact | null;
		expect(scopedActive?.id).toBe(scopedTask.id);

		service.close();
	});
});
