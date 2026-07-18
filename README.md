# Papyrus

Minimal graph artifact store for Pi — Scribe's concept, enforced schema, zero service.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced** — the schema IS the protocol. No markdown, no container, no daemon — pure TS, in-process, dual-runtime SQLite.

## Storage

```
$XDG_DATA_HOME/papyrus/papyrus.db    ← ~/.local/share/papyrus/papyrus.db
```

## Schema protocol (enforceable)

Papyrus enforces four artifact kinds:

- `doc` — knowledge: specifications, decisions, and research
- `task` — work: desired outcomes, gates, checklists, and dependencies
- `rule` — governance injected into the Pi system prompt
- `skill` — reusable procedural knowledge

Each kind has an enforced status vocabulary. Every edge endpoint must exist, and every edge relation must be registered in `relation_names`. Relations are universal: any artifact kind can link to any other kind.

## Tools

- **`papyrus_create`** — create an artifact with validated kind and status
- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, traverse a subgraph, or update status
- **`papyrus_show`** — read one artifact with edges and optionally run its gates

## Tasks

Run `/tasks` for the interactive task panel:

- `/` filters; arrow keys navigate; Enter opens task actions
- advance the `pending → active → done` lifecycle or retry `failed → pending`
- inspect dependencies and run verification gates
- persistent widget shows active and pending work above the editor

Papyrus also injects an Alef-style reconciliation block on every agent turn while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **“Did we accomplish this task?”** and run gates before marking it done. The injection disappears when every task is complete.

## Why

Scribe is a 4.2GB containerized Go service. Papyrus is a SQLite file you query from any Pi session — no service, no auth token, no port. The schema is enforced at the DB level (FK + CHECK) and the application level (kind/relation registration).

## Install

```bash
pi install git:github.com/DanyPops/papyrus
```
