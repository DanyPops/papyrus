# Papyrus

Graph artifact service for Pi — enforced SQLite schema, domain facades, and native interactive frontends.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced**—the schema is the protocol. A supervised Bun daemon is the sole database owner; Pi extensions and other clients use its authenticated loopback service API.

## Architecture

```text
Pi tools + TUI
      ↓
tasks / docs / rules / skills facades
      ↓
Papyrus client → authenticated loopback daemon
      ↓
operation registry + lifecycle services
      ↓
graph-store operations → SQLite (WAL)
```

The `papyrus_*` tools remain low-level administration escape hatches. Normal agent work should use the domain facade tools.

## Storage and service

```text
$XDG_DATA_HOME/papyrus/papyrus.db       # durable graph
$XDG_RUNTIME_DIR/papyrus/{port,token}   # private daemon discovery
```

```bash
bun src/cli.ts service install   # install, enable, and start user service
bun src/cli.ts service status
bun src/cli.ts service restart
```

The daemon uses WAL, foreign keys, a bounded busy timeout, versioned migrations, periodic passive checkpoints, and periodic `PRAGMA optimize`. Keep the database on a local filesystem; SQLite WAL does not support network filesystems.

## Schema protocol (enforceable)

Papyrus enforces four artifact kinds:

- `doc` — knowledge: specifications, decisions, and research
- `task` — work: desired outcomes, gates, checklists, and dependencies
- `rule` — governance injected into the Pi system prompt
- `skill` — reusable procedural knowledge

Each kind has an enforced status vocabulary. Every edge endpoint must exist, and every edge relation must be registered in `relation_names`. Relations are universal: any artifact kind can link to any other kind.

### Hierarchy and traversal

Use `contains` and `part_of` for explicit parent/child structure; use `depends_on` for execution ordering. Graph reads are cycle-safe and bounded by `depth` and `max_nodes` (defaults: depth 4, 100 nodes; hard ceilings: depth 20, 1,000 nodes).

### Artifact templates

Templates remain inside the four-kind model: create a `skill` with subtype `artifact-template` and metadata `{targetKind, defaults, required}`. Instantiate it through `papyrus_create` with `template_id`; defaults merge recursively, explicit arrays replace defaults, required paths such as `extra.owner` are validated, and target-kind mismatches are rejected.

## Tools

The `papyrus_*` tools are the low-level graph-store API:

- **`papyrus_create`** — create directly or instantiate via `template_id`
- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, perform bounded traversal, or update status
- **`papyrus_show`** — read nested metadata and bounded edges, optionally running gates

Agent-facing facade tools own domain lifecycle invariants and sit above this store API:

- **`tasks`** — create/list/show, hierarchy/dependencies, start/fail/retry, non-blocking gates, and gate-enforced completion
- **`docs`** — create/list/show, activate/archive/reopen, and document-safe graph links
- **`rules`** — create/list/show/preview, enable/disable, and attach governance gates to tasks
- **`skills`** — create/list/show/invoke, enable/disable, create templates, and instantiate templates

Every tool operation is registered in the daemon’s `/api/v1/ops` registry; parity is verified in tests.

## Interactive frontends

- `/tasks` — task lifecycle, gates, dependencies, and nested metadata
- `/docs` — searchable documents, lifecycle, details, and graph links
- `/rules` — severity/condition rows, exact injection preview, enable/disable, and task gating
- `/skills` — trigger/tools rows, invocation into the editor, and artifact templates

All four use daemon-backed domain operations; none opens SQLite from the Pi process.

## Tasks

Run `/tasks` for the interactive task panel:

- `/` filters; arrow keys navigate; Enter opens task actions
- advance the `pending → active → done` lifecycle or retry `failed → pending`
- inspect dependencies and run verification gates
- persistent widget shows active and pending work above the editor

Papyrus also injects an Alef-style reconciliation block on every agent turn while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **“Did we accomplish this task?”** and run gates before marking it done. The injection disappears when every task is complete.

## Why

Papyrus keeps SQLite’s local simplicity while centralizing writes, migrations, lifecycle invariants, gate execution, and maintenance in one small supervised process. The loopback bearer token prevents unrelated local HTTP callers from mutating the graph, while the native Pi extension provides richer domain tools and TUI integration.

## Install

```bash
pi install git:github.com/DanyPops/papyrus
```
