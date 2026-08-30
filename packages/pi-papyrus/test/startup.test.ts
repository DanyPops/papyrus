import { afterEach, describe, expect, it } from "bun:test";
import type { PapyrusClient } from "@danypops/papyrus";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import registerPapyrus, { NoteOverlay } from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";

afterEach(() => {
	resetPapyrusClientForTests();
	resetVehicleClientTargetResolverForTests();
});

describe("pi-papyrus startup", () => {
	it("registers interactive commands synchronously while their TUI modules remain on demand", () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		const harness = createExtensionHarness(registerPapyrus);

		expect(harness.commands).toEqual(
			expect.arrayContaining(["tasks", "docs", "note", "notes", "rules", "playbooks", "playbook", "discuss"]),
		);
	});

	it("does not hold session_start behind passive daemon connection work", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));
		const harness = createExtensionHarness(registerPapyrus);

		const outcome = await Promise.race([
			harness.boot().then(() => "started" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
		]);

		expect(outcome).toBe("started");
		await harness.shutdown();
	});

	it("does not hold prompt submission behind task-resume daemon work", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		setPapyrusClientConnectorForTests(() => new Promise<PapyrusClient>(() => {}));
		const harness = createExtensionHarness(registerPapyrus);
		await harness.boot();

		const outcome = await Promise.race([
			harness.emit("input", { source: "interactive", text: "continue" }).then(() => "submitted" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
		]);

		expect(outcome).toBe("submitted");
		await harness.shutdown();
	});

	it("ignores a deferred widget result after the overlay is disposed", async () => {
		let resolveRows!: (rows: unknown[]) => void;
		const deferredRows = new Promise<unknown[]>((resolve) => {
			resolveRows = resolve;
		});
		setPapyrusClientConnectorForTests(() => Promise.resolve({ call: () => deferredRows } as unknown as PapyrusClient));
		const overlay = new NoteOverlay();
		overlay.setProjectRoot("/workspace");

		const refresh = overlay.refresh();
		overlay.dispose();
		resolveRows([
			{
				id: "note-1",
				title: "stale note",
			},
		]);
		await refresh;

		expect(overlay.hasOpenNotes()).toBe(false);
	});
});
