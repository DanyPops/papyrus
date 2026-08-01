import { describe, expect, it } from "bun:test";
import { killStalePapyrusDaemon } from "../src/client.ts";

/**
 * connectPapyrusClient wires vehicle-client's connectWithVersionCheck (see
 * client.ts) to detect and replace a daemon running stale code. Its core
 * mechanics are covered by @danypops/vehicle-client's own suite; what's
 * Papyrus-specific is killStalePapyrusDaemon, the one callback this package
 * supplies.
 */
describe("killStalePapyrusDaemon", () => {
	it("skips a pid <= 0 -- daemon-state.ts's inert 'unknown pid' sentinel for a handle written before the pid field existed", () => {
		const calls: unknown[] = [];
		const originalKill = process.kill;
		process.kill = ((...args: unknown[]) => {
			calls.push(args);
			return true;
		}) as typeof process.kill;
		try {
			killStalePapyrusDaemon({ pid: 0 });
			expect(calls).toEqual([]);
		} finally {
			process.kill = originalKill;
		}
	});

	it("sends SIGTERM to a real pid", () => {
		const calls: unknown[] = [];
		const originalKill = process.kill;
		process.kill = ((...args: unknown[]) => {
			calls.push(args);
			return true;
		}) as typeof process.kill;
		try {
			killStalePapyrusDaemon({ pid: 4242 });
			expect(calls).toEqual([[4242, "SIGTERM"]]);
		} finally {
			process.kill = originalKill;
		}
	});

	it("swallows a kill failure against an already-dead pid -- the caller's handle-file poll is the real guarantee, not this call succeeding", () => {
		const originalKill = process.kill;
		process.kill = (() => {
			throw new Error("ESRCH");
		}) as unknown as typeof process.kill;
		try {
			expect(() => killStalePapyrusDaemon({ pid: 4242 })).not.toThrow();
		} finally {
			process.kill = originalKill;
		}
	});
});
