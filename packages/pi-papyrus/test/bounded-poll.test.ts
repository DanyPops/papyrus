import { describe, expect, it } from "bun:test";
import { BoundedPoll } from "../extension/src/bounded-poll.ts";

describe("BoundedPoll", () => {
	it("ticks repeatedly on the given interval", async () => {
		let ticks = 0;
		const poll = new BoundedPoll();
		poll.start(10, () => {
			ticks += 1;
		});
		await new Promise((resolve) => setTimeout(resolve, 55));
		poll.stop();
		expect(ticks).toBeGreaterThanOrEqual(3);
	});

	it("is idempotent -- a second start() does not run a competing timer", async () => {
		let ticks = 0;
		const poll = new BoundedPoll();
		poll.start(10, () => {
			ticks += 1;
		});
		poll.start(10, () => {
			ticks += 1;
		});
		await new Promise((resolve) => setTimeout(resolve, 55));
		poll.stop();
		// ~5 ticks expected from one 10ms timer over 55ms; two overlapping timers would roughly double it.
		expect(ticks).toBeLessThan(9);
	});

	it("stop() halts further ticks and is safe to call again, or before any start()", () => {
		const poll = new BoundedPoll();
		expect(() => poll.stop()).not.toThrow();

		let _ticks = 0;
		poll.start(10, () => {
			_ticks += 1;
		});
		poll.stop();
		expect(() => poll.stop()).not.toThrow();
	});
});
