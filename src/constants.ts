export const VERSION = "0.1.0";

/** Compact task-context limits keep recurring prompt injection bounded. */
export const TASK_CONTEXT_ACTIVE_LIMIT = 3;
export const TASK_CONTEXT_FAILED_LIMIT = 3;

/** Reconciliation instruction appended whenever Papyrus has open work. */
export const TASK_RECONCILIATION_INSTRUCTION = [
	"Reconcile before concluding or moving on:",
	'• For each current task, ask: "Did we accomplish this task?"',
	"• If yes, run its gates before marking it done; a claim is not verification.",
	"• If no, continue with the next concrete action toward its desired state.",
	"• Address blocked work or explicitly leave it failed with the reason.",
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
 * skill = Procedural — "when using X,Y,Z do A,B,C" (richer SKILL.md metadata)
 */
export const SEED_KINDS = [
	{ name: "doc", description: "Knowledge — descriptive reference (specs, decisions, research, designs)" },
	{ name: "task", description: "Work — action items with gates, checklists, and dependencies" },
	{ name: "rule", description: "Governance — context injection (when doing X, follow Y). Maps to AGENTS.md" },
	{ name: "skill", description: "Procedural — when using X,Y,Z do A,B,C (SKILL.md metadata)" },
] as const;

export const SEED_STATUSES = [
	{ name: "draft", kind: "doc" },
	{ name: "active", kind: "doc" },
	{ name: "archived", kind: "doc" },
	{ name: "pending", kind: "task" },
	{ name: "active", kind: "task" },
	{ name: "done", kind: "task" },
	{ name: "failed", kind: "task" },
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
	"gates", "triggers",
] as const;
