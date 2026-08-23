# @danypops/pi-papyrus

The Pi extension for Papyrus: native tools, TUI panels, and context injection over `@danypops/papyrus`'s authenticated loopback daemon. See the [repo root README](../../README.md) for install and architecture, and [`@danypops/papyrus`](../papyrus/README.md) for the full CLI/schema reference.

## Tools

`papyrus_query`/`papyrus_graph`/`papyrus_show` are the low-level graph-store API (filter/search, link/traverse, read+gates). Above that, `notes`, `docs`, `rules`, `playbooks`, `tasks`, and `discuss` are projected as one real tool per operation (`tasks_create`, `rules_enable`, `discuss_open`, ...) — no `action` dispatch, each with its own schema:

- **tasks** — lifecycle (`start`/`submit`/`complete`/`reject`/`retry`/`cancel`), a singleton active **focus** independent of lifecycle, evidence-bearing checklists, dependencies/containment, and non-blocking gates. `project_root` is required wherever a plain call would otherwise need one — resolve human scope names via `tasks_resolve_project` first.
- **notes** — capture/list/show a project-scoped deferred-intent inbox; consume, promote to a Task/Doc/Rule/Playbook, or archive with a disposition (`completed`/`duplicate`/`declined`/`superseded`).
- **docs** — knowledge artifacts: create, activate/archive/reopen, and graph-link.
- **rules** — governance injected into the Pi system prompt: enable/disable and attach gates to tasks.
- **playbooks** — a trigger plus an ordered list of steps (plain-prose task, or a typed `doc`/`rule`/`call` step); `playbooks_invoke` materializes the whole graph in one transaction and focuses the first real task.
- **discuss** — a persistent, multi-round deliberation that can genuinely block a Task's completion (`discuss_block`/`discuss_unblock`) until `settle`d or `defer`red. Supports posing a structured choice (`options`/`options_mode`), and grading it as a quiz via `correct_options` + `explanation` — see `packages/papyrus`'s own CLI reference for the full quiz semantics.

## Interactive frontends

- `/tasks` — project/focused-graph scope, lifecycle, history, gates, dependencies, nested metadata
- `/note <request>` — capture one project-scoped deferred request directly
- `/notes` — searchable inbox with consume/promote/archive
- `/docs` — searchable documents with lifecycle, edit, and graph links
- `/rules` — condition/severity rows, injection preview, edit, enable/disable
- `/playbooks`, `/playbook <name>` — browse and invoke; a named playbook tab-completes straight into the editor
- `/discuss` — browse every Discussion, open its transcript, reply/defer/resume/settle, answer a pending choice via a real picker (single- or multi-select)

All frontends are daemon-backed (no direct SQLite access from the Pi process). **Show details** opens a bounded navigable view across every kind; user-authored bodies render as width-aware Markdown, generated sections (lifecycle, gates, history) keep semantic theme colors, and relationships render as a small Unicode graph.

## Focus-driven automatic continuation

An active Task focus continues automatically at Pi's `agent_settled` boundary when idle, bounded to 20 automatic turns or 6 unchanged snapshots — `tasks_pause`/`tasks_unpause`/`tasks_clear_focus` control it independently of lifecycle. Papyrus also injects a `Current`/`Desired`/`Verify`/`Next` reconciliation block at `before_agent_start` while work remains, and emits a content-free `papyrus.context-injection.v1` observation (sizes, Rule count, a payload fingerprint — never Rule/Task text or credentials) that Jittor can independently persist and assess.
