import { SERVICE_MAX_BODY_BYTES, VERSION } from "./constants.ts";
import { openDb, type Db } from "./db.ts";
import {
	completeTaskAsync,
	containTask,
	createArtifactTemplate,
	createDocument,
	createRule,
	createSkill,
	createTask,
	linkDocument,
	gateTaskWithRule,
	instantiateTemplate,
	linkTaskDependency,
	listDocuments,
	listRules,
	listSkills,
	listTasks,
	previewRule,
	showDocument,
	showRule,
	showSkill,
	showTask,
	skillInvocation,
	transitionDocument,
	transitionRule,
	transitionSkill,
	transitionTask,
	type DocumentRelation,
	type DocumentTransition,
	type TaskTransition,
} from "./facades.ts";
import { taskContextFromDb } from "./task-context.ts";
import {
	createArtifact,
	getArtifact,
	injectableRules,
	linkArtifacts,
	queryArtifacts,
	runGatesAsync,
	updateStatus,
	type CreateInput,
} from "./ops.ts";

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
	"tasks.show",
	"tasks.start",
	"tasks.complete",
	"tasks.run_gates",
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

function normalizeCreateInput(input: OperationInput): CreateInput {
	const { template_id, ...rest } = input;
	return { ...rest, templateId: typeof template_id === "string" ? template_id : undefined } as CreateInput;
}

export interface PapyrusService {
	operationNames(): OperationName[];
	execute(operation: string, input?: OperationInput): Promise<unknown>;
	checkpoint(): void;
	optimize(): void;
	close(): void;
}

function handlers(db: Db): Record<OperationName, OperationHandler> {
	return {
		"artifact.create": (input) => createArtifact(db, normalizeCreateInput(input)),
		"artifact.query": (input) => queryArtifacts(db, input),
		"artifact.show": (input) => getArtifact(db, string(input, "id"), {
			tree: input["tree"] === true,
			depth: optionalNumber(input, "depth"),
			maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
		}),
		"graph.link": (input) => {
			linkArtifacts(db, string(input, "from"), string(input, "relation"), string(input, "to"));
			return { ok: true };
		},
		"graph.tree": (input) => getArtifact(db, string(input, "id"), {
			tree: true,
			depth: optionalNumber(input, "depth"),
			maxNodes: optionalNumber(input, "max_nodes") ?? optionalNumber(input, "maxNodes"),
		}),
		"graph.status": (input) => updateStatus(db, string(input, "id"), string(input, "status")),
		"gates.run": (input) => runGatesAsync(db, string(input, "id")),
		"rules.injectable": () => injectableRules(db),
		"tasks.create": (input) => createTask(db, {
			title: string(input, "title"),
			body: optionalString(input, "body"),
			status: optionalString(input, "status") as "pending" | "active" | "done" | "failed" | undefined,
			labels: input["labels"] as string[] | undefined,
			extra: input["extra"] as Record<string, unknown> | undefined,
			gates: input["gates"] as Parameters<typeof createTask>[1]["gates"],
			checklist: input["checklist"] as unknown[] | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
			parentId: optionalString(input, "parent_id") ?? optionalString(input, "parentId"),
			dependsOn: (input["depends_on"] ?? input["dependsOn"]) as string[] | undefined,
		}),
		"tasks.list": (input) => listTasks(db, {
			status: optionalString(input, "status"),
			text: optionalString(input, "text"),
			limit: optionalNumber(input, "limit"),
		}),
		"tasks.show": (input) => showTask(db, string(input, "id")),
		"tasks.start": (input) => transitionTask(db, string(input, "id"), "start"),
		"tasks.complete": (input) => completeTaskAsync(db, string(input, "id")),
		"tasks.run_gates": (input) => runGatesAsync(db, string(input, "id")),
		"tasks.context": () => taskContextFromDb(db),
		"tasks.fail": (input) => transitionTask(db, string(input, "id"), "fail"),
		"tasks.retry": (input) => transitionTask(db, string(input, "id"), "retry"),
		"tasks.depend": (input) => linkTaskDependency(db, string(input, "id"), string(input, "dependency_id")),
		"tasks.contain": (input) => containTask(db, string(input, "parent_id"), string(input, "child_id")),
		"docs.create": (input) => createDocument(db, {
			title: string(input, "title"),
			body: optionalString(input, "body"),
			subtype: optionalString(input, "subtype"),
			labels: input["labels"] as string[] | undefined,
			extra: input["extra"] as Record<string, unknown> | undefined,
			templateId: optionalString(input, "template_id") ?? optionalString(input, "templateId"),
		}),
		"docs.list": (input) => listDocuments(db, {
			status: optionalString(input, "status"),
			text: optionalString(input, "text"),
			limit: optionalNumber(input, "limit"),
		}),
		"docs.show": (input) => showDocument(db, string(input, "id")),
		"docs.activate": (input) => transitionDocument(db, string(input, "id"), "activate"),
		"docs.archive": (input) => transitionDocument(db, string(input, "id"), "archive"),
		"docs.reopen": (input) => transitionDocument(db, string(input, "id"), "reopen"),
		"docs.link": (input) => linkDocument(
			db,
			string(input, "id"),
			string(input, "relation") as DocumentRelation,
			string(input, "target_id"),
		),
		"rules.create": (input) => createRule(db, {
			title: string(input, "title"),
			body: optionalString(input, "body"),
			condition: optionalString(input, "condition"),
			action: optionalString(input, "rule_action") ?? optionalString(input, "governance_action"),
			severity: optionalString(input, "severity") as "block" | "warn" | "info" | undefined,
			labels: input["labels"] as string[] | undefined,
			extra: input["extra"] as Record<string, unknown> | undefined,
		}),
		"rules.list": (input) => listRules(db, {
			status: optionalString(input, "status"), text: optionalString(input, "text"), limit: optionalNumber(input, "limit"),
		}),
		"rules.show": (input) => showRule(db, string(input, "id")),
		"rules.preview": (input) => previewRule(db, string(input, "id")),
		"rules.enable": (input) => transitionRule(db, string(input, "id"), "enable"),
		"rules.disable": (input) => transitionRule(db, string(input, "id"), "disable"),
		"rules.gate": (input) => gateTaskWithRule(db, string(input, "id"), string(input, "task_id")),
		"skills.create": (input) => createSkill(db, {
			title: string(input, "title"),
			body: optionalString(input, "body"),
			trigger: optionalString(input, "trigger"),
			steps: input["steps"] as string[] | undefined,
			tools: input["tools"] as string[] | undefined,
			labels: input["labels"] as string[] | undefined,
			extra: input["extra"] as Record<string, unknown> | undefined,
		}),
		"skills.create_template": (input) => createArtifactTemplate(db, {
			title: string(input, "title"),
			targetKind: string(input, "target_kind"),
			defaults: input["defaults"] as Record<string, unknown> | undefined,
			required: input["required"] as string[] | undefined,
			body: optionalString(input, "body"),
			labels: input["labels"] as string[] | undefined,
		}),
		"skills.list": (input) => listSkills(db, {
			status: optionalString(input, "status"), text: optionalString(input, "text"), limit: optionalNumber(input, "limit"),
		}),
		"skills.show": (input) => showSkill(db, string(input, "id")),
		"skills.invoke": (input) => skillInvocation(db, string(input, "id")),
		"skills.enable": (input) => transitionSkill(db, string(input, "id"), "enable"),
		"skills.disable": (input) => transitionSkill(db, string(input, "id"), "disable"),
		"skills.instantiate": (input) => instantiateTemplate(db, string(input, "template_id"), normalizeCreateInput(input)),
	};
}

export function createPapyrusService(path: string): PapyrusService {
	const db = openDb(path);
	const registry = handlers(db);
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
