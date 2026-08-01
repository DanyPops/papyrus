import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planPlaybookCommandRegistrations, playbookCommandName, registerPlaybookBridge } from "../extension/src/playbook-bridge.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

afterEach(resetPapyrusClientForTests);

function mockPlaybooksList(playbooks: unknown[], invocationResult: unknown = { entryTaskId: "t1", created: { tasks: ["t1"] } }): void {
	setPapyrusClientConnectorForTests(
		async () =>
			({
				async call(operation: string, input: any) {
					if (operation === "playbooks.list") {
						expect(input).toMatchObject({ status: "active" });
						return playbooks;
					}
					if (operation === "playbooks.invoke") return invocationResult;
					throw new Error(`unexpected operation ${operation}`);
				},
			}) as any,
	);
}

const PLAYBOOK = {
	id: "p1",
	kind: "playbook",
	subtype: "",
	title: "New Project",
	status: "active",
	body: "",
	labels: [],
	extra: { trigger: "starting from scratch", steps: ["Frame the problem", "State the goal"], tools: ["discuss"] },
	created_at: "x",
	updated_at: "x",
};

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function fakePi(): { pi: ExtensionAPI; commands: Map<string, RegisteredCommand> } {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		registerCommand: (name: string, options: RegisteredCommand) => {
			commands.set(name, options);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		async fireResourcesDiscover() {
			for (const handler of handlers.get("resources_discover") ?? []) await handler();
		},
	} as unknown as ExtensionAPI & { fireResourcesDiscover: () => Promise<void> };
	return { pi, commands };
}

describe("playbook-bridge: materializes active Playbooks as their own /playbook:name commands", () => {
	it("names a command playbook:<slugified-title>", () => {
		expect(playbookCommandName("New Project")).toBe("playbook:new-project");
		expect(playbookCommandName("Weird !!! Title")).toBe("playbook:weird-title");
	});

	it("plans one registration per active playbook, with the trigger as the description", async () => {
		mockPlaybooksList([PLAYBOOK]);
		const plan = await planPlaybookCommandRegistrations();
		expect(plan).toEqual([{ name: "playbook:new-project", id: "p1", title: "New Project", trigger: "starting from scratch" }]);
	});

	it("disambiguates a real title collision by suffixing the id, rather than one playbook shadowing another", async () => {
		mockPlaybooksList([
			{ ...PLAYBOOK, id: "p1", title: "Same Title" },
			{ ...PLAYBOOK, id: "p2", title: "Same Title" },
		]);
		const plan = await planPlaybookCommandRegistrations();
		expect(plan.map((entry) => entry.name)).toEqual(["playbook:same-title", "playbook:same-title-p2"]);
	});

	it("registers a real /playbook:<slug> command via pi.registerCommand on resources_discover (session start and /reload)", async () => {
		mockPlaybooksList([PLAYBOOK]);
		const { pi, commands } = fakePi();
		registerPlaybookBridge(pi);
		await (pi as unknown as { fireResourcesDiscover: () => Promise<void> }).fireResourcesDiscover();
		expect(commands.has("playbook:new-project")).toBe(true);
		expect(commands.get("playbook:new-project")?.description).toBe("starting from scratch");
	});

	it("the command's handler re-fetches the live playbook by id at invocation time, invokes it (materializing real tasks), and reports the focused entry task", async () => {
		mockPlaybooksList([PLAYBOOK], { entryTaskId: "t1", created: { tasks: ["t0", "t1"] } });
		const { pi, commands } = fakePi();
		registerPlaybookBridge(pi);
		await (pi as unknown as { fireResourcesDiscover: () => Promise<void> }).fireResourcesDiscover();
		const notifications: Array<{ message: string; type?: string }> = [];
		const setTexts: string[] = [];
		const ctx = {
			ui: {
				setEditorText: (text: string) => setTexts.push(text),
				notify: (message: string, type?: string) => notifications.push({ message, type }),
			},
		};
		await commands.get("playbook:new-project")!.handler("", ctx);
		expect(setTexts).toEqual(['Run the "New Project" playbook -- work on the currently focused task.']);
		expect(notifications).toEqual([{ message: '"New Project" invoked: entry task t1 focused', type: "info" }]);
	});

	it("a lingering stale command (renamed/disabled since registration, since registerCommand can't be unregistered) fails cleanly instead of running deleted content", async () => {
		const { pi, commands } = fakePi();
		mockPlaybooksList([PLAYBOOK]);
		registerPlaybookBridge(pi);
		await (pi as unknown as { fireResourcesDiscover: () => Promise<void> }).fireResourcesDiscover();

		// The playbook is gone by the time the (still-registered) command is actually invoked.
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call(operation: string) {
						if (operation === "playbooks.invoke") throw new Error('artifact "p1" not found');
						throw new Error(`unexpected operation ${operation}`);
					},
				}) as any,
		);
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = { ui: { setEditorText: () => {}, notify: (message: string, type?: string) => notifications.push({ message, type }) } };
		await commands.get("playbook:new-project")!.handler("", ctx);
		expect(notifications).toEqual([{ message: 'artifact "p1" not found', type: "error" }]);
	});

	it("a Papyrus daemon hiccup during refresh degrades to no new/updated commands, never throws", async () => {
		setPapyrusClientConnectorForTests(
			async () =>
				({
					async call() {
						throw new Error("daemon unreachable");
					},
				}) as any,
		);
		const { pi, commands } = fakePi();
		registerPlaybookBridge(pi);
		await expect((pi as unknown as { fireResourcesDiscover: () => Promise<void> }).fireResourcesDiscover()).resolves.toBeUndefined();
		expect(commands.size).toBe(0);
	});

	it("returns no registrations when there are no active playbooks", async () => {
		mockPlaybooksList([]);
		expect(await planPlaybookCommandRegistrations()).toEqual([]);
	});
});
