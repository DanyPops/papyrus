import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { PLAYBOOKS_OPERATION_NAMES, playbooksOperations } from "../src/modules/playbooks.ts";
import { SQLiteScopeGroupStore } from "../src/scope-group/sqlite-scope-group-store.ts";
import { SessionIdentity } from "../src/session-identity/session-identity-service.ts";
import { SQLiteGateRunner } from "../src/stores/sqlite-gate-runner.ts";
import { SQLiteProjectRegistryStore } from "../src/stores/sqlite-project-registry-store.ts";
import { SQLiteSessionIdentityStore } from "../src/stores/sqlite-session-identity-store.ts";
import { SQLiteTaskEventStore } from "../src/stores/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/stores/sqlite-task-focus-store.ts";
import { SQLiteTaskLeaseStore } from "../src/stores/sqlite-task-lease-store.ts";
import { SQLiteTaskScopeStore } from "../src/stores/sqlite-task-scope-store.ts";
import { Tasks } from "../src/task/task-service.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const artifactScopes = new SQLiteArtifactScopeStore(db);
	const events = new SQLiteTaskEventStore(db);
	const scopes = new SQLiteTaskScopeStore(db);
	const tasks = new Tasks(artifacts, new SQLiteGateRunner(db), new SQLiteTaskFocusStore(db), events, scopes, new SQLiteTaskLeaseStore(db));
	const sessionIdentity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
	const projectRegistry = new SQLiteProjectRegistryStore(db);
	const scopeGroups = new SQLiteScopeGroupStore(db);
	const registry = new OperationRegistry();
	registry.registerAll(
		playbooksOperations({ artifacts, events, scopes, artifactScopes, tasks, sessionIdentity, registry: projectRegistry, scopeGroups }),
	);
	return { registry, artifacts, tasks };
}

describe("modules/playbooks — a Papyrus-native registered module, recycling the Skill workflow engine for invoke", () => {
	it("registers exactly the playbooks.* operations PLAYBOOKS_OPERATION_NAMES declares", () => {
		const { registry } = fixture();
		const registered = registry.list().filter((name) => name.startsWith("playbooks."));
		expect(registered).toEqual([...PLAYBOOKS_OPERATION_NAMES].sort());
	});

	it("accepts subtype and template_id at creation, matching docs.create's own parity (papyrus-defect-unify-template-subtype-53b3a1eb)", async () => {
		const { registry, artifacts } = fixture();
		const template = artifacts.create({
			kind: "playbook",
			subtype: "artifact-template",
			title: "Incident-response template",
			extra: { targetKind: "playbook", defaults: { subtype: "runbook" } },
		});
		const plain = (await registry.get("playbooks.create")!.execute({ title: "A playbook", subtype: "runbook" })) as { subtype: string };
		expect(plain.subtype).toBe("runbook");
		const fromTemplate = (await registry.get("playbooks.create")!.execute({ title: "From template", template_id: template.id })) as {
			subtype: string;
		};
		expect(fromTemplate.subtype).toBe("runbook");
	});

	it("previews a playbook as rendered text without creating any tasks", async () => {
		const { registry, artifacts } = fixture();
		const created = (await registry
			.get("playbooks.create")!
			.execute({ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] })) as { id: string };
		const preview = (await registry.get("playbooks.preview")!.execute({ id: created.id })) as string;
		expect(preview).toContain("1. Frame the problem");
		expect(artifacts.query({ kind: "task" })).toHaveLength(0);
	});

	it("invokes a playbook by materializing real tasks and focusing the entry task, not rendering text", async () => {
		const { registry, artifacts, tasks } = fixture();
		const created = (await registry
			.get("playbooks.create")!
			.execute({ title: "New Project", trigger: "starting from scratch", steps: ["Frame the problem"] })) as { id: string; kind: string };
		expect(created.kind).toBe("playbook");

		const invocation = (await registry.get("playbooks.invoke")!.execute({ id: created.id })) as {
			entryTaskId: string;
			created: { tasks: string[] };
			rootTaskIds: string[];
		};
		expect(invocation.created.tasks).toHaveLength(2); // container + one step
		const entry = artifacts.get(invocation.entryTaskId)!;
		expect(entry.kind).toBe("task");
		expect(entry.body).toBe("Frame the problem");
		expect(tasks.active()?.id).toBe(invocation.entryTaskId);

		const updated = (await registry.get("playbooks.update")!.execute({ id: created.id, title: "New Project v2" })) as { title: string };
		expect(updated.title).toBe("New Project v2");
		const shown = (await registry.get("playbooks.show")!.execute({ id: created.id })) as { id: string };
		expect(shown.id).toBe(created.id);
		const disabled = (await registry.get("playbooks.disable")!.execute({ id: created.id })) as { status: string };
		expect(disabled.status).toBe("deprecated");
	});

	it("revises steps/trigger through the real operation, end to end -- the exact gap this closes (no more create-new+supersedes+disable workaround)", async () => {
		const { registry } = fixture();
		const created = (await registry.get("playbooks.create")!.execute({
			title: "Add a tier",
			trigger: "When Zodiac needs a new tier",
			steps: ["Edit zodiac-web/src/tiers.ts"],
		})) as { id: string };

		const generalized = (await registry.get("playbooks.update")!.execute({
			id: created.id,
			trigger: "When a project needs a new tier",
			steps: ["Edit the project's own tiers module"],
		})) as { extra: { trigger: string; steps: unknown[] } };
		expect(generalized.extra.trigger).toBe("When a project needs a new tier");
		expect(generalized.extra.steps).toEqual(["Edit the project's own tiers module"]);

		const preview = (await registry.get("playbooks.preview")!.execute({ id: created.id })) as string;
		expect(preview).toContain("Edit the project's own tiers module");
		expect(preview).not.toContain("zodiac-web");
	});

	it("declares arguments at create; invoke without a required value creates nothing and reports it; invoke with the value substitutes it into the step task", async () => {
		const { registry, artifacts } = fixture();
		const created = (await registry.get("playbooks.create")!.execute({
			title: "Deploy service",
			trigger: "deploying",
			steps: ["Deploy to {{environment}}"],
			arguments: [{ name: "environment", required: true }],
		})) as { id: string };

		const withoutValue = (await registry.get("playbooks.invoke")!.execute({ id: created.id })) as { missingArguments?: string[] };
		expect(withoutValue.missingArguments).toEqual(["environment"]);
		expect(artifacts.query({ kind: "task" })).toHaveLength(0);

		const withValue = (await registry.get("playbooks.invoke")!.execute({ id: created.id, arguments: { environment: "staging" } })) as {
			entryTaskId: string;
		};
		const entry = artifacts.get(withValue.entryTaskId)!;
		expect(entry.body).toBe("Deploy to staging");
	});

	it("a typed (number) argument declared at create substitutes as a real number, not a stringified one, when the placeholder is the whole value", async () => {
		const { registry, artifacts } = fixture();
		const created = (await registry.get("playbooks.create")!.execute({
			title: "Scale service",
			trigger: "scaling",
			steps: [{ kind: "task", title: "Scale", body: "replicas: {{count}}" }],
			arguments: [{ name: "count", required: true, type: "number" }],
		})) as { id: string };
		const invocation = (await registry.get("playbooks.invoke")!.execute({ id: created.id, arguments: { count: 5 } })) as {
			entryTaskId: string;
			arguments: Record<string, unknown>;
		};
		expect(invocation.arguments.count).toBe(5);
		const entry = artifacts.get(invocation.entryTaskId)!;
		expect(entry.body).toBe("replicas: 5");
	});

	it("rejects an enum argument value outside its declared set", async () => {
		const { registry } = fixture();
		const created = (await registry.get("playbooks.create")!.execute({
			title: "Deploy service",
			trigger: "deploying",
			steps: ["Deploy to {{environment}}"],
			arguments: [{ name: "environment", required: true, enum: ["staging", "production"] }],
		})) as { id: string };
		expect(() => registry.get("playbooks.invoke")!.execute({ id: created.id, arguments: { environment: "prod-typo" } })).toThrow(
			/must be one of/,
		);
	});

	it("creates a Doc and a Rule alongside the container/step tasks when the playbook declares doc/rule steps", async () => {
		const { registry, artifacts } = fixture();
		const created = (await registry.get("playbooks.create")!.execute({
			title: "Ships a design",
			trigger: "designing",
			steps: [
				"Draft the approach",
				{ kind: "doc", title: "Design record", body: "the record" },
				{ kind: "rule", title: "Always review first", condition: "reviewing", action: "check the design record" },
			],
		})) as { id: string };
		const invocation = (await registry.get("playbooks.invoke")!.execute({ id: created.id })) as {
			created: { docs: string[]; rules: string[]; tasks: string[] };
		};
		expect(invocation.created.docs).toHaveLength(1);
		expect(invocation.created.rules).toHaveLength(1);
		expect(artifacts.get(invocation.created.docs[0]!)!).toMatchObject({ kind: "doc", title: "Design record", body: "the record" });
		expect(artifacts.get(invocation.created.rules[0]!)!).toMatchObject({ kind: "rule", title: "Always review first" });
	});

	it("a call step nests another Playbook's own run as a real pipeline step, gated the same way a task step would be", async () => {
		const { registry, artifacts } = fixture();
		const target = (await registry
			.get("playbooks.create")!
			.execute({ title: "Nested target", trigger: "called", steps: ["Target step one", "Target step two"] })) as { id: string };
		const caller = (await registry.get("playbooks.create")!.execute({
			title: "Caller",
			trigger: "calling",
			steps: ["Before", { kind: "call", title: "Run nested", playbookId: target.id }, "After"],
		})) as { id: string };

		const invocation = (await registry.get("playbooks.invoke")!.execute({ id: caller.id })) as {
			entryTaskId: string;
			created: { tasks: string[] };
		};
		// container + Before + After for the caller, plus container + two steps for the nested target run.
		expect(invocation.created.tasks).toHaveLength(6);
		const bodies = invocation.created.tasks.map((id) => artifacts.get(id)!.body);
		expect(bodies).toEqual(expect.arrayContaining(["After", "Before", "Target step one", "Target step two"]));

		const before = invocation.created.tasks.map((id) => artifacts.get(id)!).find((task) => task.body === "Before")!;
		const after = invocation.created.tasks.map((id) => artifacts.get(id)!).find((task) => task.body === "After")!;
		const targetStepOne = invocation.created.tasks.map((id) => artifacts.get(id)!).find((task) => task.body === "Target step one")!;

		// "After" depends (transitively, through the nested run) on the call having completed --
		// concretely, After depends_on the nested run's own root task(s), which contain the target's steps.
		const afterDeps = artifacts
			.relationships({ artifactIds: [after.id] })
			.filter((edge) => edge.from === after.id && edge.relation === "depends_on")
			.map((edge) => edge.to);
		expect(afterDeps.length).toBeGreaterThan(0);
		expect(before.id).not.toBe(after.id);
		expect(targetStepOne).toBeTruthy();
	});

	it("resolves entryTaskId through a nested call even when the call is the very first step", async () => {
		const { registry, artifacts } = fixture();
		const target = (await registry
			.get("playbooks.create")!
			.execute({ title: "Nested first", trigger: "called", steps: ["Only target step"] })) as { id: string };
		const caller = (await registry.get("playbooks.create")!.execute({
			title: "Calls first",
			trigger: "calling",
			steps: [{ kind: "call", title: "Run nested", playbookId: target.id }],
		})) as { id: string };
		const invocation = (await registry.get("playbooks.invoke")!.execute({ id: caller.id })) as { entryTaskId: string };
		const entry = artifacts.get(invocation.entryTaskId)!;
		// The resolved entry is a REAL task from the nested run, not a synthetic placeholder for the call step itself.
		expect(entry.kind).toBe("task");
		expect(entry.body).toBe("Only target step");
	});

	it("rejects malformed structured steps at create -- an unknown kind, a doc step with no title, a call step with no playbookId", async () => {
		const { registry } = fixture();
		expect(() => registry.get("playbooks.create")!.execute({ title: "Bad kind", steps: [{ kind: "nonsense", title: "x" }] })).toThrow(
			/unknown kind/,
		);
		expect(() => registry.get("playbooks.create")!.execute({ title: "Bad doc", steps: [{ kind: "doc" }] })).toThrow(/requires a title/);
		expect(() => registry.get("playbooks.create")!.execute({ title: "Bad call", steps: [{ kind: "call", title: "x" }] })).toThrow(
			/requires a playbookId/,
		);
	});

	it("rejects an argument with an unsupported type, and an enum default that isn't itself in the enum", async () => {
		const { registry } = fixture();
		expect(() => registry.get("playbooks.create")!.execute({ title: "Bad type", arguments: [{ name: "x", type: "array" }] })).toThrow(
			/unsupported type/,
		);
		expect(() =>
			registry.get("playbooks.create")!.execute({ title: "Bad default", arguments: [{ name: "x", enum: ["a", "b"], default: "c" }] }),
		).toThrow(/one of its enum values/);
	});

	it("previews structured steps as readable text, distinct per kind, and shows an argument's type/enum qualifier", async () => {
		const { registry } = fixture();
		const created = (await registry.get("playbooks.create")!.execute({
			title: "Rich preview",
			trigger: "manual",
			steps: [
				{ kind: "doc", title: "A doc" },
				{ kind: "rule", title: "A rule", condition: "always" },
				{ kind: "call", title: "A call", playbookId: "some-other-id" },
			],
			arguments: [{ name: "environment", required: true, type: "string", enum: ["staging", "production"] }],
		})) as { id: string };
		const preview = (await registry.get("playbooks.preview")!.execute({ id: created.id })) as string;
		expect(preview).toContain('[creates Doc] "A doc"');
		expect(preview).toContain('[creates Rule] "A rule" -- when: always');
		expect(preview).toContain('[calls playbook] "A call" -> some-other-id');
		expect(preview).toContain("one of: staging, production");
	});
});
