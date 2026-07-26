# Papyrus native tool rendering

This adapter design separates the model result from interactive presentation.
Papyrus application DTOs remain independent of terminal components.

## Output channels

| Channel | Contract |
|---|---|
| Model `content` | Bounded semantic text containing identity, outcome, material facts or changes, completeness/truncation, and an actionable continuation. It contains no ANSI styling or decorative layout. |
| Renderer `details` | Versioned, discriminated, bounded, serializable presentation DTO persisted with the session. It contains no credentials, prompts, private service payloads, or unbounded collections. |
| Interactive result | `renderCall` and `renderResult` build themed, width-safe Components from arguments and details. Collapsed and expanded views do not change model content. |
| CLI JSON | Stable application DTO returned through the authenticated client. It is not parsed from model prose or terminal strings. |
| Human CLI | Dedicated presenter over the application DTO. |

Pi sends tool-result `content` to the model, persists `details`, and supplies both to
`renderResult`. If a renderer is absent or throws, Pi displays `content`. Therefore
model content must remain an independently useful fallback.

## Pi built-in rendering findings

| Built-in | Relevant pattern | Papyrus application |
|---|---|---|
| Read | Compact path header; syntax-aware bounded body; expanded output reveals more without changing the tool result | Show artifact identity in the call header; render authored body as Markdown only in expanded details |
| Write | Mutation-oriented header and concise success result | Create/capture operations show the created identity and status, not the complete request body |
| Edit | Call and result have distinct roles; structured detail enables a richer diff than fallback text | Transitions and updates render before/after state from typed details |
| Bash | Partial execution state, success/error shell, bounded output, and tail-oriented diagnostics | Long gates and histories show bounded rows, partial state, and explicit truncation |
| Ls | Compact bounded listing | Artifact lists default to a small row preview and reveal the bounded remainder when expanded |
| Grep | Query context plus result count and bounded matches | Query/list headers retain filters and counts; results use bounded typed rows |
| Find | Search intent in the call header, concise paths in results | Artifact query uses identity-first result rows and continuation metadata |

Papyrus uses Pi's default tool shell. Pi owns pending/success/error backgrounds.
`renderShell: "self"` is not needed for ordinary rows. Renderers reuse
`context.lastComponent` when a component can be updated safely.

## Visual grammar

### Call header

The call renderer shows:

1. themed domain/tool label;
2. action;
3. one primary identifier or bounded query phrase;
4. destructive or lifecycle intent where relevant.

Bodies, structured inputs, credentials, complete labels, and metadata are never
echoed in the header.

### Pending

Pending and partial results use Pi's pending shell and one short status line. Streaming
updates do not append an ever-growing transcript. They replace the previous component.

### Success

Use the active theme's success color and the glyph `✓` only for a completed mutation
or passed check. Read operations use neutral/muted colors rather than claiming success.

### Error

Execution failures are thrown. Pi supplies `isError` and `toolErrorBg`; the renderer
uses the error color for a bounded actionable message. A returned successful result
must never contain a pseudo-error string.

### Collapsed and expanded

Collapsed output answers: what happened, to which identity, and what should happen
next. Lists show at most five rows. Graph-shaped results show counts plus a bounded
preview. Expanded output may show the complete already-bounded details DTO, authored
Markdown, checklist/gate rows, or the bounded graph.

### Width and bounds

Renderers support 40, 80, and 120 columns. Every rendered line fits the supplied
width. Collections carry total, returned, and truncated/remaining metadata. Model
content and details have independent named bounds.

## Action matrix

### `tasks`

| Action | Model result | Collapsed interactive result | Expanded interactive result |
|---|---|---|---|
| `create` | created task id, status, title | `✓ Created` plus identity | labels, project/scope summary |
| `update` | id and changed state | `✓ Updated` plus identity | bounded changed fields |
| `list` | bounded identity rows and continuation | count plus first five rows | all returned rows and truncation |
| `show` | identity, status, requested body, completeness | identity/status/title | Markdown body, labels, metadata summary |
| `history` | bounded event rows and continuation | event count and latest event | returned timeline |
| `scope` | current scope label | scope label | scope mode/root/project metadata |
| `set_scope` | selected scope | `✓ Scope` | scope metadata |
| `assign_project` | task and project assignment outcome | `✓ Assigned` | prior/current scope metadata |
| `graph` | node/root/dependency/containment counts | graph summary | bounded relationship graph |
| `plan` | bounded ordered layers and invalid cycles | ready/blocked counts | bounded layer view and cycles |
| `active` | active task identity or none | active identity | task summary |
| `focused` | focused task and focus status or none | focused identity/status | task summary |
| `focus` | focused task identity | `✓ Focused` | task summary |
| `pause` | paused focus identity | `✓ Paused` | focus metadata |
| `unpause` | resumed focus identity | `✓ Resumed` | focus metadata |
| `clear_focus` | cleared or already empty | concise outcome | no extra body |
| `start` | task lifecycle outcome | `✓ Started` | lifecycle state |
| `submit` | review submission outcome | `✓ Submitted` | lifecycle state |
| `complete` | completed/rejected identity, gate/checklist summary, successor/blocked summary | outcome and proof counts | bounded gate/checklist rows, successor and blocked tasks |
| `reject` | rejection identity and reason presence | `✓ Rejected` | lifecycle summary; reason remains bounded |
| `retry` | retried identity | `✓ Retried` | lifecycle summary |
| `cancel` | canceled identity | `✓ Canceled` | lifecycle summary |
| `run_gates` | pass/fail counts and bounded outputs | gate totals | returned gate rows and truncation |
| `set_checklist` | updated task identity and criterion count | `✓ Checklist updated` | bounded criterion/proof counts |
| `depend` | task and dependency identity | `✓ Dependency added` | relation row |
| `contain` | parent and child identity | `✓ Child added` | relation row |

### `notes`

| Action | Model result | Collapsed interactive result | Expanded interactive result |
|---|---|---|---|
| `capture` | note id/status/title | `✓ Captured` | bounded labels/project metadata |
| `list` | bounded identity rows | count plus first five | all returned rows and continuation |
| `show` | identity plus requested body | identity/status/title | Markdown body and history summary |
| `consume` | note lifecycle outcome | `✓ Consumed` | lifecycle summary |
| `promote` | note and target identities | `✓ Promoted` | relation and lifecycle summary |
| `archive` | disposition outcome | `✓ Archived` | disposition/lifecycle summary |

### `docs`

| Action | Model result | Collapsed interactive result | Expanded interactive result |
|---|---|---|---|
| `create` | document identity | `✓ Created` | subtype and labels |
| `list` | bounded identity rows | count plus first five | all returned rows and continuation |
| `show` | identity plus requested body | identity/status/title | themed Markdown body and relations |
| `activate` | lifecycle outcome | `✓ Activated` | lifecycle summary |
| `archive` | lifecycle outcome | `✓ Archived` | lifecycle summary |
| `reopen` | lifecycle outcome | `✓ Reopened` | lifecycle summary |
| `link` | source/relation/target | `✓ Linked` | relation row |

### `rules`

| Action | Model result | Collapsed interactive result | Expanded interactive result |
|---|---|---|---|
| `create` | rule identity/severity | `✓ Created` | condition/action summary |
| `list` | bounded identity rows | count plus first five | all returned rows and continuation |
| `show` | identity plus requested body | identity/severity/status | Markdown body and policy metadata |
| `preview` | exact bounded injection preview | preview size/status | themed preview text |
| `enable` | lifecycle outcome | `✓ Enabled` | policy summary |
| `disable` | lifecycle outcome | `✓ Disabled` | policy summary |
| `gate` | gate relation outcome | `✓ Gated` | task/rule relation |

### `skills`

| Action | Model result | Collapsed interactive result | Expanded interactive result |
|---|---|---|---|
| `create` | skill identity | `✓ Created` | subtype/trigger summary |
| `create_template` | template identity and target kind | `✓ Template created` | requirements/default summary |
| `list` | bounded identity rows | count plus first five | all returned rows and continuation |
| `show` | identity plus requested body | identity/subtype/status | Markdown body and definition summary |
| `invoke` | bounded invocation material | invocation summary | themed invocation text |
| `run` | run id and created/root counts | `✓ Run created` | bounded created artifacts and execution layers |
| `enable` | lifecycle outcome | `✓ Enabled` | trigger summary |
| `disable` | lifecycle outcome | `✓ Disabled` | trigger summary |
| `instantiate` | created artifact identity | `✓ Instantiated` | template/source summary |

### Low-level graph tools

| Tool/action | Model result | Collapsed interactive result | Expanded interactive result |
|---|---|---|---|
| `papyrus_query` | bounded identity rows | count plus first five | all returned rows and continuation |
| `papyrus_graph link` | source/relation/target | `✓ Linked` | relation row |
| `papyrus_graph tree` | root and bounded graph counts | root/count summary | bounded relationship graph |
| `papyrus_graph history` | bounded event log rows | count plus recent events | full returned event rows |
| `papyrus_show` | identity, requested body, metadata/edge/gate completeness | identity/status/title | Markdown body, bounded metadata, graph footer, optional gate rows |

`papyrus_graph status` is refused for every kind with its own lifecycle (Doc/Rule/Skill/Playbook/Task/Note) -- use that kind's own domain tool instead.

## Graph eligibility

Only intrinsically graph-shaped results render as relationship diagrams:

- `tasks graph`;
- `tasks plan` when expanded;
- `papyrus_graph tree`;
- relationship sections of expanded `show` results.

Create, status, list, Note, Rule, Doc, and Skill outcomes remain content-oriented.
`/tasks` remains the full interactive pannable graph browser.

## Compatibility and fallback

Legacy session rows may have missing or ad-hoc details. Runtime validation converts
known shapes into the current presentation union. Unknown or malformed details return
no rich component and allow Pi to display concise content. The adapter never parses
human prose to reconstruct application state.
