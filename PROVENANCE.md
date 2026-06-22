# PROVENANCE

This repository is a **vendored, patched fork** maintained by **gtnotacoder** for
internal reverse-engineering work on Claude Code's "Workflows" feature, ported to a
[Pi](https://pi.dev) extension/package.

## Upstream origin

- **Upstream:** https://github.com/QuintinShaw/pi-dynamic-workflows
- **npm package:** [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows) (MIT) — forked from **v2.6.0**, now tracking upstream **v2.7.0**
- **Edit-branch fork point:** commit `622f6df` (v2.6.0) — `feat: checkpoint workflows on provider usage limit instead of failing (#28)`
- **Upstream tip tracked:** commit `b11fdbd` (v2.7.0) — `chore(release): bump version to 2.7.0` (a version-string-only release; no code changes vs 2.6.0)
- **License:** MIT, retained from upstream (see [LICENSE](./LICENSE))

`main` is the functional branch — upstream v2.7.0 with **all of our EDITs (1–6)
merged in**, plus this PROVENANCE file and a simplified README. The edits were
developed on `edit1/fanout-cap-4096` and `edit2/script-size-timeout-cap` (forked
from v2.6.0 / `622f6df`, merged forward to v2.7.0 on 2026-06-21, conflict-free)
and then consolidated into `main`; those working branches were removed from the
public repo. The clean per-edit commits are also preserved as git format-patches
in the `gtnotacoder/re` workspace at `cc-pi/patches/` (for any future upstream
PRs). Upstream is re-merged into `main` periodically to stay current.

## Why a fork

We are **not contributing upstream**. We vendor this package, apply internal
"Claude-Code-fidelity" edits, and maintain a local modified copy for our own use.

Related analysis (in the `gtnotacoder/re` workspace, `cc-pi/` target):

- Reverse-engineering of Claude Code's `Workflow` tool: `cc-pi/findings/cc-workflows.md`
- Side-by-side comparison (our from-scratch port vs. this package vs. CC internals):
  `cc-pi/findings/comparison-pi-dynamic-workflows.md`
- Per-subagent logging mechanism + EDIT 5 fix spec: `cc-pi/findings/cc-subagent-logging.md`
- Token-free comparison harness + parity money chart: `cc-pi/findings/comparison-test-suite.md`

## Our edits (all merged into `main`)

| Edit   | Summary                                                                 |
|--------|-------------------------------------------------------------------------|
| EDIT 1 | 4096-item fan-out cap                                                   |
| EDIT 2 | 524,288-byte script size cap + 30,000 ms `runInContext` timeout          |
| EDIT 3 | `<task-notification>` XML delivery                                      |
| EDIT 4 | built-in `code-review` workflow matching CC 2.1.185 topology            |
| EDIT 5 | per-subagent transcript logging (`ManagedRun.transcriptDir`)            |
| EDIT 6 | live progress panel polish + Claude concurrency floor                    |
| EDIT 7 | per-subagent context modes — main-agent rules don't leak into subagents (default `focused`) + `/modes` command (see `docs/context-modes.md`) |

EDITs 2–6 were stacked on `edit2`; the full series is now in `main`. EDIT 7
(context modes) landed directly on `main` in `50fe3e9`.

## Install (our patched build)

Point Pi's agent settings at this checkout, rebuild, and restart Pi:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [ "/path/to/this/repo" ]
}
```

```bash
cd /path/to/this/repo
npx tsc            # rebuild dist/
# then restart pi
```

## Status

Patched-fork parity vs. Claude Code 2.1.185: **15/17** (matches CC best).
See `cc-pi/findings/comparison-test-suite.md` for the per-case money chart and
the two honest remaining gaps.
