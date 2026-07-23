# Papyrus

Graph artifact service for Pi — enforced SQLite schema, domain tools and services, and native interactive frontends.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced**—the schema is the protocol. A supervised Bun daemon is the sole database owner; Pi extensions and other clients use its authenticated loopback service API.

## Architecture

```text
Pi tools + TUI
      ↓
tasks / notes / docs / rules / skills domain tools
      ↓
Papyrus client → authenticated loopback daemon
      ↓
operation registry + lifecycle services
      ↓
graph-store operations → SQLite (WAL)
```

The `papyrus_*` tools remain low-level administration escape hatches. Normal agent work should use the domain tools.

## Storage and service

```text
$XDG_DATA_HOME/papyrus/papyrus.db       # durable graph
$XDG_RUNTIME_DIR/papyrus/{port,token}   # private daemon discovery
```

```bash
bun src/cli.ts service install   # install, enable, and start user service
bun src/cli.ts service status
bun src/cli.ts service restart

# Authenticated daemon-backed Task operations (add --json for machine output)
papyrus tasks plan
papyrus tasks depend <task-id> <prerequisite-id>
papyrus tasks update <task-id> --title "Revised task"
papyrus tasks focus <task-id>
papyrus tasks pause
papyrus tasks unpause
papyrus tasks complete <task-id>

# Deferred human-intent inbox
papyrus notes capture "Review release provenance later"
papyrus notes list --json
```

For repository work, install the versioned ownership guard once:

```bash
bun run guard:install
```

It blocks every Papyrus push whose destination is not `DanyPops/papyrus`, including explicit fallback URLs that bypass `origin`.

The daemon uses WAL, foreign keys, a bounded busy timeout, versioned migrations, periodic passive checkpoints, and periodic `PRAGMA optimize`. Keep the database on a local filesystem; SQLite WAL does not support network filesystems.

### Context Mesh persistence model

`artifacts` is the shared graph-identity supertype, not a second copy of every application's database. `edges` references that single identity table at both endpoints, preserving foreign-key integrity for cross-domain links. Domain extension tables exist only where application invariants require indexed relational state: Task chronology/focus/scope and Discourse posts/events/session cursors/projection checkpoints. This is a class-table/table-per-type variant with explicit child-to-parent foreign keys; Papyrus does not use SQLite table inheritance or orphan-prone `(target_type, target_id)` links.

The owning application remains the mutation authority. Discourse commits its extension rows and `context-thread`/`context-message` Doc projections atomically through `discourse.store`; generic artifact, document, Skill-template, lifecycle, and graph-link operations reject those owned subtypes and the `reply_to`/`discusses` relations. SQLite triggers additionally verify that each extension row references the expected Doc subtype. Domain tables are canonical for domain invariants; graph bodies and metadata are read-oriented projections committed in the same transaction.

The authenticated CLI exposes the same operation for diagnostics and adapter parity:

```bash
papyrus discourse store read_thread --store-id team-forum \
  --input-json '{"forumId":"engineering","topicId":"reviews","threadId":"mesh","limit":25}' \
  --json
```

## Schema protocol (enforceable)

Papyrus enforces four artifact kinds:

- `doc` — knowledge: specifications, decisions, and research
- `task` — work: desired outcomes, gates, checklists, and dependencies
- `rule` — governance injected into the Pi system prompt
- `skill` — a parameterized workflow bundle whose validated arguments render a connected collection of deterministic Tasks plus contextual Rules and Docs

Each kind has an enforced status vocabulary. Every edge endpoint must exist, and every edge relation must be registered in `relation_names`. Relations are universal: any artifact kind can link to any other kind.

### Hierarchy and traversal

Use `contains` and `part_of` for explicit parent/child structure; use `depends_on` for execution ordering. Dependency edges form an executable DAG: self-dependencies and cycles are rejected, fan-in waits for every prerequisite, and fan-out can expose several ready successors while active focus remains singular. Graph reads are cycle-safe and bounded by `depth` and `max_nodes` (defaults: depth 4, 100 nodes; hard ceilings: depth 20, 1,000 nodes). Executable task plans are additionally bounded to 1,000 tasks and 10,000 relationships.

### Skills and compatibility templates

A Papyrus Skill is distinct from a conventional prompt-only skill: its input API and blueprints define a connected Task/Rule/Doc workflow. `skills.run` validates and normalizes all arguments, safely renders placeholders in memory, validates the complete graph, then persists artifacts and edges in one transaction. Task dependencies, containment, gates, checklists, and context survive rendering. Run Rules are injected only while active focus belongs to that run. Docs retain invocation context and provenance; missing evidence references remain unknown and no gate runs during instantiation.

A run result has a stable schema: Skill ID, run ID, normalized arguments, created IDs grouped by kind, ready root task IDs, and the bounded execution plan. Explicit run IDs produce deterministic artifact IDs (`<run-id>-<blueprint-ref>`); collisions roll back the entire run.

```bash
papyrus skills run <skill-id> \
  --arguments-json '{"project":"Papyrus"}' \
  --run-id papyrus-001 \
  --json
```

The existing `artifact-template` skill subtype remains a compatibility mechanism for one-artifact templates with metadata `{targetKind, defaults, required}`. Instantiate it through `papyrus_create` with `template_id`; defaults merge recursively, explicit arrays replace defaults, required paths such as `extra.owner` are validated, and target-kind mismatches are rejected.

### Removing an artifact

Artifacts are never hard-deleted on request: every artifact gets a permanent, immutable `created` row in the mutation event log the moment it exists, so removal is a real, time-gated trash rather than a status flip. `remove` (any of the `tasks`/`docs`/`rules`/`skills` domain tools, or `papyrus artifact remove <id> [--reason <text>]`) moves an artifact to the trash: it is immediately excluded from every list/query, still directly reachable by id, and fully recoverable via `restore` until its purge deadline (30 days later) passes. `remove` refuses a Task that is the live Task Focus in any scope.

Once the deadline passes, the daemon's periodic sweep performs a real, cascading, irreversible deletion — the one deliberate, narrow exception to Papyrus's otherwise-absolute append-only history, enforced by the database itself (not merely application code) via a trigger condition checked at delete time.

## Tools

The `papyrus_*` tools are the low-level graph-store API:

- **`papyrus_create`** — create directly or instantiate via `template_id`
- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, perform bounded traversal, or update status
- **`papyrus_show`** — read nested metadata and bounded edges, optionally running gates

Agent-facing domain tools own lifecycle invariants and sit above this store API:

- **`tasks`** — create/update/list/show/plan, manage the singleton active focus, replace evidence-bearing checklists, hierarchy/dependencies, lifecycle transitions, non-blocking gates, and review completion that focuses one deterministic ready successor without claiming effort
- **`notes`** — capture/list/show deferred human intent, mark it consumed, promote it to an existing Task/Doc/Rule/Skill, or archive it with an explicit disposition
- **`docs`** — create/list/show, activate/archive/reopen, and document-safe graph links; Note mutations remain behind the Notes facade
- **`rules`** — create/list/show/preview, enable/disable, and attach governance gates to tasks
- **`skills`** — create/list/show/invoke/run, enable/disable, create compatibility templates, and atomically instantiate parameterized workflow runs

Every tool operation is registered in the daemon’s `/api/v1/ops` registry; parity is verified in tests. The task consumer uses the `tasks.graph` operation, which returns task nodes with explicit parent, child, and dependency IDs rather than leaking SQLite rows or asking the UI to reconstruct relationships.

Internally, application services depend on the `ArtifactStore` and `GateRunner` ports. SQLite and subprocess execution are adapters composed only by the daemon; task behavior is unit-tested against fakes without a database. Task visualization projects the same `TaskGraph` into semantic display graphs and sends them through a `GraphRenderer` port; the Pi adapter uses `beautiful-mermaid` for terminal Unicode output without leaking Mermaid syntax into the task domain.

## Interactive frontends

- `/tasks` — project/focused-graph scope, task lifecycle, append-only history, gates, dependencies, and nested metadata
- `/note <request>` — directly capture one project-scoped deferred request without creating a Task
- `/notes` — searchable project Notes inbox with consume, promote, and disposition-aware archive actions
- `/docs` — searchable non-Note documents, lifecycle, details, and graph links
- `/rules` — severity/condition rows, exact injection preview, enable/disable, and task gating
- `/skills` — trigger/tools rows, invocation into the editor, and artifact templates

All frontends use daemon-backed domain operations; none opens SQLite from the Pi process. **Show details** opens a bounded navigable view across Tasks, Notes, Docs, Rules, legacy Skills, templates, and workflow Skills. User-authored bodies render as width-aware Markdown with headings, emphasis, links, quotes, lists, tables, inline/fenced code, syntax highlighting, and every color/decorative style derived dynamically from the active Pi theme. Generated lifecycle, metadata, checklist, gate, history, and relationship sections keep explicit semantic theme colors. `↑/↓` scrolls, `←/→` pans wide relationships, and Esc returns to the browser; non-interactive clients receive stable source text.

## Notes

Notes are project-scoped `doc/note` artifacts for human requests that should be considered later. Capturing a Note does not create work, inject the entire inbox into prompts, or imply acceptance. The agent can use the `notes` domain tool to list and consume open Notes, decide whether to create a Task, Doc, Rule, or Skill through its owning domain tool, then promote the Note by linking that artifact. Archive requires one of `completed`, `duplicate`, `declined`, or `superseded`; promote archives with a `promoted` disposition and target ID. Capture, consumption, and disposition provenance remain in bounded Note history.

The default inbox contains draft and consumed/active Notes, is bounded to 50 rows, and has a hard limit of 200. Bodies are capped at 10,000 characters. Generic document and graph lifecycle operations reject Note mutations so they cannot bypass disposition provenance.

```bash
papyrus notes capture "Investigate the retry policy" --json
papyrus notes list --limit 25 --json
papyrus notes show <note-id> --json
papyrus notes consume <note-id> --json
# Create the resulting artifact with tasks/docs/rules/skills first, then:
papyrus notes promote <note-id> <target-id> --reason "Converted to tracked work" --json
papyrus notes archive <note-id> declined --reason "No longer relevant" --json
```

## Discuss

Discuss is a native, persistent deliberation, distinct from a one-shot ask: it survives across turns and sessions, takes multiple rounds, and can genuinely block a Task's completion until settled or deferred. A Discussion is a `doc` artifact with `subtype: "discussion"` -- real graph citizenship (edges, show/list) without a fifth enforced artifact kind. Its fine-grained lifecycle (`active`/`deferred`/`settled`) lives in `extra.discussion`, since Papyrus enforces status vocabulary per kind, not per subtype.

Rounds are a dedicated append-only child table (mirroring Task history's own shape): `open` records round 1, `reply` appends further rounds, refused once the Discussion is `deferred` or `settled` -- resume first. `defer` is explicitly non-blocking (paused, reason optional, resumable); `settle` is terminal, records an outcome, and archives the Doc. `block`/`unblock` manage the blocking relationship to a Task independently of `open`.

Blocking is real: `tasks.complete` is refused while any `active` Discussion has a `blocks` edge to that Task. A `deferred` Discussion does not block -- "we will get back to this" is distinct from "resolved."

Run `/discuss` for the interactive panel: browse every Discussion (the real `active`/`deferred`/`settled` state shown per row, not just the shared Doc status glyph), open a scrollable transcript, and reply/defer/resume/settle or block/unblock a task without leaving the TUI. Opening a *new* Discussion is left to the agent (same as Docs/Rules/Skills) -- `/discuss` browses and drives existing ones.

```bash
papyrus discuss open --title "Naming" --actor alice --content "Should we rename this?" --blocks-json '["task-id"]' --json
papyrus discuss reply <discussion-id> --actor bob --content "I think so, here's why..." --json
papyrus discuss defer <discussion-id> --reason "Waiting on design review" --json
papyrus discuss resume <discussion-id> --json
papyrus discuss settle <discussion-id> --settlement "Agreed: renaming to X" --json
papyrus discuss show <discussion-id> --json
```

## Tasks

Run `/tasks` for the interactive task panel:

- `/` filters; arrow keys navigate; Enter opens task actions; `s` switches among the persisted current-project, focused-root graph, and explicit all-projects views
- `g` opens the programmatic Unicode graph; Tab switches dependency/composition views and arrow keys pan
- routed graph layouts are bounded to 48 nodes/96 edges; larger graphs use a deterministic, box-drawn line fallback, and renderer failures are contained inside the viewport rather than escaping Pi
- advance the `todo → in-progress → review → done` lifecycle; failed review becomes `rejected`, retry returns to `in-progress`, and `canceled` is terminal
- use **focus** as the independent singleton Task selection that automatic continuation follows; focusing, pausing, or resuming never changes lifecycle
- starting nested effort moves todo ancestors to in-progress; submitting enters review; completing review checks both typed checklist proofs and executable gates
- passing review marks only that task done and focuses one deterministic ready successor while leaving the successor todo until effort starts
- successors are never auto-completed; fan-in, fan-out, diamonds, and disconnected DAGs remain explicit
- inspect deterministic execution layers, readiness, a box-drawn nested hierarchy, composition, dependencies, evidence-bearing checklists, and verification gates
- lifecycle colors are semantic and redundant with text/glyphs: To-Do grey, in-progress yellow, review blue, rejected orange, done green, and canceled red; `▶` marks active focus
- Show details keeps Checklist and Validation gates separate from incidental Metadata, renders bounded post-migration lifecycle history with actor/source/reason and gate evidence, then renders relationships as a Unicode box-drawing graph footer; `↑/↓` scrolls and `←/→` pans wide graphs
- the compact persistent widget shows the current scope label plus bounded open work in containment order and always retains active focus when it belongs to that scope

Authenticated CLI parity covers the changed lifecycle and focus operations:

```bash
papyrus tasks graph --json
papyrus tasks scope --json
papyrus tasks scope project --json
papyrus tasks scope graph <root-id> --json
papyrus tasks scope all --json
papyrus tasks assign-project <task-id> [project-root] --json
papyrus tasks active --json
papyrus tasks history <id> --json
papyrus tasks focus <id> --json
papyrus tasks focused --json
papyrus tasks pause --json
papyrus tasks unpause --json
papyrus tasks clear-focus --json
papyrus tasks update <id> --title "Revised title" --body "Revised body" --json
papyrus tasks update <id> --status todo --reason "created with legacy default" --json
papyrus tasks start <id> --json
papyrus tasks submit <id> --json
papyrus tasks complete <id> --json
papyrus tasks reject <id> --json
papyrus tasks retry <id> --json
papyrus tasks cancel <id> --json
```

### Focus-driven automatic continuation

Automatic continuation is a property of the singleton Task focus, not a per-Task automation flag. An active focus continues at Pi's public `agent_settled` boundary when Pi is idle and has no queued messages. `tasks pause` preserves the focused Task while stopping continuation; `tasks unpause` resumes it; `tasks clear-focus` removes it. Replacing focus selects an existing Task rather than creating or canceling one.

Continuation is single-flight and bounded to 20 automatic turns or 6 unchanged Task snapshots. Reaching either bound persists a paused focus and records the reason in append-only Task history. Human input resumes only these automatically paused focuses; an explicit user pause remains paused.

Checklist criteria are an item-to-proof map. Every new item requires one or more typed references to inspectable evidence; proof presence does not imply that the evidence passed an executable gate:

```ts
checklist: {
  "Write failing skill-row tests": {
    proof: [
      { type: "file", target: "test/frontends.test.ts" },
      { type: "symbol", target: "test/frontends.test.ts#skill row test" }
    ]
  }
}
```

Proof types are `file`, `symbol`, `code`, `test`, `command`, `artifact`, and `url`. Existing array checklists remain readable as legacy items with `proof: missing`; Papyrus does not invent evidence.

Papyrus also injects an Alef-style reconciliation block at `before_agent_start` while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **“Did we accomplish this task?”** and run review before marking it done. The injection disappears when every task is done or canceled.

After assembling each system-prompt addition, Papyrus emits a versioned `papyrus.context-injection.v1` observation on Pi's shared extension event bus. It contains only exact byte/character sizes, Rule count, a labeled token estimate, prompt share, sequence, and a SHA-256 payload fingerprint; Rule/Task text, prompts, project paths, and credentials are never included. Jittor can persist and assess these observations without Papyrus maintaining a second telemetry store.

Task edits mutate the existing Papyrus-owned Task identity and append an `updated` event; title, body, and labels can be revised without canceling the Task or creating a replacement. Lifecycle, relationships, gates, checklist metadata, scope, and focus remain intact. The same `update` action provides a narrowly guarded recovery for Tasks accidentally created terminal by a legacy default: `status=todo` requires an audit reason, cannot be combined with content edits, only applies when `created` is the sole lifecycle event, and appends `creation_recovered` rather than rewriting history.

## Why

Papyrus keeps SQLite’s local simplicity while centralizing writes, migrations, lifecycle invariants, gate execution, and maintenance in one small supervised process. The loopback bearer token prevents unrelated local HTTP callers from mutating the graph, while the native Pi extension provides richer domain tools and TUI integration.

## Install

Install the published Pi package, then install its supervised user service:

```bash
packed install npm:@danypops/papyrus
~/.pi/agent/npm/node_modules/.bin/papyrus service install
```

Existing databases are never migrated on daemon boot. After upgrading to a newer schema, run the authenticated CLI migration explicitly. Older databases receive prerequisite schemas—including Task continuation and Context Mesh extensions—in one transaction. Existing Tasks are deliberately marked **unscoped**: Papyrus does not guess ownership from titles, labels, historical cwd, or repository names. They remain visible in **All projects** until explicitly assigned with `papyrus tasks assign-project <task-id> [project-root]`:

```bash
~/.pi/agent/npm/node_modules/.bin/papyrus migrate schema
```

Until that command succeeds, health reports `migrationRequired` and normal domain operations are rejected with actionable guidance. Migration is not exposed as a Pi tool or MCP action. New empty databases bootstrap directly at the current schema.

Reload Pi once the service is active. Git installs remain available for development builds:

```bash
packed install git:github.com/DanyPops/papyrus
```
