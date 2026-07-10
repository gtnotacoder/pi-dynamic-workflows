# `/foundation_ui_compliance` — universal design-system compliance engine

A generic, reusable delivery loop for any app that builds against a **vendored
design-system foundation**: Gate-Diagnose → scoped Fix ↔ Re-gate → frontier
visual verify → Deliver (opt-in) → Trace-assert.

The engine contains **no repository names, URLs, or organization-specific
values**. Everything specific to your app or your design-system repo arrives
as `args` (typed directly in the command JSON or supplied as defaults by a
project/user saved-workflow override). You can point it at any foundation repo
that implements the gate contract below.

Template: [`templates/foundation_ui_compliance.workflow.mjs`](templates/foundation_ui_compliance.workflow.mjs)

## Availability and quick start

Starting in `pi-dynamic-workflows-oc-style` **0.2.3**, the template ships in
npm and is registered automatically as the bundled saved-workflow command
`/foundation_ui_compliance`. No separate copy/install step is required; reload
Pi after upgrading the package. A project-scoped or user saved-workflow
definition with the same name intentionally overrides the package default.

Before running it, the app repo must contain a vendored foundation directory
with:

- `scripts/run-foundation-gates.mjs`, implementing the contract below;
- `docs/compliance-validator.md` and `docs/proportion-contract.md`, which the
  diagnose/fix agents consult;
- any additional canon documents referenced by those files; and
- app build/serve instructions that an agent can follow when `urls` are used.

Pass one JSON object directly after the slash command (do not wrap it in shell
quotes inside Pi):

```text
/foundation_ui_compliance {"appSrc":"web/src","foundation":"third_party/frontend-foundation","buildCmd":"pnpm --dir web build","urls":["http://localhost:4173/dashboard"],"editAllow":["web/src/**"],"maxRounds":2,"deliver":false}
```

Use `urls: []` when only static/build gates are available. With URLs, make the
app reachable at those addresses or provide accurate build/serve instructions
in the app README. Start with `deliver: false`; `deliver: true` authorizes the
workflow to commit, push, and open/update a PR only after a successful re-gate.
If the final re-gate remains red, delivery is blocked.

---

## The three-layer ownership model

| Layer | Owns | Lives where |
|---|---|---|
| **Rules** | What correct UI means: tokens, type ramp, density canon, component canon, proportion numbers | Your design-system ("foundation") repo, **vendored into each app** (e.g. `third_party/<foundation>/`), updated only via visible resync PRs |
| **Logic** | The loop shape: diagnose → scoped fix → gate every round → frontier judge → trace-assert | This engine (one template; orgs keep a pinned copy in their foundation repo as template of record) |
| **Params** | This app's source dir, build command, served URLs, edit scope, baseline ledger | Slash-command `args` or a project/user saved-workflow override — config only, never logic |

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
  "baseline": "foundation-baseline.json",       // optional committed legacy-violation ledger
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
2. **Install/upgrade `pi-dynamic-workflows-oc-style` to 0.2.3 or newer** and
   reload Pi. The package provides `/foundation_ui_compliance`; no saved JSON
   is required. If an older local copy exists, remove or update that override
   to use the current package template.
3. **Keep app-specific run settings in the app repo.** The simplest invocation
   is the JSON slash-command argument shown above. Teams that want reusable
   defaults may keep a project-scoped saved-workflow override for the app;
   never put credentials in the workflow or command args.
4. **Legacy trees:** run the foundation entrypoint directly once with
   `--write-baseline`, commit the generated ledger, then pass its path as the
   workflow's `baseline` argument so the gate ratchets instead of blocking.

## Operational rules and audit boundaries

- **Frontier judge** — gate-diagnose and visual verification explicitly request
  the `big` tier; the machine-local tier mapping chooses the concrete model.
- **Scoped fixers** — fix prompts and the final trace audit require changes to
  stay inside `editAllow`; the vendored foundation (`third_party/**`) is always
  denied. This is not a host filesystem sandbox, so inspect the resulting diff
  before accepting it.
- **Gates every round** — workflow control follows every fix round with a
  re-gate through the single entrypoint. Red gates block visual verification and
  delivery.
- **Trace-assert** — a final model auditor reviews the run transcripts and
  reports evidence. It is a best-effort audit, not cryptographic proof or a
  replacement for host-side branch protection and CI.

## Privacy / universality note

The engine and this doc are intentionally free of organization-specific
references. Your foundation repo's name, your app's internal URLs, and your
invocation defaults belong in a **project-scoped saved-workflow override** (or
other private app configuration). Nothing about using this engine requires
disclosing what it points at.
