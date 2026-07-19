import { SERVICE_MAX_BODY_BYTES } from "./constants.ts";
import { VERSION } from "./version.ts";
import { openDb } from "./db.ts";
import { SQLiteArtifactStore } from "./adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "./adapters/sqlite-gate-runner.ts";
import type { CreateArtifactInput } from "./domain/artifact.ts";
import type { Checklist } from "./domain/checklist.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { GateRunner } from "./ports/gate-runner.ts";
import { projectTaskExecution } from "./task-execution.ts";
import { Tasks } from "./task-service.ts";
import {
	createArtifactTemplate,
	createDocument,
	createRule,
	createSkill,
	linkDocument,
	gateTaskWithRule,
	instantiateTemplate,
	listDocuments,
	listRules,
	listSkills,
	previewRule,
	showDocument,
	showRule,
	showSkill,
	skillInvocation,
	transitionDocument,
	transitionRule,
	transitionSkill,
	type DocumentRelation,
} from "./domain-services.ts";
import { taskContext } from "./task-context.ts";

export const EXPECTED_OPERATION_NAMES = [
	"artifact.create",
	"artifact.query",
	"artifact.show",
	"graph.link",
	"graph.tree",
	"graph.status",
	"gates.run",
	"rules.injectable",
	"tasks.create",
	"tasks.list",
	"tasks.graph",
	"tasks.plan",
	"tasks.show",
	"tasks.start",
	"tasks.complete",
	"tasks.run_gates",
	"tasks.set_checklist",
	"tasks.context",
	"tasks.fail",
	"tasks.retry",
	"tasks.depend",
	"tasks.contain",
	"docs.create",
	"docs.list",
	"docs.show",
	"docs.activate",
	"docs.archive",
	"docs.reopen",
	"docs.link",
	"rules.create",
	"rules.list",
	"rules.show",
	"rules.preview",
	"rules.enable",
	"rules.disable",
	"rules.gate",
	"skills.create",
	"skills.create_template",
	"skills.list",
	"skills.show",
	"skills.invoke",
	"skills.enable",
	"skills.disable",
	"skills.instantiate",
] as const;

export type OperationName = typeof EXPECTED_OPERATION_NAMES[number];
type OperationInput = Record<string, unknown>;
type OperationHandler = (input: OperationInput) => unknown;

export class UnknownOperationError extends Error {}
export class PayloadTooLargeError extends Error {}

function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

function normalizeCreateInput(input: OperationInput): CreateArtifactInput {
	const { template_id, ...rest } = input;
	return { ...rest, templateId: typeof template_id === "string" ? template_id : undefined } as CreateArtifactInput;
}

export interface PapyrusService {
	operationNames(): OperationName[];
	execute(operation: string, input?: OperationInput): Promise<unknown>;
	checkpoint(): void;
	optimize(): void;
	close(): void;
}

function handlers(artifacts: ArtifactStore, gates: GateRunner, tasks: Tasks): Record<OperationName, OperationHandler> {
	const taskFilter = (input: OperationInput) => ({
		status: optionalString(input, "status"),
		text: optionalString(input, "text"),
		limit: optionalNumber(input, "limit"),
	});
	return {
		"artifact.create": (input) => artifacts.create(normalizeCreateInput(input)),
		"artifact.query": (input) => artifacts.query(input),
		"artifact.show": (input) => artifacts.get(string(input, "id"), {
			tree: input["tree"] === true,
			depth: optionalNumber(input, "depth"),
			maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
		}),
		"graph.link": (input) => {
			const from = string(input, "from");
			const relation = string(input, "relation");
			const to = string(input, "to");
			if (relation === "depends_on" && artifacts.get(from)?.kind === "task" && artifacts.get(to)?.kind === "task") {
				tasks.depend(from, to);
			} else {
				artifacts.link({ from, relation, to });
			}
			return { ok: true };
		},
		"graph.tree": (input) => artifacts.get(string(input, "id"), {
			tree: true,
			depth: optionalNumber(input, "depth"),
			maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
		}),
		"graph.status": (input) => artifacts.setStatus(string(input, "id"), string(input, "status")),
		"gates.run": (input) => gates.runAsync(string(input, "id")),
		"rules.injectable": () => artifacts.query({ kind: "rule", status: "active" })
			.map(({ id, title, body, extra }) => ({ id, title, body, extra })),
		"tasks.create": (input) => tasks.create({
			title: string(input, "title"),
			body: optionalString(input, "body"),
			status: optionalString(input, "status") as "pending" | "active" | "done" | "failed" | undefined,
			labels: input["labels"] as string[] | undefined,
			extra: input["extra"] as Record<string, unknown> | undefined,
			gates: input["gates"] as Parameters<Tasks["create"]>[0]["gates"],
			checklist: input["checklist"] as Checklist | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
			parentId: optionalString(input, "parent_id") ?? optionalString(input, "parentId"),
			dependsOn: (input["depends_on"] ?? input["dependsOn"]) as string[] | undefined,
		}),
		"tasks.list": (input) => tasks.list(taskFilter(input)),
		"tasks.graph": (input) => tasks.graph(taskFilter(input)),
		"tasks.plan": (input) => projectTaskExecution(tasks.graph(taskFilter(input))),
		"tasks.show": (input) => tasks.show(string(input, "id")),
		"tasks.start": (input) => tasks.transition(string(input, "id"), "start"),
		"tasks.complete": (input) => tasks.completeAsync(string(input, "id")),
		"tasks.run_gates": (input) => tasks.runGates(string(input, "id")),
		"tasks.set_checklist": (input) => tasks.setChecklist(string(input, "id"), input["checklist"] as Checklist),
		"tasks.context": () => taskContext(artifacts),
		"tasks.fail": (input) => tasks.transition(string(input, "id"), "fail"),
		"tasks.retry": (input) => tasks.transition(string(input, "id"), "retry"),
		"tasks.depend": (input) => tasks.depend(string(input, "id"), string(input, "dependency_id")),
		"tasks.contain": (input) => tasks.contain(string(input, "parent_id"), string(input, "child_id")),
		"docs.create": (input) => createDocument(artifacts, {
			title: string(input, "title"), body: optionalString(input, "body"), subtype: optionalString(input, "subtype"),
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
		}),
		"docs.list": (input) => listDocuments(artifacts, taskFilter(input)),
		"docs.show": (input) => showDocument(artifacts, string(input, "id")),
		"docs.activate": (input) => transitionDocument(artifacts, string(input, "id"), "activate"),
		"docs.archive": (input) => transitionDocument(artifacts, string(input, "id"), "archive"),
		"docs.reopen": (input) => transitionDocument(artifacts, string(input, "id"), "reopen"),
		"docs.link": (input) => linkDocument(artifacts, string(input, "id"), string(input, "relation") as DocumentRelation, string(input, "target_id")),
		"rules.create": (input) => createRule(artifacts, {
			title: string(input, "title"), body: optionalString(input, "body"), condition: optionalString(input, "condition"),
			action: optionalString(input, "rule_action") ?? optionalString(input, "governance_action"),
			severity: optionalString(input, "severity") as "block" | "warn" | "info" | undefined,
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
		}),
		"rules.list": (input) => listRules(artifacts, taskFilter(input)),
		"rules.show": (input) => showRule(artifacts, string(input, "id")),
		"rules.preview": (input) => previewRule(artifacts, string(input, "id")),
		"rules.enable": (input) => transitionRule(artifacts, string(input, "id"), "enable"),
		"rules.disable": (input) => transitionRule(artifacts, string(input, "id"), "disable"),
		"rules.gate": (input) => gateTaskWithRule(artifacts, string(input, "id"), string(input, "task_id")),
		"skills.create": (input) => createSkill(artifacts, {
			title: string(input, "title"), body: optionalString(input, "body"), trigger: optionalString(input, "trigger"),
			steps: input["steps"] as string[] | undefined, tools: input["tools"] as string[] | undefined,
			labels: input["labels"] as string[] | undefined, extra: input["extra"] as Record<string, unknown> | undefined,
		}),
		"skills.create_template": (input) => createArtifactTemplate(artifacts, {
			title: string(input, "title"), targetKind: string(input, "target_kind"), defaults: input["defaults"] as Record<string, unknown> | undefined,
			required: input["required"] as string[] | undefined, body: optionalString(input, "body"), labels: input["labels"] as string[] | undefined,
		}),
		"skills.list": (input) => listSkills(artifacts, taskFilter(input)),
		"skills.show": (input) => showSkill(artifacts, string(input, "id")),
		"skills.invoke": (input) => skillInvocation(artifacts, string(input, "id")),
		"skills.enable": (input) => transitionSkill(artifacts, string(input, "id"), "enable"),
		"skills.disable": (input) => transitionSkill(artifacts, string(input, "id"), "disable"),
		"skills.instantiate": (input) => instantiateTemplate(artifacts, string(input, "template_id"), normalizeCreateInput(input)),
	};
}

export function createPapyrusService(path: string): PapyrusService {
	const db = openDb(path);
	const artifacts = new SQLiteArtifactStore(db);
	const gates = new SQLiteGateRunner(db);
	const tasks = new Tasks(artifacts, gates);
	const registry = handlers(artifacts, gates, tasks);
	return {
		operationNames: () => [...EXPECTED_OPERATION_NAMES],
		async execute(operation, input = {}) {
			const handler = registry[operation as OperationName];
			if (!handler) throw new UnknownOperationError(`unknown operation "${operation}"`);
			return handler(input);
		},
		checkpoint: () => { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); },
		optimize: () => { db.exec("PRAGMA optimize"); },
		close: () => {
			db.exec("PRAGMA optimize");
			db.close();
		},
	};
}

function json(value: unknown, init?: ResponseInit): Response {
	return Response.json(value, init);
}

async function readOperationBody(request: Request): Promise<{ op?: unknown; input?: unknown }> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > SERVICE_MAX_BODY_BYTES) {
		throw new PayloadTooLargeError(`request exceeds ${SERVICE_MAX_BODY_BYTES} bytes`);
	}
	if (!request.body) return {};
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > SERVICE_MAX_BODY_BYTES) {
			await reader.cancel();
			throw new PayloadTooLargeError(`request exceeds ${SERVICE_MAX_BODY_BYTES} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return JSON.parse(new TextDecoder().decode(bytes)) as { op?: unknown; input?: unknown };
}

export function createApp(deps: { service: PapyrusService; token: string }): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (request.headers.get("authorization") !== `Bearer ${deps.token}`) {
				return json({ error: "missing or invalid bearer token" }, { status: 401 });
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return json({ ok: true, version: VERSION });
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return json({ operations: deps.service.operationNames() });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				try {
					const body = await readOperationBody(request);
					if (typeof body.op !== "string") return json({ error: "op is required" }, { status: 400 });
					const input = body.input === undefined ? {} : body.input;
					if (typeof input !== "object" || input === null || Array.isArray(input)) {
						return json({ error: "input must be an object" }, { status: 400 });
					}
					return json({ result: await deps.service.execute(body.op, input as OperationInput) });
				} catch (error) {
					const status = error instanceof PayloadTooLargeError ? 413 : error instanceof UnknownOperationError ? 404 : 400;
					return json({ error: error instanceof Error ? error.message : String(error) }, { status });
				}
			}
			return json({ error: "not found" }, { status: 404 });
		},
	};
}
