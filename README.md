# Papyrus

Graph artifact service for Pi — enforced SQLite schema, domain tools and services, and native interactive frontends.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced**—the schema is the protocol. A supervised Bun daemon is the sole database owner; Pi extensions and other clients use its authenticated loopback service API.

## Architecture

```text
Pi tools + TUI
      ↓
tasks / docs / rules / skills domain tools
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

# Authenticated daemon-backed task automation (add --json for machine output)
papyrus tasks plan
papyrus tasks depend <task-id> <prerequisite-id>
papyrus tasks start <task-id>
papyrus tasks complete <task-id>
papyrus tasks automate <task-id> <on|off>
papyrus automation status
```

For repository work, install the versioned ownership guard once:

```bash
bun run guard:install
```

It blocks every Papyrus push whose destination is not `DanyPops/papyrus`, including explicit fallback URLs that bypass `origin`.

The daemon uses WAL, foreign keys, a bounded busy timeout, versioned migrations, periodic passive checkpoints, and periodic `PRAGMA optimize`. Keep the database on a local filesystem; SQLite WAL does not support network filesystems.

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

## Tools

The `papyrus_*` tools are the low-level graph-store API:

- **`papyrus_create`** — create directly or instantiate via `template_id`
- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, perform bounded traversal, or update status
- **`papyrus_show`** — read nested metadata and bounded edges, optionally running gates

Agent-facing domain tools own lifecycle invariants and sit above this store API:

- **`tasks`** — create/list/show/plan, manage the singleton active focus, replace evidence-bearing checklists, hierarchy/dependencies, lifecycle transitions, non-blocking gates, and review completion that focuses one deterministic ready successor without claiming effort
- **`docs`** — create/list/show, activate/archive/reopen, and document-safe graph links
- **`rules`** — create/list/show/preview, enable/disable, and attach governance gates to tasks
- **`skills`** — create/list/show/invoke/run, enable/disable, create compatibility templates, and atomically instantiate parameterized workflow runs

Every tool operation is registered in the daemon’s `/api/v1/ops` registry; parity is verified in tests. The task consumer uses the `tasks.graph` operation, which returns task nodes with explicit parent, child, and dependency IDs rather than leaking SQLite rows or asking the UI to reconstruct relationships.

Internally, application services depend on the `ArtifactStore` and `GateRunner` ports. SQLite and subprocess execution are adapters composed only by the daemon; task behavior is unit-tested against fakes without a database. Task visualization projects the same `TaskGraph` into semantic display graphs and sends them through a `GraphRenderer` port; the Pi adapter uses `beautiful-mermaid` for terminal Unicode output without leaking Mermaid syntax into the task domain.

## Interactive frontends

- `/tasks` — task lifecycle, append-only history, gates, dependencies, and nested metadata
- `/docs` — searchable documents, lifecycle, details, and graph links
- `/rules` — severity/condition rows, exact injection preview, enable/disable, and task gating
- `/skills` — trigger/tools rows, invocation into the editor, and artifact templates

All four use daemon-backed domain operations; none opens SQLite from the Pi process.

## Tasks

Run `/tasks` for the interactive task panel:

- `/` filters; arrow keys navigate; Enter opens task actions
- `g` opens the programmatic Unicode graph; Tab switches dependency/composition views and arrow keys pan
- routed graph layouts are bounded to 48 nodes/96 edges; larger graphs use a deterministic, box-drawn line fallback, and renderer failures are contained inside the viewport rather than escaping Pi
- advance the `todo → in-progress → review → done` lifecycle; failed review becomes `rejected`, retry returns to `in-progress`, and `canceled` is terminal
- use **active** only as the independent singleton focus that auto-drive continues; focusing a task never changes its lifecycle
- starting nested effort moves todo ancestors to in-progress; submitting enters review; completing review checks both typed checklist proofs and executable gates
- passing review marks only that task done and focuses one deterministic ready successor while leaving the successor todo until effort starts
- successors are never auto-completed; fan-in, fan-out, diamonds, and disconnected DAGs remain explicit
- inspect deterministic execution layers, readiness, a box-drawn nested hierarchy, composition, dependencies, evidence-bearing checklists, and verification gates
- lifecycle colors are semantic and redundant with text/glyphs: To-Do grey, in-progress yellow, review blue, rejected orange, done green, and canceled red; `▶` marks active focus
- Show details keeps Checklist and Validation gates separate from incidental Metadata, renders bounded post-migration lifecycle history with actor/source/reason and gate evidence, then renders relationships as a Unicode box-drawing graph footer; `↑/↓` scrolls and `←/→` pans wide graphs
- the compact persistent widget shows bounded open work in containment order and always retains the active focus

Authenticated CLI parity covers the changed lifecycle and focus operations:

```bash
papyrus tasks graph --json
papyrus tasks active --json
papyrus tasks history <id> --json
papyrus tasks focus <id> --json
papyrus tasks start <id> --json
papyrus tasks submit <id> --json
papyrus tasks complete <id> --json
papyrus tasks reject <id> --json
papyrus tasks retry <id> --json
papyrus tasks cancel <id> --json
papyrus tasks automate <id> <on|off> --json
papyrus automation status --json
papyrus automation run --json
```

### Opt-in supervised automation

Background graph reconciliation is off by default and requires two independent opt-ins: daemon configuration and `automation.enabled` on each Task. Only opted-in Tasks already in `review` are eligible for automatic gate/checklist review; Papyrus never skips the review lifecycle. When one completes, directly dependent opted-in successors that become ready may move from `todo` to `in-progress`. Every completion, rejection, and start is written to append-only history with actor `daemon`, source `automation-reconciler`, reason, and bounded gate evidence.

Enable the daemon with a systemd user-service override and restart it:

```ini
[Service]
Environment=PAPYRUS_AUTOMATION_ENABLED=1
```

```bash
systemctl --user edit papyrus.service
systemctl --user restart papyrus.service
papyrus tasks automate <task-id> on
papyrus automation status
```

Secure defaults are a 60-second interval, 10 Task transitions per sweep, gate concurrency 1, and a 120-second sweep deadline. Optional environment settings are `PAPYRUS_AUTOMATION_INTERVAL_MS` (10 seconds–1 hour), `PAPYRUS_AUTOMATION_MAX_TASKS` (1–100), `PAPYRUS_AUTOMATION_GATE_CONCURRENCY` (1–4), and `PAPYRUS_AUTOMATION_MAX_RUNTIME_MS` (1 ms–10 minutes). Candidate scans are capped at 1,000 review Tasks, sweeps are single-flight, subprocess gates inherit the sweep deadline, result arrays are bounded by the Task limit, and logs contain counts rather than gate output. `papyrus automation run` uses the same policy and refuses to reconcile while global automation is disabled.

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

Papyrus also injects an Alef-style reconciliation block on every agent turn while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **“Did we accomplish this task?”** and run review before marking it done. The injection disappears when every task is done or canceled.

In TUI and RPC modes, the extension checks the singleton active focus at Pi’s public `agent_settled` lifecycle boundary. If a focused task remains and no continuation is already pending, it queues one hidden next turn. No manual driving command is required. Driving is single-flight and pauses after 20 automatic turns or 6 unchanged task snapshots; human input and task progress reset the bounded counters automatically.

## Why

Papyrus keeps SQLite’s local simplicity while centralizing writes, migrations, lifecycle invariants, gate execution, and maintenance in one small supervised process. The loopback bearer token prevents unrelated local HTTP callers from mutating the graph, while the native Pi extension provides richer domain tools and TUI integration.

## Install

Install the published Pi package, then install its supervised user service:

```bash
packed install npm:@danypops/papyrus
~/.pi/agent/npm/node_modules/.bin/papyrus service install
```

Existing databases are never migrated on daemon boot. After upgrading to append-only task history, run the authenticated CLI migration explicitly. A v1 database receives the lifecycle prerequisite and history schema in one transaction; existing tasks receive no fabricated events:

```bash
~/.pi/agent/npm/node_modules/.bin/papyrus migrate task-history
```

Until that command succeeds, health reports `migrationRequired` and normal domain operations are rejected with actionable guidance. Migration is not exposed as a Pi tool or MCP action. New empty databases bootstrap directly at the current schema.

Reload Pi once the service is active. Git installs remain available for development builds:

```bash
packed install git:github.com/DanyPops/papyrus
```
