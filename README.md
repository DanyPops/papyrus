# Papyrus

Minimal graph artifact store for Pi — Scribe's concept, enforced schema, zero service.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced** — the schema IS the protocol. No markdown, no container, no daemon — pure TS, in-process, dual-runtime SQLite.

## Storage

```
$XDG_DATA_HOME/papyrus/papyrus.db    ← ~/.local/share/papyrus/papyrus.db
```

## Schema protocol (enforceable)

```sql
-- The vocabulary: kinds must be registered before artifacts can use them
CREATE TABLE kinds (
    name        TEXT PRIMARY KEY,          -- e.g. 'effort.goal'
    namespace   TEXT NOT NULL,             -- 'effort'
    description TEXT
);

-- Allowed relations per kind pair (FK-enforced)
CREATE TABLE relations (
    from_kind   TEXT NOT NULL REFERENCES kinds(name),
    relation    TEXT NOT NULL,             -- e.g. 'depends_on'
    to_kind     TEXT NOT NULL REFERENCES kinds(name),
    PRIMARY KEY (from_kind, relation, to_kind)
);

-- Statuses per kind
CREATE TABLE statuses (
    name        TEXT NOT NULL,             -- 'work.active'
    kind        TEXT NOT NULL REFERENCES kinds(name),
    PRIMARY KEY (name, kind)
);

-- Artifacts: kind must exist, status must be registered for that kind
CREATE TABLE artifacts (
    id          TEXT PRIMARY KEY,          -- slug
    kind        TEXT NOT NULL REFERENCES kinds(name),
    title       TEXT NOT NULL,
    status      TEXT NOT NULL,
    body        TEXT DEFAULT '',
    labels      TEXT DEFAULT '[]',         -- JSON array
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (kind, status) REFERENCES statuses(kind, name)
);

-- Edges: both ends must exist, relation must be allowed for the kind pair
CREATE TABLE edges (
    from_id     TEXT NOT NULL REFERENCES artifacts(id),
    relation    TEXT NOT NULL,
    to_id       TEXT NOT NULL REFERENCES artifacts(id),
    weight      REAL DEFAULT 0,
    PRIMARY KEY (from_id, relation, to_id)
);
```

## Tools

- **`papyrus_create`** — create/update an artifact (validates kind + status exist)
- **`papyrus_query`** — list/filter by kind/status/labels/full-text
- **`papyrus_graph`** — edges, tree, fan-in/out (traverses the typed edge table)
- **`papyrus_show`** — read one artifact with its edges

## Why

Scribe is a 4.2GB containerized Go service. Papyrus is a SQLite file you query from any Pi session — no service, no auth token, no port. The schema is enforced at the DB level (FK + CHECK) and the application level (kind/relation registration).

## Install

```bash
pi install git:github.com/DanyPops/papyrus
```
