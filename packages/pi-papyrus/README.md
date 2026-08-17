# @danypops/pi-papyrus

The Pi extension for Papyrus: native tools, TUI panels, and context injection over `@danypops/papyrus`'s authenticated loopback daemon.

## Tools

The `papyrus_*` tools are the low-level graph-store API:

- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, perform bounded traversal, or read the mutation event log
- **`papyrus_show`** — read nested metadata and bounded edges, optionally running gates

Agent-facing domain tools own lifecycle invariants and sit above this store API. `notes`, `docs`, `rules`, `playbooks`, `tasks`, and `discuss` are all projected from Papyrus's own Vehicle as one real tool per operation (`notes_capture`, `rules_create`, `playbooks_invoke`, `tasks_complete`, `discuss_open`, and so on) -- no `action` dispatch, each with its own schema. `discuss_open`/`discuss_reply` additionally accept `live: true` for a synchronous human round-trip, via vehicle-client-pi's `interactiveFollowUps` hook rather than a bespoke tool:

- **tasks** (`tasks_create`, `tasks_update`, `tasks_list`, `tasks_show`, `tasks_plan`, `tasks_graph`, `tasks_focus`, `tasks_pause`, `tasks_unpause`, `tasks_clear_focus`, `tasks_start`, `tasks_submit`, `tasks_complete`, `tasks_reject`, `tasks_retry`, `tasks_cancel`, `tasks_cancel_subtree`, `tasks_run_gates`, `tasks_set_checklist`, `tasks_set_gates`, `tasks_depend`, `tasks_undepend`, `tasks_contain`, `tasks_uncontain`, `tasks_claim`, `tasks_heartbeat_lease`, `tasks_release_lease`, `tasks_lease`, `tasks_context`, `tasks_event_feed`, `tasks_projects`, `tasks_resolve_project`, `tasks_register_project`, `tasks_scope`, `tasks_set_scope`, `tasks_assign_project`, `tasks_active`, `tasks_focused`, `tasks_history`) — manages the singleton active focus, evidence-bearing checklists, hierarchy/dependencies, lifecycle transitions, non-blocking gates, and review completion that focuses one deterministic ready successor without claiming effort. `project_root` is required wherever a plain `tasks` call would otherwise need one (list/graph/plan/active/focused/scope/context/create) -- there is no ambient Pi cwd server-side. Resolve human scope names through `tasks_resolve_project`, then pass its canonical root. `tasks_create` supports a seven-day caller/project-scoped `idempotency_key` for exact-payload retries. `tasks_focus`/`tasks_pause`/`tasks_unpause`/`tasks_clear_focus` still authorize their write via this session's own cached secret, and still broadcast `papyrus.task-focus.v1` on Pi's own event bus for a sibling extension to observe, exactly as before
- **notes** (`notes_capture`, `notes_list`, `notes_show`, `notes_consume`, `notes_promote`, `notes_archive`) — capture/list/show deferred human intent, mark it consumed, promote it to an existing Task/Doc/Rule/Playbook, or archive it with an explicit disposition
- **docs** (`docs_create`, `docs_list`, `docs_show`, `docs_activate`, `docs_archive`, `docs_reopen`, `docs_link`, `docs_assign_project`, `docs_update`) — activate/archive/reopen and document-safe graph links; Note mutations remain behind the Notes facade
- **rules** (`rules_create`, `rules_list`, `rules_show`, `rules_preview`, `rules_enable`, `rules_disable`, `rules_gate`, `rules_assign_project`, `rules_update`) — enable/disable and attach governance gates to tasks
- **playbooks** (`playbooks_create`, `playbooks_list`, `playbooks_show`, `playbooks_invoke`, `playbooks_preview`, `playbooks_enable`, `playbooks_disable`, `playbooks_assign_project`, `playbooks_update`, `playbooks_contain`, `playbooks_uncontain`, `playbooks_depend`, `playbooks_undepend`) — a trigger and an ordered list of steps. Each step is a plain prose string (a task), or a structured object: `{kind:'doc',title,body?,subtype?,labels?}` creates a Doc, `{kind:'rule',title,body?,condition?,action?,severity?,labels?}` creates a Rule, `{kind:'call',title,playbookId,arguments?}` nests another Playbook's own run as a pipeline step gated in the same sequence, `{kind:'task',title?,body}` is an explicit task step. `playbooks_invoke` recycles the shared blueprint materialization engine: it compiles the steps and any `contain`/`depend` composition into real artifacts (a Task per plain/task step, a Doc/Rule per doc/rule step, a nested run per call step), wires task-like steps with `dependsOn` so completing one auto-focuses the next, and focuses the first real task. No text dump — one step surfaces at a time, as it becomes the focused task, same as any other Task. `playbooks_contain`/`playbooks_uncontain` nest a child Playbook inside a parent (its steps run after the parent's own, as part of it); `playbooks_depend`/`playbooks_undepend` chain a prerequisite Playbook before another (it must fully complete first) -- both are whole-Playbook composition, distinct from a `call` step's finer-grained, single-step nesting. `playbooks_preview` renders the whole tree as text with no side effects, for reading before invoking. A Playbook can declare named arguments (`{name, description?, required?, type?('string'|'number'|'boolean', default 'string'), enum?, default?}`, required defaults true; referenced in step text/call arguments as `{{name}}`); invoking with a required one unsupplied creates nothing and reports exactly which are still missing, directing the agent to ask via `discuss_open`/`discuss_reply` with `live:true` rather than guess
- **discuss** (`discuss_open`, `discuss_reply`, `discuss_defer`, `discuss_resume`, `discuss_settle`, `discuss_block`, `discuss_unblock`, `discuss_show`, `discuss_rounds`, `discuss_list`) — a Discussion persists across multiple rounds and can genuinely block a Task's completion until settled or deferred (`discuss_block`/`discuss_unblock`). `discuss_reply` is refused once deferred or settled -- `discuss_resume` first. `discuss_open`/`discuss_reply` can pose a structured choice via `options` (2-10 entries, each a bare string or `{title, description}`) + `options_mode` (`single`/`multi`); a later `discuss_reply` answers it via `selected`, validated against it. Adding `correct_options` + `explanation` turns that same choice into a graded quiz/knowledge assessment -- see "Quiz assessments" below. `live: true` on either gets the human's answer synchronously in the same tool call -- the operation itself always durably records the round first (exactly like every other Vehicle operation), then an optional local prompt (the pending choice's picker if one was posed, otherwise a freeform question) runs via a per-operation `interactiveFollowUps` resolver (see `@danypops/vehicle-client-pi`), degrading silently to the plain async round when there's no interactive UI

Every tool operation is registered in the daemon's `/api/v1/ops` registry; parity is verified in tests. The task consumer uses the `tasks.graph` operation, which returns task nodes with explicit parent, child, and dependency IDs rather than leaking SQLite rows or asking the UI to reconstruct relationships.

## Interactive frontends

- `/tasks` — project/focused-graph scope, task lifecycle, append-only history, gates, dependencies, and nested metadata
- `/note <request>` — directly capture one project-scoped deferred request without creating a Task
- `/notes` — searchable project Notes inbox with consume, promote, and disposition-aware archive actions
- `/docs` — searchable non-Note documents, lifecycle, details, edit, and graph links
- `/rules` — severity/condition rows, exact injection preview, edit, enable/disable, and task gating
- `/playbooks` — trigger/tools rows, edit, invocation into the editor, and graph links
- `/playbook <name>` — tab-completes active playbook titles and places that one's invocation directly in the editor, one step instead of browse-then-select; no argument falls back to the full `/playbooks` browser

All frontends use daemon-backed domain operations; none opens SQLite from the Pi process. **Show details** opens a bounded navigable view across Tasks, Notes, Docs, Rules, and Playbooks. User-authored bodies render as width-aware Markdown with headings, emphasis, links, quotes, lists, tables, inline/fenced code, syntax highlighting, and every color/decorative style derived dynamically from the active Pi theme. Generated lifecycle, metadata, checklist, gate, history, and relationship sections keep explicit semantic theme colors; relationships render as a small Unicode graph via `beautiful-mermaid` when the neighbor set is real and within the routed-rendering bound, falling back to a plain, still name-resolved arrow list otherwise. `↑/↓` scrolls, `←/→` pans wide relationships, and Esc returns to the browser; non-interactive clients receive stable source text.

## Notes

Notes are project-scoped `doc/note` artifacts for human requests that should be considered later. Capturing a Note does not create work, inject the entire inbox into prompts, or imply acceptance. The agent can use the `notes` domain tool to list and consume open Notes, decide whether to create a Task, Doc, Rule, or Playbook through its owning domain tool, then promote the Note by linking that artifact. Archive requires one of `completed`, `duplicate`, `declined`, or `superseded`; promote archives with a `promoted` disposition and target ID. Capture, consumption, and disposition provenance remain in bounded Note history.

The default inbox contains draft and consumed/active Notes, is bounded to 50 rows, and has a hard limit of 200. Bodies are capped at 10,000 characters. Generic document and graph lifecycle operations reject Note mutations so they cannot bypass disposition provenance.

```bash
papyrus notes capture "Investigate the retry policy" --json
papyrus notes list --limit 25 --json
papyrus notes show <note-id> --json
papyrus notes consume <note-id> --json
# Create the resulting artifact with tasks/docs/rules/playbooks first, then:
papyrus notes promote <note-id> <target-id> --reason "Converted to tracked work" --json
papyrus notes archive <note-id> declined --reason "No longer relevant" --json
```

A persistent widget (matching the Task widget) shows a simple `Notes N` count, scoped by default to the current project (CWD), so a growing inbox is visible without opening `/notes`.

## Discuss

Discuss is a native, persistent deliberation, distinct from a one-shot ask: it survives across turns and sessions, takes multiple rounds, and can genuinely block a Task's completion until settled or deferred. A Discussion is a `task` artifact with `subtype: "discussion"` -- real graph citizenship (edges, show/list, `blocks`) without a dedicated enforced artifact kind of its own. Its fine-grained lifecycle (`active`/`deferred`/`settled`) lives in `extra.discussion`, since Papyrus enforces status vocabulary per kind, not per subtype.

Rounds are a dedicated append-only child table (mirroring Task history's own shape): `open` records round 1, `reply` appends further rounds, refused once the Discussion is `deferred` or `settled` -- resume first. `defer` is explicitly non-blocking (paused, reason optional, resumable); `settle` is terminal, records an outcome, and archives the Doc. `block`/`unblock` manage the blocking relationship to a Task independently of `open`.

Blocking is real: `tasks.complete` is refused while any `active` Discussion has a `blocks` edge to that Task. A `deferred` Discussion does not block -- "we will get back to this" is distinct from "resolved."

`open`/`reply` can also pose a structured choice instead of (or alongside) free text: `options` (2-10 entries) plus `options_mode` -- `single` is mutually exclusive (exactly one pick), `multi` allows several. The Discussion remembers the pending choice (`extra.discussion.pendingOptions`/`pendingOptionsMode`) until a `reply` answers it with `selected`, validated against exactly what was offered and the mode's cardinality; a reply can also pose the *next* round's choice in the same call.

Run `/discuss` for the interactive panel: browse every Discussion (the real `active`/`deferred`/`settled` state shown per row, alongside any choice awaiting an answer), open a scrollable transcript showing what was posed and picked in each round, and reply/defer/resume/settle or block/unblock a task without leaving the TUI. Replying to a pending choice shows a real picker -- the native single-select list for `single`, or a checkbox multi-select for `multi`, since no built-in multi-select exists in the Pi extension UI. Both modes append a numbered "type your own answer" row -- a genuinely open answer is exactly as valid as any posed option. The multi-select picker supports a number key as a direct quick-select (jump straight to that row instead of scrolling), and steadily highlights checked rows while dimming the rest so the eye reads "what's chosen" independent of cursor position; its cursor row blinks to mark focus. It also auto-cancels after 30s of zero input -- the very first keystroke of any kind stops that countdown permanently for that prompt. A quiz's options display lettered (A, B, C, ...) in this same picker. Opening a *new* Discussion is left to the agent (same as Docs/Rules/Playbooks) -- `/discuss` browses and drives existing ones.

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

### Quiz assessments

A posed choice becomes a graded knowledge assessment by adding `correct_options` (one or more entries drawn verbatim from `options` -- exact text, never an index or a display letter) + `explanation` (**required**, always shown after grading -- especially when the answer is wrong) to `discuss_open`/`discuss_reply`. Options are dynamic (any count from 2 up to the enforced 10-option ceiling, not hard-coded to four) and display lettered A, B, C, ... in every surface (the live picker, the `/discuss` transcript, the tool-call card) -- single letters always suffice since the 10-option ceiling sits well under the 26-letter limit.

- A `"single"` quiz (the participant can only pick one) must have exactly one correct option; a `"multi"` quiz may have several, graded correct iff the reply's `selected` set exactly matches the correct set -- no partial credit.
- The correct answer is never exposed before submission: `discuss_open`'s own response, and every `discuss_show`/`discuss_rounds` read of an unanswered quiz, carries only a `quiz: true` marker on that round -- never the answer. Server-side, it's held in dedicated hidden storage that Discuss's own general-purpose read queries structurally cannot select, not merely omitted at the API layer.
- Once answered, the round that carries `selected` also carries `quizResult: { correct, correctOptions, explanation }` -- the durable, permanent record of what was asked, what was picked, and whether it was right, so a later turn can adapt to demonstrated knowledge.
- Malformed quizzes are rejected: too few options (below the existing 2-option floor), a duplicate/unknown `correct_options` entry, more than one correct option under `"single"` mode, or `correct_options`/`explanation` given without the other.

```bash
# A four-option quiz with one correct answer.
papyrus discuss open --title "Geography check" --actor agent \
  --content "What is the capital of France?" \
  --options-json '["Paris","London","Berlin","Madrid"]' --options-mode single \
  --correct-options-json '["Paris"]' \
  --explanation "Paris has been the capital of France since 987 AD." --json

# A "select all that apply" quiz with more than one correct option.
papyrus discuss open --title "Primes check" --actor agent \
  --content "Which of these are prime numbers?" \
  --options-json '["2","3","4","9"]' --options-mode multi \
  --correct-options-json '["2","3"]' \
  --explanation "2 and 3 are prime; 4 and 9 are not." --json

# The participant answers like any other posed choice -- grading and the explanation come back in the same call.
papyrus discuss reply <discussion-id> --actor human --content "Paris" --selected-json '["Paris"]' --json
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
papyrus tasks cancel-subtree <id> --json
```

`cancel-subtree` cancels a Task and every Task in its containment (`contains`) subtree in one call -- for tearing down a whole materialized Playbook run at once instead of canceling each Task id by hand. A Task already `done`/`canceled` is skipped, not treated as an error.

Task edits mutate the existing Papyrus-owned Task identity and append an `updated` event; title, body, and labels can be revised without canceling the Task or creating a replacement. Lifecycle, relationships, gates, checklist metadata, scope, and focus remain intact. The same `update` action provides a narrowly guarded recovery for Tasks accidentally created terminal by a legacy default: `status=todo` requires an audit reason, cannot be combined with content edits, only applies when `created` is the sole lifecycle event, and appends `creation_recovered` rather than rewriting history.

### Focus-driven automatic continuation

Automatic continuation is a property of the singleton Task focus, not a per-Task automation flag. An active focus continues at Pi's public `agent_settled` boundary when Pi is idle and has no queued messages. `tasks pause` preserves the focused Task while stopping continuation; `tasks unpause` resumes it; `tasks clear-focus` removes it. Replacing focus selects an existing Task rather than creating or canceling one.

Continuation is single-flight and bounded to 20 automatic turns or 6 unchanged Task snapshots. Reaching either bound persists a paused focus and records the reason in append-only Task history. Human input resumes only these automatically paused focuses; an explicit user pause remains paused.

Checklist criteria are an item-to-proof map. Every new item requires one or more typed references to inspectable evidence; proof presence does not imply that the evidence passed an executable gate:

```ts
checklist: {
  "Write failing playbook-row tests": {
    proof: [
      { type: "file", target: "test/frontends.test.ts" },
      { type: "symbol", target: "test/frontends.test.ts#playbook row test" }
    ]
  }
}
```

Proof types are `file`, `symbol`, `code`, `test`, `command`, `artifact`, and `url`. Existing array checklists remain readable as legacy items with `proof: missing`; Papyrus does not invent evidence.

Papyrus also injects an Alef-style reconciliation block at `before_agent_start` while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **"Did we accomplish this task?"** and run review before marking it done. The injection disappears when every task is done or canceled.

After assembling each system-prompt addition, Papyrus emits a versioned `papyrus.context-injection.v1` observation on Pi's shared extension event bus. It contains only exact byte/character sizes, Rule count, a labeled token estimate, prompt share, sequence, and a SHA-256 payload fingerprint; Rule/Task text, prompts, project paths, and credentials are never included. Jittor can persist and assess these observations without Papyrus maintaining a second telemetry store.
