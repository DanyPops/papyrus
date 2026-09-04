import { describe, expect, it } from "bun:test";
import { ArtifactNavigationState } from "../extension/src/artifact/artifact-navigation-state.ts";

describe("ArtifactNavigationState", () => {
	it("supports Vim and bounded page movement", () => {
		const state = new ArtifactNavigationState(10);
		state.move(1);
		expect(state.selectedIndex).toBe(1);
		state.move(-1);
		expect(state.selectedIndex).toBe(0);
		state.move(-1);
		expect(state.selectedIndex).toBe(9);
		state.movePage(-1, 4);
		expect(state.selectedIndex).toBe(5);
		state.movePage(1, 20);
		expect(state.selectedIndex).toBe(9);
		state.first();
		expect(state.selectedIndex).toBe(0);
		state.last();
		expect(state.selectedIndex).toBe(9);
	});

	it("keeps empty lists safe", () => {
		const state = new ArtifactNavigationState(0);
		state.move(1);
		state.movePage(1, 10);
		state.last();
		expect(state.selectedIndex).toBe(0);
		state.setItemCount(2);
		state.last();
		state.setItemCount(0);
		expect(state.selectedIndex).toBe(0);
	});

	it("retains accepted filters and clears canceled filters", () => {
		const state = new ArtifactNavigationState(3);
		expect(state.mode).toBe("normal");
		state.enterFilter();
		state.setQuery("binder");
		state.leaveFilter();
		expect(state).toMatchObject({ mode: "normal", query: "binder" });
		state.enterFilter();
		state.leaveFilter(true);
		expect(state).toMatchObject({ mode: "normal", query: "" });
	});

	it("preserves navigation while toggling expansion", () => {
		const state = new ArtifactNavigationState(10);
		state.movePage(1, 5);
		state.enterFilter();
		state.setQuery("task");
		state.toggleExpanded();
		expect(state).toMatchObject({ selectedIndex: 5, mode: "filter", query: "task", expanded: true });
		state.toggleExpanded();
		expect(state).toMatchObject({ selectedIndex: 5, mode: "filter", expanded: false });
	});
});
