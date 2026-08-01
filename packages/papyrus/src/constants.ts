/** Long-running daemon transport and state. */
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT_FILE = "port";
export const DAEMON_TOKEN_FILE = "token";
export const DAEMON_CLIENT_TIMEOUT_MS = 15_000;
export const DAEMON_PROBE_TIMEOUT_MS = 800;
export const DAEMON_UNIT_NAME = "papyrus.service";
export const DAEMON_DIR_ENV = "PAPYRUS_DAEMON_DIR";
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_SCHEMA_VERSION = 23;
export const SERVICE_MAX_BODY_BYTES = 1_048_576;

export const WAL_CHECKPOINT_INTERVAL_MS = 60_000;
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60_000;
export const GATE_COMMAND_TIMEOUT_MS = 30_000;
export const GATE_TEST_TIMEOUT_MS = 60_000;
export const GATE_OUTPUT_LIMIT = 200;
export const GATE_MAX_BUFFER_BYTES = 1_048_576;
export const GATE_FILE_MAX_BYTES = 1_048_576;

export const PAPYRUS_CONTEXT_INJECTION_CHANNEL = "papyrus.context-injection.v1";
export const PAPYRUS_CONTEXT_INJECTION_SCHEMA = "papyrus.context-injection/v1";
/** Broadcasts which task is focused, content-free (taskId/sessionId/status/timestamp only), so other extensions (e.g. a token-cost router) can correlate their own telemetry without Papyrus depending on them. */
export const PAPYRUS_TASK_FOCUS_CHANNEL = "papyrus.task-focus.v1";
export const PAPYRUS_TASK_FOCUS_SCHEMA = "papyrus.task-focus/v1";
export const CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN = 4;

/**
 * Bounds for walking Pi's real session tree (getTree()) and Papyrus's own Task containment
 * tree when estimating /context's message-history and task segments. Both are genuine trees
 * built from external, mutable state (a session file; the live Task graph) -- the node bound
 * is a defensive measure against a corrupted/adversarial parentId chain forming an accidental
 * cycle, matching the same cycle-safety discipline established by the (since-removed;
 * see Doc "ConversationJournal design record") ConversationJournal domain's own reply-chain
 * traversal and deliberately hardening past a real, confirmed gap in Pi's own getBranch() (no
 * cycle guard at all). Set generously: a real, ordinary (non-branching) long-running session
 * is one long linear chain, so a naively small bound truncates the walk after counting only a
 * small fraction of the real conversation -- a session observed in production with 6,924
 * entries on its own active branch confirmed an earlier, much smaller bound did exactly that,
 * making the derived "unaccounted" remainder balloon to absorb almost the entire real total.
 * The walk itself is iterative (an explicit stack), not recursive, specifically so a chain
 * this long cannot also risk a real JavaScript call-stack overflow independent of this bound.
 */
export const CONTEXT_TREE_MAX_NODES = 50_000;

/**
 * A Papyrus Rule's condition+action+body is injected into EVERY relevant turn's system
 * prompt for the lifetime of the rule -- the same permanent, always-on-context role as an
 * Agent Skill's name+description (per the Agent Skills spec's progressive-disclosure model:
 * metadata ~100 tokens, always loaded; full instructions <5000 tokens, loaded only on
 * activation). Anthropic's own context-engineering guidance is not a hard length rule but a
 * signal-density principle -- "the smallest possible set of high-signal tokens", explicitly
 * NOT "minimal means short" -- so RULE_TEXT_SOFT_TARGET_CHARACTERS is a target to aim for,
 * not a rejection threshold. RULE_TEXT_HARD_LIMIT_CHARACTERS is the actual enforced ceiling,
 * generous enough to allow a real rule to breathe, but catching genuinely runaway bloat that
 * would tax every single turn. Above the hard limit, split into a short Rule (condition +
 * the invariant) plus a linked Doc for full reasoning -- the pattern this codebase's own
 * active rules already use via "Source: Lexicon <path>" references.
 */
export const RULE_TEXT_SOFT_TARGET_CHARACTERS = 600;
export const RULE_TEXT_HARD_LIMIT_CHARACTERS = 4000;

/** Compact task-context limits keep recurring prompt injection bounded. */
export const TASK_CONTEXT_CURRENT_LIMIT = 3;
export const TASK_CONTEXT_REJECTED_LIMIT = 3;
export const TASK_WIDGET_OPEN_LIMIT = 3;
export const TASK_DETAIL_MIN_VISIBLE_LINES = 8;
/**
 * Event-triggered refresh (tool_execution_end, session_compact/tree) can't see a Task
 * mutation from outside this Pi session -- another concurrent session, or the CLI run
 * directly from a shell. This bounded poll is the fallback for exactly that gap.
 */
export const TASK_WIDGET_POLL_INTERVAL_MS = 20_000;
/** Same fallback purpose as TASK_WIDGET_POLL_INTERVAL_MS, for the Notes widget's own count. */
export const NOTE_WIDGET_POLL_INTERVAL_MS = 20_000;
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

/**
 * Invoking a Playbook queries Papyrus for whatever it's actually graph-linked to (existing
 * Tasks/Rules/Docs via ordinary edges, not just its own static body/extra fields), and a
 * Playbook can link to and invoke other Playbooks. Both traversals are bounded and
 * cycle-safe -- a playbook-calls-playbook edge cycle must not infinite-loop invocation,
 * matching the same cycle-safety discipline established by task dependency graphs and the
 * (since-removed; see Doc "ConversationJournal design record") ConversationJournal domain's
 * own reply chains.
 */
export const PLAYBOOK_INVOCATION_MAX_LINKED_ARTIFACTS = 20;
export const PLAYBOOK_INVOCATION_MAX_CALL_DEPTH = 4;
export const PLAYBOOK_ARGUMENT_MAX_COUNT = 20;
export const PLAYBOOK_ARGUMENT_NAME_MAX_LENGTH = 64;
export const PLAYBOOK_ARGUMENT_DESCRIPTION_MAX_LENGTH = 500;
/** A Playbook argument's enum/default validation reuses SKILL_MAX_ENUM_VALUES directly (same value shape, no reason for a second bound). */
/** One playbook's own steps array, before composition with any contained/depended-on playbook -- mirrors SKILL_MAX_BLUEPRINTS' role for a workflow Skill's flat blueprint list. */
export const PLAYBOOK_MAX_STEPS = 100;
/**
 * playbooks.invoke materializes a real Task per step (plus one container Task per playbook
 * node in the contains/depends_on composition tree) instead of rendering text -- this bounds
 * the total number of Tasks one invoke call can create, the same blast-radius concern
 * SKILL_MAX_BLUEPRINTS already covers for workflow Skills.
 */
export const PLAYBOOK_INVOCATION_MAX_CREATED_TASKS = 200;

/** Tasks.cancelSubtree walks `contains` edges transitively (a whole materialized playbook run can be torn down in one call instead of enumerating every task id by hand) -- bounded the same way PLAYBOOK_INVOCATION_MAX_CREATED_TASKS bounds the forward direction. */
export const TASK_CANCEL_SUBTREE_MAX_NODES = 500;
/** artifact.remove_subtree walks `contains` transitively across any artifact kind (a task tree, or a playbook's own nested-playbook children) -- same bound rationale as TASK_CANCEL_SUBTREE_MAX_NODES, kept separate since the two traversals serve different operations. */
export const ARTIFACT_REMOVE_SUBTREE_MAX_NODES = 500;

/**
 * At the core, a workflow Skill creates Tasks and begins a pipeline -- an Ansible playbook or
 * a Jenkins job, not just a text prompt. A pipeline step can itself trigger another workflow
 * Skill's run (a nested sub-pipeline, like a Jenkins job triggering a downstream job and
 * waiting for it), bounded and cycle-safe: a real skill-calls-skill cycle during EXECUTION
 * (not just invocation preview) must fail loudly and roll back the whole atomic run, not
 * silently truncate, since a silently-truncated pipeline would leave a confusing partial
 * Task graph behind.
 */
export const SKILL_WORKFLOW_MAX_NESTING_DEPTH = 4;
export const SKILL_RUN_ID_MAX_LENGTH = 64;
/** Bounded automatic Pi continuations while a focused Papyrus Task remains. */
export const TASK_DRIVER_MAX_TURNS = 20;
export const TASK_DRIVER_MAX_UNCHANGED_TURNS = 6;
/** Mutable Task content bounds. */
export const TASK_TITLE_MAX_LENGTH = 500;
export const TASK_BODY_MAX_LENGTH = 100_000;
export const TASK_LABEL_MAX_COUNT = 64;
export const TASK_LABEL_MAX_LENGTH = 128;
/** Mutable Doc/Rule/Skill content bounds -- same numbers as Task's, since these are the same kind of freeform content at the same scale. Rules also enforce their own stricter RULE_TEXT_HARD_LIMIT_CHARACTERS on top of this. */
export const ARTIFACT_TITLE_MAX_LENGTH = 500;
export const ARTIFACT_BODY_MAX_LENGTH = 100_000;
export const ARTIFACT_LABEL_MAX_COUNT = 64;
export const ARTIFACT_LABEL_MAX_LENGTH = 128;
/** Append-only Task chronology query and evidence bounds. */
export const TASK_HISTORY_DEFAULT_LIMIT = 25;
export const TASK_HISTORY_MAX_LIMIT = 100;
export const TASK_EVENT_MAX_EVIDENCE_BYTES = 65_536;
export const TASK_EVENT_ACTOR_MAX_LENGTH = 128;
export const TASK_EVENT_REASON_MAX_LENGTH = 2_000;
/** Task lease claims: bounded work reservation, orthogonal to Task lifecycle and Focus. */
export const TASK_LEASE_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const TASK_LEASE_MIN_TTL_MS = 1_000;
export const TASK_LEASE_MAX_TTL_MS = 4 * 60 * 60 * 1000;
export const TASK_LEASE_OWNER_MAX_LENGTH = 128;
export const TASK_LEASE_NOTE_MAX_LENGTH = 500;
/** Global, cross-task sequenced Task event feed (readiness/lifecycle subscriptions), distinct from tasks.history's per-task cursor. */
export const TASK_EVENT_FEED_DEFAULT_LIMIT = 50;
export const TASK_EVENT_FEED_MAX_LIMIT = 200;
/** Deferred human Note payload, inbox, and provenance bounds. */
export const NOTE_BODY_MAX_CHARACTERS = 10_000;
export const NOTE_TITLE_MAX_CHARACTERS = 80;
export const NOTE_LIST_DEFAULT_LIMIT = 50;
export const NOTE_LIST_MAX_LIMIT = 200;
export const NOTE_PROVENANCE_MAX_LENGTH = 128;
export const NOTE_REASON_MAX_CHARACTERS = 2_000;
export const NOTE_HISTORY_DEFAULT_LIMIT = 25;
export const NOTE_HISTORY_MAX_LIMIT = 100;
/** Generic, kind-agnostic mutation event log bounds (doc/task/rule/skill share one log). */
export const ARTIFACT_EVENT_ACTOR_MAX_LENGTH = 128;
export const ARTIFACT_EVENT_HISTORY_DEFAULT_LIMIT = 25;
export const ARTIFACT_EVENT_HISTORY_MAX_LIMIT = 200;
/**
 * Discuss: a native, blocking-capable deliberation, distinct from Discourse's forum (kept
 * fully standalone, no dependency here) and from the removed ConversationJournal (see Doc
 * 285681a7-bd44-4f33-93b1-1e10198d6d16 -- that domain never had a forcing real caller; a
 * Discussion's ability to block a Task's completion is exactly that forcing caller).
 * A Discussion is a `doc` with subtype "discussion"; its fine-grained lifecycle
 * (active/deferred/settled) lives in extra.discussion, not the shared doc status
 * vocabulary, since Papyrus enforces status per-kind, not per-subtype. Rounds are a
 * dedicated append-only child table, mirroring task_events' proven shape -- a round
 * carries substantive content, unlike the generic artifact_events log's transition markers.
 */
export const DISCUSSION_ROUND_CONTENT_MAX_CHARACTERS = 10_000;
export const DISCUSSION_ROUNDS_DEFAULT_LIMIT = 25;
export const DISCUSSION_ROUNDS_MAX_LIMIT = 200;
/** Hard ceiling on total rounds a single Discussion can ever accumulate -- forces settlement or deferral rather than an unbounded back-and-forth. */
export const DISCUSSION_MAX_ROUNDS = 200;
export const DISCUSSION_LIST_DEFAULT_LIMIT = 50;
export const DISCUSSION_LIST_MAX_LIMIT = 200;
export const DISCUSSION_SETTLEMENT_MAX_CHARACTERS = 4_000;
export const DISCUSSION_DEFER_REASON_MAX_CHARACTERS = 2_000;
export const DISCUSSION_ACTOR_MAX_LENGTH = 128;
/**
 * A posed choice (open/reply with options): "single" is mutually exclusive (exactly one pick),
 * "multi" allows several. Mirrors opencode's QuestionV2 labeled-multiple-choice model (the one
 * piece of prior art surveyed that already solves this), kept native and dependency-free here.
 */
export const DISCUSSION_OPTIONS_MIN_COUNT = 2;
export const DISCUSSION_OPTIONS_MAX_COUNT = 10;
export const DISCUSSION_OPTION_MAX_LENGTH = 200;
// Deliberately much shorter than DISCUSSION_ROUND_CONTENT_MAX_CHARACTERS -- a per-option
// description is meant to be a one-line tradeoff/consequence, not a restatement of the whole
// question. Long enough for a real pro/con, short enough to force conciseness.
export const DISCUSSION_OPTION_DESCRIPTION_MAX_LENGTH = 240;
// Below this, a binary yes/no choice is often self-evident and a description would just pad it.
export const DISCUSSION_OPTION_DESCRIPTION_REQUIRED_FROM_COUNT = 3;
/** Bounds for the generic graph projection protocol (external bounded contexts). */
export const GRAPH_PROJECTION_MAX_ARTIFACTS_PER_BATCH = 500;
export const GRAPH_PROJECTION_MAX_EDGES_PER_BATCH = 1_000;
export const GRAPH_PROJECTION_ID_MAX_LENGTH = 256;
/** Per-agent-session Task Focus scoping. "global" is the default scope for callers that don't supply a session id (CLI, legacy behavior). */
export const TASK_FOCUS_DEFAULT_SCOPE = "global";
export const TASK_FOCUS_SCOPE_MAX_LENGTH = 128;
/** Hard cap on distinct concurrent focus scopes (sessions); oldest-updated scope is evicted beyond this. */
export const TASK_FOCUS_MAX_SCOPES = 500;
/**
 * A Task Focus row not touched by any Focus-mutating operation (focus/pause/unpause) in this
 * long is eligible for time-based reaping (see Tasks.reapStaleFocus), independent of the
 * TASK_FOCUS_MAX_SCOPES hard cap above -- see clean-up-stale-per-session-task-focus-rows-
 * on-real-session-l-9i7s. Deliberately NOT driven by Pi's session_start/session_shutdown
 * hooks: a "resume" reuses the exact same session_id as a prior process incarnation, so
 * neither hook reliably signals "this session is gone forever" -- only real elapsed time
 * without any Focus activity does. 30 days is long enough that a genuine multi-week pause-
 * and-resume workflow survives; short enough to actually bound long-run accumulation.
 */
export const TASK_FOCUS_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on registered session_identities rows (see domain/session-identity.ts); oldest-seen identity is evicted beyond this, mirroring TASK_FOCUS_MAX_SCOPES. */
export const SESSION_IDENTITY_MAX_ROWS = 2_000;
/**
 * Grace period between artifact.remove (trash) and artifact purge eligibility -- see
 * domain/artifact-trash.ts. 30 days, matching TASK_FOCUS_STALE_AFTER_MS's convention: long
 * enough that a mistaken removal is still recoverable via artifact.restore, short enough to
 * actually bound trash accumulation. Enforced twice: the daemon's periodic sweep only
 * selects rows past this deadline, and the SQLite triggers that otherwise forbid deleting
 * artifact_events/task_events independently re-check the same deadline at delete time.
 */
export const ARTIFACT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Persisted project and focused-graph Task view bounds. */
export const TASK_SCOPE_MAX_TASKS = 1_000;
/** Docs/Rules/Skills project scope listing bound, mirroring TASK_SCOPE_MAX_TASKS. */
export const ARTIFACT_SCOPE_MAX_ARTIFACTS = 1_000;
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
/** Independent bounds for model-facing tool content and persisted renderer details. */
export const TOOL_MODEL_CONTENT_MAX_CHARACTERS = 12_000;
export const TOOL_DETAILS_BODY_MAX_CHARACTERS = 20_000;
export const TOOL_DETAILS_FIELD_MAX_CHARACTERS = 1_000;
export const TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS = 1_000;
export const TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS = 131_072;
export const TOOL_COLLAPSED_ROW_LIMIT = 5;
export const TOOL_DETAILS_MAX_ITEMS = 100;
export const TOOL_DETAILS_MAX_EDGES = 200;

/** Reconciliation instruction appended whenever Papyrus has open work. */
export const TASK_RECONCILIATION_INSTRUCTION = [
	"Reconcile before concluding or moving on:",
	'• For each current task, ask: "Did we accomplish this task?"',
	"• If yes, run its gates before marking it done; a claim is not verification. A written summary is not evidence -- identify what would actually prove each requirement in the task's desired state and checklist, and treat indirect or merely-plausible signals as not sufficient.",
	"• If no, continue with the next concrete action toward its desired state. Do not shrink the task's scope to whatever fits in this turn, and do not substitute a narrower, easier, or merely-passing-looking change for the actual desired outcome.",
	"• Address blocked work or explicitly move failed review to rejected with the reason. Do not reject or call something blocked on the first obstacle -- only after the same blocking condition genuinely recurs, and only when the task truly cannot proceed without external input or a change outside the agent's control.",
].join("\n");

/** $XDG_DATA_HOME/papyrus/papyrus.db */
export function dbPath(): string {
	const xdg = process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`;
	return `${xdg}/papyrus/papyrus.db`;
}

/**
 * The initial status a newly created artifact of a kind gets when no caller-supplied
 * status is given. This must be an explicit, named mapping — never derived from row order
 * in the `statuses` table (a migration's insertion order is not a semantic guarantee; a
 * migrated database can freely have a different physical row order for the same logical
 * status set). Deriving "the default" from "whichever row happens to be first by rowid"
 * was the root cause of a real production defect where migrated databases created new
 * Tasks as done instead of todo.
 */
export const DEFAULT_STATUS_BY_KIND: Readonly<Record<string, string>> = {
	doc: "draft",
	task: "todo",
	rule: "active",
	playbook: "active",
};

/**
 * Universal relation names — any kind can link to any kind.
 *
 * references:  source material (doc→doc, doc→task, doc→rule)
 * implements:  this work satisfies that (task→doc, task→rule)
 * follows:     this work obeys that (task→rule, task→playbook)
 * depends_on:  DAG ordering (task→task, playbook→playbook)
 * documents:   describes (doc→task, doc→rule, doc→playbook)
 * blocks:      blocking relationship (task→task)
 * supersedes:  replaces (doc→doc, rule→rule)
 * relates_to:  catch-all (any→any)
 * gates:       this rule gates that task (rule→task)
 * triggers:    this playbook run applies to that work (playbook→task)
 */
export const SEED_RELATIONS = [
	"references",
	"implements",
	"follows",
	"depends_on",
	"documents",
	"blocks",
	"supersedes",
	"relates_to",
	"gates",
	"triggers",
	"contains",
	"part_of",
	"reply_to",
	"discusses",
] as const;
