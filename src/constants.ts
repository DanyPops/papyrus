/** Long-running daemon transport and state. */
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT_FILE = "port";
export const DAEMON_TOKEN_FILE = "token";
export const DAEMON_CLIENT_TIMEOUT_MS = 15_000;
export const DAEMON_PROBE_TIMEOUT_MS = 800;
export const DAEMON_UNIT_NAME = "papyrus.service";
export const DAEMON_DIR_ENV = "PAPYRUS_DAEMON_DIR";
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_SCHEMA_VERSION = 6;
export const SERVICE_MAX_BODY_BYTES = 1_048_576;
/** Bounded forum persistence behind the Discourse mutation authority. */
export const DISCOURSE_QUERY_MAX_LIMIT = 100;
export const DISCOURSE_CONTENT_MAX_BYTES = 65_536;
export const DISCOURSE_EVENT_RETENTION_DEFAULT = 1_000;
export const DISCOURSE_EVENT_RETENTION_MAX = 10_000;
export const DISCOURSE_PARTICIPANT_MAX_COUNT = 100;
export const WAL_CHECKPOINT_INTERVAL_MS = 60_000;
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60_000;
export const GATE_COMMAND_TIMEOUT_MS = 30_000;
export const GATE_TEST_TIMEOUT_MS = 60_000;
export const GATE_OUTPUT_LIMIT = 200;
export const GATE_MAX_BUFFER_BYTES = 1_048_576;
export const GATE_FILE_MAX_BYTES = 1_048_576;

export const PAPYRUS_CONTEXT_INJECTION_CHANNEL = "papyrus.context-injection.v1";
export const PAPYRUS_CONTEXT_INJECTION_SCHEMA = "papyrus.context-injection/v1";
export const CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN = 4;

/** Compact task-context limits keep recurring prompt injection bounded. */
export const TASK_CONTEXT_CURRENT_LIMIT = 3;
export const TASK_CONTEXT_REJECTED_LIMIT = 3;
export const TASK_WIDGET_OPEN_LIMIT = 3;
export const TASK_DETAIL_MIN_VISIBLE_LINES = 8;
export const TASK_DETAIL_MAX_VISIBLE_LINES = 24;
export const TASK_DETAIL_RESERVED_ROWS = 8;
export const TASK_DETAIL_HORIZONTAL_PAN_COLUMNS = 4;
/** Bounded navigable detail views for non-Task artifacts. */
export const ARTIFACT_DETAIL_MIN_VISIBLE_LINES = 8;
export const ARTIFACT_DETAIL_MAX_VISIBLE_LINES = 24;
export const ARTIFACT_DETAIL_RESERVED_ROWS = 8;
export const ARTIFACT_DETAIL_HORIZONTAL_PAN_COLUMNS = 4;
export const TASK_GRAPH_MIN_VISIBLE_LINES = 8;
export const TASK_GRAPH_MAX_VISIBLE_LINES = 30;
export const TASK_GRAPH_RESERVED_ROWS = 8;
export const TASK_GRAPH_HORIZONTAL_PAN_COLUMNS = 4;
/** Hard bounds for executable dependency DAG projection and cycle checks. */
export const TASK_EXECUTION_MAX_NODES = 1_000;
export const TASK_EXECUTION_MAX_EDGES = 10_000;
export const TASK_EXECUTION_MAX_DEGREE = 100;
/** Bounded parameterized Skill definitions and rendered workflow runs. */
export const SKILL_MAX_INPUTS = 32;
export const SKILL_MAX_ENUM_VALUES = 32;
export const SKILL_MAX_BLUEPRINTS = 100;
export const SKILL_MAX_LINKS = 500;
export const SKILL_MAX_RENDERED_BYTES = 1_048_576;
export const SKILL_RUN_ID_MAX_LENGTH = 64;
/** Bounded automatic Pi continuations while a focused Papyrus Task remains. */
export const TASK_DRIVER_MAX_TURNS = 20;
export const TASK_DRIVER_MAX_UNCHANGED_TURNS = 6;
/** Mutable Task content bounds. */
export const TASK_TITLE_MAX_LENGTH = 500;
export const TASK_BODY_MAX_LENGTH = 100_000;
export const TASK_LABEL_MAX_COUNT = 64;
export const TASK_LABEL_MAX_LENGTH = 128;
/** Append-only Task chronology query and evidence bounds. */
export const TASK_HISTORY_DEFAULT_LIMIT = 25;
export const TASK_HISTORY_MAX_LIMIT = 100;
export const TASK_EVENT_MAX_EVIDENCE_BYTES = 65_536;
export const TASK_EVENT_ACTOR_MAX_LENGTH = 128;
export const TASK_EVENT_REASON_MAX_LENGTH = 2_000;
/** Deferred human Note payload, inbox, and provenance bounds. */
export const NOTE_BODY_MAX_CHARACTERS = 10_000;
export const NOTE_TITLE_MAX_CHARACTERS = 80;
export const NOTE_LIST_DEFAULT_LIMIT = 50;
export const NOTE_LIST_MAX_LIMIT = 200;
export const NOTE_HISTORY_MAX_EVENTS = 20;
export const NOTE_PROVENANCE_MAX_LENGTH = 128;
export const NOTE_REASON_MAX_CHARACTERS = 2_000;
/** Persisted project and focused-graph Task view bounds. */
export const TASK_SCOPE_MAX_TASKS = 1_000;
export const TASK_PROJECT_ROOT_MAX_LENGTH = 4_096;
export const GRAPH_RENDER_PADDING_X = 2;
export const GRAPH_RENDER_PADDING_Y = 1;
export const GRAPH_RENDER_BOX_PADDING = 0;
/** beautiful-mermaid routed layouts become unsafe on larger task graphs; use bounded line fallback. */
export const GRAPH_RENDER_MAX_ROUTED_NODES = 48;
export const GRAPH_RENDER_MAX_ROUTED_EDGES = 96;
export const GRAPH_RENDER_MAX_FALLBACK_LINES = 200;

/** Safe defaults and hard ceilings for graph expansion. */
export const DEFAULT_GRAPH_DEPTH = 4;
export const DEFAULT_GRAPH_MAX_NODES = 100;
export const MAX_GRAPH_DEPTH = 20;
export const MAX_GRAPH_NODES = 1_000;

/** Bounds for recursively rendered artifact metadata. */
export const DEFAULT_METADATA_DEPTH = 6;
export const DEFAULT_METADATA_ITEMS = 100;
export const MAX_METADATA_DEPTH = 12;
export const MAX_METADATA_ITEMS = 500;

/** Reconciliation instruction appended whenever Papyrus has open work. */
export const TASK_RECONCILIATION_INSTRUCTION = [
	"Reconcile before concluding or moving on:",
	'• For each current task, ask: "Did we accomplish this task?"',
	"• If yes, run its gates before marking it done; a claim is not verification.",
	"• If no, continue with the next concrete action toward its desired state.",
	"• Address blocked work or explicitly move failed review to rejected with the reason.",
].join("\n");

/** $XDG_DATA_HOME/papyrus/papyrus.db */
export function dbPath(): string {
	const xdg = process.env["XDG_DATA_HOME"] || `${process.env["HOME"]}/.local/share`;
	return `${xdg}/papyrus/papyrus.db`;
}

/**
 * Four purpose-built kinds — the enforced vocabulary.
 *
 * doc   = Knowledge — descriptive ("here is what the architecture looks like")
 * task  = Work — prescriptive action items with gates and checklists
 * rule  = Governance — context injection ("when doing X, follow Y").
 *         Maps to AGENTS.md semantics: active rules with inject:true are
 *         appended to the system prompt on before_agent_start.
 * skill = Parameterized workflow bundle — validated inputs render connected Task, Rule, and Doc collections.
 */
export const SEED_KINDS = [
	{ name: "doc", description: "Knowledge — descriptive reference (specs, decisions, research, designs)" },
	{ name: "task", description: "Work — action items with gates, checklists, and dependencies" },
	{ name: "rule", description: "Governance — context injection (when doing X, follow Y). Maps to AGENTS.md" },
	{ name: "skill", description: "Parameterized workflow bundle — inputs and templates load deterministic tasks plus contextual rules and docs" },
] as const;

export const SEED_STATUSES = [
	{ name: "draft", kind: "doc" },
	{ name: "active", kind: "doc" },
	{ name: "archived", kind: "doc" },
	{ name: "todo", kind: "task" },
	{ name: "in-progress", kind: "task" },
	{ name: "review", kind: "task" },
	{ name: "rejected", kind: "task" },
	{ name: "done", kind: "task" },
	{ name: "canceled", kind: "task" },
	{ name: "active", kind: "rule" },
	{ name: "deprecated", kind: "rule" },
	{ name: "active", kind: "skill" },
	{ name: "deprecated", kind: "skill" },
] as const;

/**
 * Universal relation names — any kind can link to any kind.
 *
 * references:  source material (doc→doc, doc→task, doc→rule)
 * implements:  this work satisfies that (task→doc, task→rule)
 * follows:     this work obeys that (task→rule, task→skill)
 * depends_on:  DAG ordering (task→task)
 * documents:   describes (doc→task, doc→rule, doc→skill)
 * blocks:      blocking relationship (task→task)
 * supersedes:  replaces (doc→doc, rule→rule)
 * relates_to:  catch-all (any→any)
 * gates:       this rule gates that task (rule→task)
 * triggers:    this skill applies to that work (skill→task)
 */
export const SEED_RELATIONS = [
	"references", "implements", "follows", "depends_on",
	"documents", "blocks", "supersedes", "relates_to",
	"gates", "triggers", "contains", "part_of", "reply_to", "discusses",
] as const;
