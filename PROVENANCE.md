# PROVENANCE

This repository is a **vendored, patched fork** maintained by **gtnotacoder** for
internal reverse-engineering work on Claude Code's "Workflows" feature, ported to a
[Pi](https://pi.dev) extension/package.

## Upstream origin

- **Upstream:** https://github.com/QuintinShaw/pi-dynamic-workflows
- **npm package:** [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows) **v2.6.0** (MIT)
- **Upstream `main` at fork point:** commit `622f6df` — `feat: checkpoint workflows on provider usage limit instead of failing (#28)`
- **License:** MIT, retained from upstream (see [LICENSE](./LICENSE))

The `main` branch here mirrors upstream `main` plus one documentation commit (this
file + a README banner). Our actual code modifications live on the
`edit1/fanout-cap-4096` and `edit2/script-size-timeout-cap` branches.

## Why a fork

We are **not contributing upstream**. We vendor this package, apply internal
"Claude-Code-fidelity" edits, and maintain a local modified copy for our own use.

Related analysis (in the `gtnotacoder/re` workspace, `cc-pi/` target):

- Reverse-engineering of Claude Code's `Workflow` tool: `cc-pi/findings/cc-workflows.md`
- Side-by-side comparison (our from-scratch port vs. this package vs. CC internals):
  `cc-pi/findings/comparison-pi-dynamic-workflows.md`
- Per-subagent logging mechanism + EDIT 5 fix spec: `cc-pi/findings/cc-subagent-logging.md`
- Token-free comparison harness + parity money chart: `cc-pi/findings/comparison-test-suite.md`

## Our edits (stacked on upstream v2.6.0)

| Edit   | Branch                     | Summary                                                                 |
|--------|---------------------------|-------------------------------------------------------------------------|
| EDIT 1 | `edit1/fanout-cap-4096`   | 4096-item fan-out cap                                                   |
| EDIT 2 | `edit2/...`               | 524,288-byte script size cap + 30,000 ms `runInContext` timeout          |
| EDIT 3 | `edit2/...`               | `<task-notification>` XML delivery                                      |
| EDIT 4 | `edit2/...`               | built-in `code-review` workflow matching CC 2.1.185 topology            |
| EDIT 5 | `edit2/...`               | per-subagent transcript logging (`ManagedRun.transcriptDir`)            |
| EDIT 6 | `edit2/...`               | live progress panel polish + Claude concurrency floor                    |

All of EDITs 2–6 are stacked on `edit2/script-size-timeout-cap`.

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
