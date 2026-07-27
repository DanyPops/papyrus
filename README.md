# Papyrus

Graph artifact service for Pi — enforced SQLite schema, domain tools and services, and native interactive frontends.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced**—the schema is the protocol. A supervised Bun daemon is the sole database owner; Pi extensions and other clients use its authenticated loopback service API.

This is a two-package workspace, mirroring how the daemon and the Pi extension are actually consumed:

- **[`packages/papyrus`](packages/papyrus/README.md)** — the daemon, CLI, and domain services. Installable and runnable standalone, with no Pi dependency.
- **[`packages/pi-papyrus`](packages/pi-papyrus/README.md)** — the Pi extension: native tools, TUI panels, and context injection over the daemon's authenticated loopback API.

## Architecture

```text
Pi tools + TUI                          (packages/pi-papyrus)
      ↓
tasks / notes / docs / rules / skills domain tools
      ↓
Papyrus client → authenticated loopback daemon
      ↓
operation registry + lifecycle services  (packages/papyrus)
      ↓
graph-store operations → SQLite (WAL)
```

## Why

Papyrus keeps SQLite's local simplicity while centralizing writes, migrations, lifecycle invariants, gate execution, and maintenance in one small supervised process. The loopback bearer token prevents unrelated local HTTP callers from mutating the graph, while the native Pi extension provides richer domain tools and TUI integration.

## Install

Install the Pi extension; it depends on the daemon package, which is pulled in automatically:

```bash
packed install npm:@danypops/pi-papyrus
~/.pi/agent/npm/node_modules/.bin/papyrus service install
```

Existing databases are never migrated on daemon boot. After upgrading to a newer schema, run the authenticated CLI migration explicitly:

```bash
~/.pi/agent/npm/node_modules/.bin/papyrus migrate schema
```

Until that command succeeds, health reports `migrationRequired` and normal domain operations are rejected with actionable guidance. Migration is not exposed as a Pi tool or MCP action. New empty databases bootstrap directly at the current schema.

Reload Pi once the service is active. Git installs remain available for development builds:

```bash
packed install git:github.com/DanyPops/papyrus
```

See each package's own README for storage/schema details (`packages/papyrus`) and interactive frontends/tool reference (`packages/pi-papyrus`).
