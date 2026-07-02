# Herdr integration — design notes & roadmap

> **Status:** Tier 0 (status reporter, `src/herdr-reporter.ts`) is **shipped** (#85).  
> Tier 1 (run-level worktree isolation + pane-spawn seam, `src/pane-spawn.ts`) is **shipped** (#93).  
> Tier 2 (bidirectional control) is **designed** — this document tracks the research, API surface, and integration spec.

> **Roadmap:** Tier 0 = status mirror (shipped) · Tier 1 = real herdr cells per run (shipped) · Tier 2 = bidirectional control (designed).

[herdr](https://herdr.dev) is a terminal workspace manager / TUI for AI coding
agents (workspaces → tabs → panes, with per-pane agent status). This repo
(`pi-dynamic-workflows-oc-style`) fans a task out across many Pi subagents with
git-worktree isolation and a conductor status model. The integration goal is to
make that fan-out **visible** in herdr's TUI — to use herdr as the
*orchestrator-visible layer* for our agent work on the dev VM.

---

## 1. Mental model: herdr is a status *sink*; our workflows are the *source*

herdr renders one cell per pane and a tri-state agent status (`idle` /
`working` / `blocked`). External processes push status in over the socket API.
We have two status sources at different granularities:

1. **In-process subagent fan-out** — `WorkflowManager` events
   (`agentStart`/`agentEnd`/`phase`/`tokenUsage`/`complete`/`error`/`paused`).
   Fine-grained, ephemeral, all inside **one** Pi pane. Already rendered into the
   below-editor panel by `task-panel.ts` (`renderPanel`).
2. **Conductor run lifecycle** — `conductor-types.ts` `ConductorStatusName`
   (`spawned → workflow-running → workflow-complete-pane-open →
   needs-finalize/finalizing → completed/failed/needs-human`) with
   `CONDUCTOR_STATUS_ICONS`, `CONDUCTOR_STATUS_LABELS`, and the
   `ACTIVE`/`ATTENTION`/`TERMINAL` sets. Coarse, durable, one logical run each.
   Each run carries `semanticStatus: ConductorRunStatus`.

> Note: there is currently **no real `tmux split-window`** in `src/`. The
> conductor is a status + finalization *model* layered on in-process runs (the
> "tmux pane created" line in `conductor-types.ts` describes the intended
> external harness). That makes herdr a clean target rather than a migration.

---

## 2. herdr socket-API reference (what we mapped)

Discovered via `herdr <subcommand> --help` and live probing on this VM. Kept here
because it's the contract everything below builds on.

### Runtime discovery (env vars set inside a herdr pane)

| Var | Example | Use |
|-----|---------|-----|
| `HERDR_PANE_ID` | `wH:p4` | the cell this process reports into; **presence = feature flag** |
| `HERDR_ENV` | `1` | "running inside herdr" marker |
| `HERDR_TAB_ID` | `wH:t4` | parent tab |
| `HERDR_WORKSPACE_ID` | `wH` | parent workspace |
| `HERDR_SOCKET_PATH` | `/home/gt/.config/herdr/herdr.sock` | server socket |

`herdr pane current` returns the pane JSON, including
`"agent":"pi"`, `"agent_status":"working"`, and the agent session source
`"herdr:pi"`. **herdr's own pi integration owns the `working`/`idle` state under
source `herdr:pi`** — our reporter must not fight it.

### Push verbs (writing status into a cell)

```
herdr pane report-agent <pane> --source <ns> --agent <label> \
    --state idle|working|blocked|unknown [--message TEXT] [--custom-status TEXT] \
    [--seq N] [--agent-session-id ID] [--agent-session-path PATH]

herdr pane report-metadata <pane> --source <ns> [--agent LABEL] \
    [--applies-to-source ID] [--title TEXT|--clear-title] \
    [--display-agent TEXT|--clear-display-agent] \
    [--custom-status TEXT|--clear-custom-status] \
    [--state-label STATUS=TEXT] [--clear-state-labels] [--seq N] [--ttl-ms N]

herdr pane release-agent <pane> --source <ns> --agent <label> [--seq N]
herdr notification show <title> [--body TEXT] [--sound none|done|request] [--position ...]
```

- `--source` namespaces reporters so multiple can coexist; `--seq` (monotonic)
  lets herdr drop stale frames; `--ttl-ms` auto-expires a frame (self-healing if
  the reporter dies). **Verified live:** `report-metadata --applies-to-source
  herdr:pi --custom-status "…"` sets the pane's `custom_status` while leaving
  `agent_status:"working"` untouched.

### Read-back / control / spawn (for Tier 1/2)

```
herdr agent list | get <target> | read <target> | wait <target> --status <s> [--timeout MS]
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down] -- <argv...>
herdr wait output <pane> --match <text> [--regex] [--timeout MS]
herdr wait agent-status <pane> --status <idle|working|blocked|done|unknown> [--timeout MS]
herdr pane read <pane> [--source visible|recent|recent-unwrapped] [--lines N]
herdr pane run <pane> <command>          # command text + Enter
herdr pane split <pane> --direction right|down [--cwd PATH] [--env K=V]
herdr tab create [--workspace ID] [--cwd PATH] [--label TEXT]
herdr worktree create [--workspace ID|--cwd PATH] [--branch NAME] [--base REF] [--path PATH] [--json]
herdr worktree list|open|remove ...
herdr workspace create|list|get|focus|rename|close ...
```

`herdr integration install pi` wires the native pi↔herdr status detection
(source `herdr:pi`). Other agents supported: claude, codex, copilot, opencode,
cursor, droid, kimi, etc.

---

## 3. Tier 0 — status mirror (SHIPPED)

`src/herdr-reporter.ts`, wired in `extensions/workflow.ts` `session_start`
(next to `installResultDelivery`). Idempotent across `/reload`.

- Subscribes to the same `WorkflowManager` events as `task-panel.ts` and pushes a
  one-line sidecar custom-status onto the host pane:
  `◆ research_topic Synthesize 12/40 · 3.2K tok`.
- Uses a **separate `--source pi-workflows` + `--applies-to-source herdr:pi`**, so
  it annotates pi's detected agent without touching its state machine.
- Throttled (≤1 push / 750 ms, only when the string changes), `--ttl-ms 20000`
  self-heal, monotonic `--seq`, fire-and-forget spawn (never throws).
- No-op unless `HERDR_PANE_ID` is set. Toggle precedence: the `herdrStatus`
  setting (`"auto"` default / `"off"`) → `PI_WORKFLOWS_HERDR=0` env → herdr presence.
- Background-run terminal transitions raise `herdr notification show`
  (`done` / `request` sound).
- Single knob for rendering: `appliesToSource` (`""` = pane-level only).

Verified end-to-end: a 4-agent qwen (`litellm-ny2/local-qwen27`) fan-out drove
the cell `0/4 → 4/4` then cleared, with the result delivered back to chat.

---

## 4. Tier 1 — conductor runs become real herdr cells (SHIPPED)

**Goal:** instead of one enriched pi cell, give each *conductor run* its own
herdr cell — attachable, focusable, with native agent detection. herdr's tab grid
becomes the fan-out dashboard, and `herdr worktree list` replaces ad-hoc worktree
bookkeeping.

**Shipped (#85): run-level worktree isolation** is wired at the `WorkflowManager` launch layer — `startInBackground`/`runSync` accept `isolation: { worktree: true }` (or `worktreeRequired: true`), creating a run-owned git worktree on `pi/wf/<runId>`, running the whole workflow there (never the primary checkout's working branch), and letting finalization deliver a PR from that worktree.

> Run worktrees live under `<repoRoot>/.pi/worktrees/<runId>`; gitignore `.pi/` (the convention) so a kept worktree doesn't show as untracked in the primary checkout. The worktree is KEPT on completed/failed/paused runs (outputs/edits preserved for inspection/PR/resume) and removed only on abort or explicit `deleteRun()`; finalization removes a delivered worktree.

**Shipped (#93): pane-spawn seam** (`src/pane-spawn.ts`) — the injectable herdr CLI boundary that owns ALL herdr CLI access for pane-spawning. Behind an opt-in `herdrPaneSpawn` setting (default `"off"`).

### 4.1 The `HerdrInvoker` interface

`src/pane-spawn.ts` exports `HerdrInvoker` — an injectable boundary so unit tests mock the invoker and never touch a live herdr server. Methods:

| Method | CLI equivalent | Purpose |
|--------|----------------|---------|
| `worktreeCreate({base, branch})` | `herdr worktree create --branch <b> --base <ref> --json` | Creates the herdr-managed worktree, returns `{cwd, branch}` |
| `agentStart({name, cwd, workspace?, tab?, split?}, argv)` | `herdr agent start <name> --cwd <cwd> [--workspace] [--tab] [--split] -- <argv…>` | Starts a new herdr agent pane |
| `reportAgent(pane, opts)` | `herdr pane report-agent <pane> …` | Pushes live state (`idle/working/blocked`) into the cell |
| `reportMetadata(pane, opts)` | `herdr pane report-metadata <pane> …` | Layers a one-line custom status |
| `releaseAgent(pane, opts)` | `herdr agent release <pane> …` | Marks the agent done |
| `paneClose(pane)` | `herdr pane close <pane>` | Closes the spawned pane |

The `createDefaultHerdrInvoker()` factory shells `herdr` via `spawn(...).unref()` — fire-and-forget, swallowing errors so a missing herdr binary never throws into the workflow runtime.

### 4.2 Run-level pane only (not per subagent)

In-process subagents are **not** separate terminals — one real `pi` process per run.
Tier 1 applies only at the *run* level (runs that already are/were meant to be tmux panes).
Subagent fan-out stays as the Tier-0 enriched single cell.

### 4.3 Workspace/tab/split nesting

`resolveNesting(env)` reads `HERDR_WORKSPACE_ID` and `HERDR_TAB_ID` from the caller's environment.
When present (inside herdr), it returns `{workspace, tab, split: 'down'}` — so the spawned agent
pane nests **under the caller pane** via `--split down`, never appearing as an orphaned top-level
agent. When env is empty (not inside herdr), it returns `{}` — no nesting applied.

### 4.4 `conductorToHerdrState` mapping

Pure function (`conductorToHerdrState(status: ConductorRunStatus)`) implements the
[§6 table](#6-canonical-status-mapping-conductor--herdr) exactly — mapping each
`ConductorStatusName` to the herdr cell `{state, customStatus, release?, closePane?, notify?}`.
Wired into `WorkflowManager.setSemanticStatus()` (the docs §4 fan-in point) so every
status transition pushes the correct herdr state.

### 4.5 Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `herdrPaneSpawn` | `'off' \| 'auto'` | `'off'` | Opt-in because a real pi per run multiplies VM memory. `'auto'` enables pane-spawn for isolated runs only when inside herdr (`HERDR_PANE_ID` present). See [§6](#6-canonical-status-mapping-conductor--herdr). |
| `herdrMaxPanes` | `number` | `4` | Concurrency cap — the VM memory ceiling so parallel isolated runs cannot exhaust RAM. `PaneSpawnCoordinator.acquire(runId)` returns a lease or `null` (cap enforced, no throw). |

### 4.6 Worktree ownership reconciliation

When `herdrPaneSpawn` is active, `herdr worktree create` (via the invoker) **replaces**
`src/worktree.ts` `createWorktree` — the herdr-managed `{cwd, branch}` is persisted onto
`managed.worktree` (with `repoRoot` derived from `base`). This is a **single source of truth**;
no double bookkeeping between `src/worktree.ts` and herdr.

### 4.7 Pane lifecycle

| Conductor status | Pane behavior |
|-----------------|---------------|
| `completed` | **Auto-closed** — `releaseAgent` + `paneClose` called |
| `workflow-complete-pane-open` | **Kept open** — `report-agent` state=`working`, custom-status=`◐ complete (pane open)` |
| `needs-finalize` | **Kept open** — `report-agent` state=`blocked`, custom-status=`! needs finalize`, notify=`request` |
| `finalizing` | **Kept open** — `report-agent` state=`working`, custom-status=`⟳ finalizing` |
| `failed` | Kept open — `report-agent` state=`blocked`, custom-status=`✗ failed`, notify=`request` |
| `needs-human` | Kept open — `report-agent` state=`blocked`, custom-status=`? needs human`, notify=`request` |

The `RunPaneHandle` returned from `createPaneHandle(invoker, paneId)` provides
`updateStatus(status)` (pushes via `conductorToHerdrState`) and `close()` (calls `paneClose`).

### 4.8 Follow-ups (out of scope)

- **Admin-portal `/ui_refine` acceptance item** — external to this repo; tracked separately in the PR.
- **cwd-bound tool factory** (`#93` cwd-bound factory leg) — preserving tool policy under isolation when `ExecOptions.tools` are dropped for isolated runs. Remains open.

---

## 5. Tier 2 — bidirectional control (DESIGNED)

Use herdr not just as a display but as a control plane:

- `herdr agent wait --status idle` / `herdr wait agent-status` — let the conductor
  block on a spawned pane reaching idle/done instead of polling.
- `checkpoint()` human-gates → `blocked` state + `herdr notification show --sound
  request`; the user answers by focusing the pane (`herdr agent focus`).
- `herdr pane read` / `herdr agent read` — scrape a pane's output for
  `stageCheck`/finalization heuristics.
- `herdr agent send` / `herdr pane run` — drive a spawned agent programmatically.
- Cross-run awareness: `@weshipwork/pi-herd` mirrors herdr transcripts read-only
  into Pi subagents, so a run can *see* its siblings.

---

## 6. Canonical status mapping (Conductor → herdr)

`CONDUCTOR_STATUS_ICONS[s] + CONDUCTOR_STATUS_LABELS[s]`, with
`ATTENTION_STATUSES → blocked + notify`, `TERMINAL → idle/release`.

| ConductorStatusName | herdr `--state` | custom-status / action |
|---|---|---|
| spawned | working | `• spawned` |
| workflow-running | working | `▶ <phase> n/m · <tok>` |
| workflow-complete-pane-open | working | `◐ complete (pane open)` |
| needs-finalize | **blocked** | `! needs finalize` + `notification show` |
| finalizing | working | `⟳ finalizing` |
| completed | idle | `✓ done`; `release-agent`; optional `pane close`; `--sound done` |
| failed | **blocked** | `✗ failed` + notification |
| needs-human | **blocked** | `? needs human` + `--sound request` |

---

## 7. Ecosystem / don't-reinvent

Four herdr extensions exist on pi.dev (`?name=herdr`):

- **`@ogulcancelik/pi-herdr`** — herdr-native workspace/tab/pane orchestration for
  pi, with output watches and agent-status waits. Wraps the socket API as pi
  tools; Tier 1/2 can depend on it instead of shelling the CLI.
- **`@weshipwork/pi-herdr`** — orchestrate herdr workspaces/tabs/panes from inside herdr.
- **`@weshipwork/pi-herd`** — read-only herdr transcript mirrors for Pi subagents.
- **`@tifan/pi-rename`** — generate session names + rename the current herdr tab
  (pairs with per-run labels).

We currently shell the `herdr` CLI directly (consistent with how the conductor
was meant to shell tmux). Either path is fine.

---

## 8. Forward look: herdr as the orchestrator-visible layer for multi-team work

**Yes — herdr is a sensible "orchestrator-visible" TUI.** Its hierarchy maps
cleanly onto agent-team hierarchies:

```
herdr:  workspace        →   tab            →   pane
team:   Team / project   →   Lead / task    →   Worker / agent
```

Reference: [`kneutral-org/multi-team-agentic-coding`](https://github.com/kneutral-org/multi-team-agentic-coding)
is a fuller system — depth-2 delegation **User → Orchestrator → Team Leads →
Members** (Planning / Engineering / Validation teams), each agent a Pi subprocess
with persistent sessions, domain-locked file permissions, and compounding
per-agent "mental model" expertise files. It already ships a `.claude/skills/drive`
tmux module (`fanout.py`, `poll.py`, `proc.py`, `session.py`, `modules/tmux.py`)
to spawn and drive agents in tmux.

**The opportunity:** that `drive` skill is raw tmux with no shared visibility.
herdr's push API (§2) is exactly the visibility plane it lacks. A future mapping:

- **Workspace per team** (Planning / Engineering / Validation), or per project.
- **Tab per lead / active task**; **pane per worker agent**.
- Each agent process reports its state via `report-agent --source <team:role>` so
  the Orchestrator (and the human) see one TUI grid of every team's live status,
  with `blocked` cells surfacing exactly where attention is needed.
- `herdr agent wait` / `herdr wait agent-status` give the Orchestrator a
  deterministic join across workers instead of bespoke tmux polling.
- Domain/role encoded in `--source` (e.g. `eng:backend-dev`) and pane labels.

**Our system is the simpler cousin** of that: one dev VM, herdr, tmux isolation,
git worktrees. Tier 0 already proves the visibility primitive end-to-end. Tiers
1–2 are the path from "status mirror" toward "herdr is the dashboard for every
agent on the VM" — and the same `report-agent`/`report-metadata` seam is what a
multi-team setup would reuse. Nothing here commits us to the full multi-team
system; it just keeps the door open and the API knowledge captured.

### Decision: home of the bridge

**Resolved — the bridge lives in this repo (`pi-dynamic-workflows`).** It is
tightly coupled to the `WorkflowManager` event stream and the conductor status
model; a standalone package would be pure indirection. It is exposed as a
first-class on/off option (the `herdrStatus` setting, default `"auto"`), so it
stays dormant outside herdr and can be disabled entirely. The "standalone herdr
bridge package" idea is **deferred** — only worth revisiting if the separate
`multi-team-agentic-coding` system later wants to import the same reporter; until
then, extracting it would add maintenance for no local benefit.

### Resolved questions (Tier 1)

- **Run/worktree ownership:** herdr-managed (`herdr worktree`) when pane-spawning; `src/worktree.ts` for plain isolation. Single source of truth — no double bookkeeping (§4.6).
- **Pane-per-run memory cost:** gated behind `herdrMaxPanes` (default 4) via `PaneSpawnCoordinator`. Opt-in via `herdrPaneSpawn` (default `'off'`).
- **Pane lifecycle:** auto-close on `completed`, kept open for `workflow-complete-pane-open`/`needs-finalize`/`finalizing` (§4.7).

### Open questions to revisit (Tier 2+)
