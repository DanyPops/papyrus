# @danypops/pi-papyrus

The Pi extension for Papyrus: native tools, TUI panels, and context injection over `@danypops/papyrus`'s authenticated loopback daemon.

## Tools

The `papyrus_*` tools are the low-level graph-store API:

- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, perform bounded traversal, or read the mutation event log
- **`papyrus_show`** — read nested metadata and bounded edges, optionally running gates

Agent-facing domain tools own lifecycle invariants and sit above this store API:

- **`tasks`** — create/update/list/show/plan, manage the singleton active focus, replace evidence-bearing checklists, hierarchy/dependencies, lifecycle transitions, non-blocking gates, and review completion that focuses one deterministic ready successor without claiming effort
- **`notes`** — capture/list/show deferred human intent, mark it consumed, promote it to an existing Task/Doc/Rule/Skill, or archive it with an explicit disposition
- **`docs`** — create/update/list/show, activate/archive/reopen, and document-safe graph links; Note mutations remain behind the Notes facade
- **`rules`** — create/update/list/show/preview, enable/disable, and attach governance gates to tasks
- **`skills`** — create/update/list/show/invoke/run, enable/disable, create compatibility templates, and atomically instantiate parameterized workflow runs
- **`playbooks`** — a completely different beast from Skills, not a subtype: a trigger and an ordered list of steps an agent reads and follows, never mechanically instantiated. It CAN compose other Playbooks though, the same way Skills call other Skills: link one to another via `papyrus_graph` and invoking the caller recursively inlines the linked Playbook's steps. create/update/list/show/invoke, enable/disable. A Playbook can declare named arguments (`{name, description?, required?}`, required defaults true); invoking with some unsupplied lists exactly which required ones are still missing and directs the agent to ask via `discuss` with `live:true` rather than guess

Every tool operation is registered in the daemon's `/api/v1/ops` registry; parity is verified in tests. The task consumer uses the `tasks.graph` operation, which returns task nodes with explicit parent, child, and dependency IDs rather than leaking SQLite rows or asking the UI to reconstruct relationships.

## Interactive frontends

- `/tasks` — project/focused-graph scope, task lifecycle, append-only history, gates, dependencies, and nested metadata
- `/note <request>` — directly capture one project-scoped deferred request without creating a Task
- `/notes` — searchable project Notes inbox with consume, promote, and disposition-aware archive actions
- `/docs` — searchable non-Note documents, lifecycle, details, edit, and graph links
- `/rules` — severity/condition rows, exact injection preview, edit, enable/disable, and task gating
- `/skills` — trigger/tools rows, edit, invocation into the editor, and artifact templates
- `/playbooks` — trigger/tools rows, edit, invocation into the editor, and graph links
- `/playbook <name>` — tab-completes active playbook titles and places that one's invocation directly in the editor, one step instead of browse-then-select; no argument falls back to the full `/playbooks` browser

All frontends use daemon-backed domain operations; none opens SQLite from the Pi process. **Show details** opens a bounded navigable view across Tasks, Notes, Docs, Rules, legacy Skills, templates, and workflow Skills. User-authored bodies render as width-aware Markdown with headings, emphasis, links, quotes, lists, tables, inline/fenced code, syntax highlighting, and every color/decorative style derived dynamically from the active Pi theme. Generated lifecycle, metadata, checklist, gate, history, and relationship sections keep explicit semantic theme colors; relationships render as a small Unicode graph via `beautiful-mermaid` when the neighbor set is real and within the routed-rendering bound, falling back to a plain, still name-resolved arrow list otherwise. `↑/↓` scrolls, `←/→` pans wide relationships, and Esc returns to the browser; non-interactive clients receive stable source text.

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

A persistent widget (matching the Task widget) shows a simple `Notes N` count, scoped by default to the current project (CWD), so a growing inbox is visible without opening `/notes`.

## Discuss

Discuss is a native, persistent deliberation, distinct from a one-shot ask: it survives across turns and sessions, takes multiple rounds, and can genuinely block a Task's completion until settled or deferred. A Discussion is a `doc` artifact with `subtype: "discussion"` -- real graph citizenship (edges, show/list) without a fifth enforced artifact kind. Its fine-grained lifecycle (`active`/`deferred`/`settled`) lives in `extra.discussion`, since Papyrus enforces status vocabulary per kind, not per subtype.

Rounds are a dedicated append-only child table (mirroring Task history's own shape): `open` records round 1, `reply` appends further rounds, refused once the Discussion is `deferred` or `settled` -- resume first. `defer` is explicitly non-blocking (paused, reason optional, resumable); `settle` is terminal, records an outcome, and archives the Doc. `block`/`unblock` manage the blocking relationship to a Task independently of `open`.

Blocking is real: `tasks.complete` is refused while any `active` Discussion has a `blocks` edge to that Task. A `deferred` Discussion does not block -- "we will get back to this" is distinct from "resolved."

`open`/`reply` can also pose a structured choice instead of (or alongside) free text: `options` (2-10 entries) plus `options_mode` -- `single` is mutually exclusive (exactly one pick), `multi` allows several. The Discussion remembers the pending choice (`extra.discussion.pendingOptions`/`pendingOptionsMode`) until a `reply` answers it with `selected`, validated against exactly what was offered and the mode's cardinality; a reply can also pose the *next* round's choice in the same call.

Run `/discuss` for the interactive panel: browse every Discussion (the real `active`/`deferred`/`settled` state shown per row, alongside any choice awaiting an answer), open a scrollable transcript showing what was posed and picked in each round, and reply/defer/resume/settle or block/unblock a task without leaving the TUI. Replying to a pending choice shows a real picker -- the native single-select list for `single`, or a checkbox multi-select for `multi`, since no built-in multi-select exists in the Pi extension UI. Both modes append a numbered "type your own answer" row -- a genuinely open answer is exactly as valid as any posed option. The multi-select picker supports a number key as a direct quick-select (jump straight to that row instead of scrolling), and steadily highlights checked rows while dimming the rest so the eye reads "what's chosen" independent of cursor position; its cursor row blinks to mark focus. It also auto-cancels after 30s of zero input -- the very first keystroke of any kind stops that countdown permanently for that prompt. Opening a *new* Discussion is left to the agent (same as Docs/Rules/Skills) -- `/discuss` browses and drives existing ones.

```bash
papyrus discuss open --title "Naming" --actor alice --content "Should we rename this?" --blocks-json '["task-id"]' --json
papyrus discuss open --title "Which approach" --actor alice --content "Pick one" --options-json '["A","B"]' --options-mode single --json
papyrus discuss reply <discussion-id> --actor bob --content "I think so, here's why..." --json
papyrus discuss reply <discussion-id> --actor bob --content "Going with B" --selected-json '["B"]' --json
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
- the compact persistent widget shows the current scope label plus bounded open work in containment order and always retains active focus when it belongs to that scope, refreshed both on tool activity and a bounded background poll so a mutation from another session or a plain CLI call is reflected without needing a Papyrus-tool call to trigger it

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

Task edits mutate the existing Papyrus-owned Task identity and append an `updated` event; title, body, and labels can be revised without canceling the Task or creating a replacement. Lifecycle, relationships, gates, checklist metadata, scope, and focus remain intact. The same `update` action provides a narrowly guarded recovery for Tasks accidentally created terminal by a legacy default: `status=todo` requires an audit reason, cannot be combined with content edits, only applies when `created` is the sole lifecycle event, and appends `creation_recovered` rather than rewriting history.

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

Papyrus also injects an Alef-style reconciliation block at `before_agent_start` while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **"Did we accomplish this task?"** and run review before marking it done. The injection disappears when every task is done or canceled.

After assembling each system-prompt addition, Papyrus emits a versioned `papyrus.context-injection.v1` observation on Pi's shared extension event bus. It contains only exact byte/character sizes, Rule count, a labeled token estimate, prompt share, sequence, and a SHA-256 payload fingerprint; Rule/Task text, prompts, project paths, and credentials are never included. Jittor can persist and assess these observations without Papyrus maintaining a second telemetry store.
