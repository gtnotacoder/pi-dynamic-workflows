# `/foundation_ui_compliance` — foundation gate engine with verifiable run receipt

A generic, reusable delivery loop for any app that builds against a **vendored
design-system foundation**: Gate-Diagnose → scoped Fix ↔ Re-gate → frontier
visual verify → Deliver (opt-in) → Receipt.

The engine contains **no repository names, URLs, or organization-specific
values**. Everything specific to your app or your design-system repo arrives
as `args` (or a per-repo harness JSON that supplies them). You can point it at
any foundation repo that implements the gate contract below.

Template: [`templates/foundation_ui_compliance.workflow.mjs`](templates/foundation_ui_compliance.workflow.mjs)

---

## The three-layer ownership model

| Layer | Owns | Lives where |
|---|---|---|
| **Rules** | What correct UI means: tokens, type ramp, density canon, component canon, proportion numbers | Your design-system ("foundation") repo, **vendored into each app** (e.g. `third_party/<foundation>/`), updated only via visible resync PRs |
| **Logic** | The loop shape: diagnose → scoped fix → gate every round → frontier judge → run receipt | This engine (one template; orgs keep a pinned copy in their foundation repo as template of record) |
| **Params** | This app's source dir, build command, served URLs, edit scope, baseline ledger | Per-repo harness JSON / `args` — config only, never logic |

Why this split works: workflows never re-encode design rules, so when the
foundation changes (a new theme, new canon, a brand-new gate), every consumer
workflow picks it up with **zero workflow edits** — the app resyncs its
vendored foundation and the same single gate command now enforces the new
truth.

## The Foundation Gate Contract (what your foundation repo must implement)

The engine invokes exactly **one command** — a single gate entrypoint script
inside the app's vendored foundation:

```
node <foundation>/scripts/run-foundation-gates.mjs --app-src <dir> [options]
```

Required behavior:

| Aspect | Contract |
|---|---|
| **CLI** | `--app-src <dir>` (required); `--build-cmd "<cmd>"`; repeatable `--url <url>` (enables rendered/geometry gates + screenshots); `--baseline <ledger.json>`; `--write-baseline`; `--shot-dir <dir>`; `--json` |
| **Exit code** | `0` = all gates pass, `1` = any gate failed, `2` = usage error |
| **`--json` output** | `{ summary: { gates, failed }, results: [{ gate, pass, exitCode, ms, stdout, stderr }] }` |
| **Gate list ownership** | The foundation owns which gates run behind the entrypoint (static validators first, app build, expensive rendered probes last). Consumers never enumerate individual gate scripts. |
| **Baseline ratchet** | With `--baseline`, pre-existing violations recorded in the ledger are tolerated; any **new** violation fails. Rules never weaken; legacy trees can't regress; new trees run at a zero baseline. |

Anything satisfying this table works — the engine does not care what your
gates check, only that the entrypoint exists, exits honestly, and speaks the
JSON shape.

## `args` schema

```jsonc
{
  "appSrc": "web/src",                         // REQUIRED — app source tree, repo-relative
  "foundation": "third_party/frontend-foundation", // vendored foundation dir (default shown)
  "buildCmd": "pnpm --dir web build",          // optional build/typecheck gate
  "urls": ["http://localhost:4173/dashboard"], // optional; enables rendered gate + visual verify
  "loginUrl": "http://localhost:4173/login",   // optional auth pre-step for gated apps
  "editAllow": ["web/src/**"],                 // REQUIRED — fix-agent allow globs
  "editDeny": [],                              // extra deny globs; third_party/**, .github/**, vendor/** are ALWAYS denied
  "maxRounds": 2,                              // Fix ↔ Re-gate cap
  "deliver": false                             // true = commit + PR; false = leave for human review
}
```

## Setup (any org, any app)

1. **Vendor your foundation** into the app (e.g. `third_party/<foundation>/`),
   including its `scripts/run-foundation-gates.mjs` and rule docs. Treat the
   vendored copy as read-only inside the app; update it only via resync PRs.
2. **Install the engine** as a saved workflow from
   `templates/foundation_ui_compliance.workflow.mjs` (or copy it into the
   app's `.pi/workflows/`). Keep a pinned copy in your foundation repo —
   ideally syntax-gated by that repo's CI — as your template of record.
3. **(Optional) Write a per-repo harness JSON** carrying the default `args`
   for that app, so runs are one command with no retyping. Keep private
   values (internal URLs, repo names, credentials indirection) there — in
   your private repo — never in the engine.
4. **Legacy trees:** generate a ledger once with `--write-baseline`, commit
   it, and pass `--baseline` so the gate ratchets instead of blocking.

## Hard rules the engine follows

- **Frontier judge** — gate-diagnose and visual verification run on big/frontier-tier models, never cheap ones (set via `tier` on those agents).
- **Scoped fixers (prompt guidance, not runtime-enforced edit scope)** — fix agents are *instructed* to edit only `editAllow` paths and never the vendored foundation (`third_party/**` is always in `editDeny`). The pi-dynamic-workflows runtime has **no path-glob tool policy for `agent()`**, so edit scope is prompt-level guidance, not a runtime-enforced fence. Re-gating checks resulting UI compliance — it does **not** prove which paths were or were not edited. A denied-path edit that does not break the gate will not be caught by re-gating; add a gate that covers the denied path if you need that enforcement. Do not rely on this engine to block the edit.
- **Structured gates every round** — every fix round is followed by a re-gate through the single entrypoint; no self-certification. Diagnose and re-gate clear only on `{passed:true, findings:[]}`. Visual verification clears only on `{passed:true, defects:[]}`; null, malformed, failed, or contradictory verdicts block delivery.
- **Run receipt (not a trace-assert)** — the workflow runtime does **not** expose subagent transcripts or a trace API to scripts, so this engine does **not** claim a transcript-backed trace-assert. Instead the final `Receipt` phase emits a `RUN RECEIPT` from in-workflow state: exact rounds, gate state, whether visual verification ran and passed, delivery eligibility/result, actual tier routes, and the declared `editAllow`/`editDeny` guidance. The receipt records execution state; it does not prove path compliance. If you need a transcript audit, run the host's `/code-review` or `/adversarial-review` separately.

## Privacy / universality note

The engine and this doc are intentionally free of organization-specific
references. Your foundation repo's name, your app's internal URLs, and your
harness defaults belong in **your app repo's** harness JSON (which can be
private). Nothing about using this engine requires disclosing what it points
at.
