# PROVENANCE

`pi-dynamic-workflows-oc-style` is an independently maintained [Pi](https://pi.dev)
extension that was **originally derived from** `@quintinshaw/pi-dynamic-workflows`
(MIT) and has since been substantially extended. This file records the origin, the
initial derivation edits, and the relationship to upstream. The projects have
**diverged**: upstream is treated as a read-only idea source, not a merge source.

## Origin

- **Originally derived from:** https://github.com/QuintinShaw/pi-dynamic-workflows
  ([`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows), MIT)
- **Derivation point:** v2.6.0 (`622f6df`); aligned to upstream v2.7.0 (`b11fdbd`, a version-string-only release with no code changes vs 2.6.0)
- **Original author:** Michael Livs (`pi-dynamic-workflows`); upstream maintainer: QuintinShaw
- **License:** MIT, retained (see [LICENSE](./LICENSE))

## Initial derivation edits (historical)

These were the first seven edits made on top of upstream v2.7.0. The project has
since diverged far beyond this list — a harness-agnostic broker
(`harness_type`/`harness_config`), issue-delivery workflows, run-level worktree
isolation, and a catalog/lock-gated command surface — see the
[CHANGELOG](./CHANGELOG.md) and [docs/](./docs/) for current architecture.

| Edit   | Summary                                                                 |
|--------|-------------------------------------------------------------------------|
| EDIT 1 | 4096-item fan-out cap                                                   |
| EDIT 2 | 524,288-byte (512 KB) script-size cap + 30,000 ms `runInContext` timeout |
| EDIT 3 | `<task-notification>` / `<usage>` / `<recovery>` XML result delivery     |
| EDIT 4 | Built-in `code-review` workflow (scope → find → verify → sweep → synthesize) |
| EDIT 5 | per-subagent transcript logging (`ManagedRun.transcriptDir`)            |
| EDIT 6 | live progress panel polish + concurrency floor                          |
| EDIT 7 | per-subagent **context modes** — main-agent rules don't leak into subagents (default `focused`) + `/modes` command (see [docs/context-modes.md](./docs/context-modes.md)) |

## Relationship to upstream

The projects have diverged; a git merge or cherry-pick from upstream is neither
possible nor desirable. Upstream remains a general-purpose workflow engine, while
this project has been rebuilt around a different architecture. Upstream is kept
only as a **read-only idea source**:

```bash
# one-time
git remote add upstream https://github.com/QuintinShaw/pi-dynamic-workflows.git

# periodically (~quarterly): read the log, port CONCEPTS as issues — never diffs
git fetch upstream
git log --oneline main..upstream/main
```

- **Last reviewed:** 2026-07-02, upstream at v2.10.0. Outcome: one portable fix
  identified (share host ModelRegistry with workflow subagents, upstream #49) —
  tracked as [#98](https://github.com/gtnotacoder/pi-dynamic-workflows/issues/98);
  everything else already superseded by our own architecture.

## Install

Point Pi's agent settings at this checkout, build, and restart Pi:

```jsonc
// ~/.pi/agent/settings.json
{ "packages": [ "/path/to/this/repo" ] }
```

```bash
cd /path/to/this/repo
npm install && npm run build   # tsc -> dist/
# then restart pi
```

## Status

The full `npm test` gate (biome + build + unit) is green; see the
[README](./README.md#status--acknowledgements) for the current test count.
