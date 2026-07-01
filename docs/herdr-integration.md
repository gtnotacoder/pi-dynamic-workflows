# Herdr integration — design notes & roadmap

> **Status:** Tier 0 is **shipped** (`src/herdr-reporter.ts`). Tier 1 and Tier 2
> below are **designed, not built** — this document exists so the research and
> the herdr API surface we mapped aren't lost. It is the spec to build from when
> we decide to take the integration further.

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

## 4. Tier 1 — conductor runs become real herdr cells (FOUNDATION SHIPPED; pane spawn pending)

**Goal:** instead of one enriched pi cell, give each *conductor run* its own
herdr cell — attachable, focusable, with native agent detection. herdr's tab grid
becomes the fan-out dashboard, and `herdr worktree list` replaces ad-hoc worktree
bookkeeping.

**Shipped foundation (#85): run-level worktree isolation is wired at the `WorkflowManager` launch layer — `startInBackground`/`runSync` accept `isolation: { worktree: true }` (or the first-class `worktreeRequired: true`), which creates a run-owned git worktree on `pi/wf/<runId>`, runs the whole workflow there (never the primary checkout's working branch), and lets finalization deliver a PR from that worktree. This is the (a) worktree + (c) never-touch-primary + (d) PR-from-worktree leg.

> Run worktrees live under `<repoRoot>/.pi/worktrees/<runId>`; gitignore `.pi/` (the convention) so a kept worktree doesn't show as untracked in the primary checkout. The worktree is KEPT on completed/failed/paused runs (outputs/edits preserved for inspection/PR/resume) and removed only on abort or explicit `deleteRun()`; finalization removes a delivered worktree. `ExecOptions.tools` are dropped for an isolated run (they're primary-cwd-bound); a cwd-bound tool factory for custom tool policy under isolation is tracked in #93.

**Still pending (tracked follow-up, validated against the admin-portal worked example):** the (b) tmux/herdr **pane spawn** — `herdr agent start wf-<run> --cwd <worktree> -- pi …` so each run is a real, focusable herdr cell with live status — plus a memory/concurrency cap (spawning real `pi` per run multiplies VM memory) and harness-descriptor `worktreeRequired` auto-isolation. The spawn mechanism below is the spec for that follow-up.

**Mechanism (for the pane-spawn follow-up) — where the conductor would `spawn` a run:

```
herdr worktree create --branch wf/<run> --base <ref> --json   # herdr owns the worktree
herdr agent start wf-<run> --cwd <worktree> -- pi …           # or: tab create + pane split
# then map ConductorStatusName onto the cell (table in §6) via report-agent/report-metadata
herdr release-agent / pane close  on terminal
```

**Seams in this repo:**

- The conductor spawn point (where status `spawned` is set / `conductor-finalization.ts`).
- `workflow-manager.ts` `setSemanticStatus()` — the single fan-in point; also call the herdr mapper here.
- `conductor-types.ts` icons/labels/sets — already the right shape for the mapping.

**Why it's heavier:** in-process subagents are **not** separate terminals, so do
**not** make a herdr pane per subagent. Tier 1 applies only at the *run* level
(runs that already are/were meant to be tmux panes). Keep subagent fan-out as the
Tier-0 enriched single cell.

**Risks / decisions:**

- Pane lifecycle: auto-close on `completed`, or keep open for `workflow-complete-pane-open`/finalize? (Conductor taxonomy already distinguishes these.)
- Worktree ownership: herdr-managed (`herdr worktree`) vs our own `src/worktree.ts`. Pick one to avoid double bookkeeping.
- Spawning real `pi` per run multiplies memory on the VM (see lean-ctx/tsserver pressure history) — gate behind a concurrency cap.

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

### Open questions to revisit (Tier 1+)

- Should run/worktree ownership move to herdr (`herdr worktree`) or stay local?
- Pane-per-run memory cost on the VM — what concurrency cap is safe?
