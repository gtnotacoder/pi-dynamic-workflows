# PROVENANCE

`pi-dynamic-workflows-oc-style` is an independently maintained [Pi](https://pi.dev)
extension that was **originally derived from** `@quintinshaw/pi-dynamic-workflows`
(MIT) and has since been substantially extended. This file records the origin, the
changes from upstream, and how upstream is tracked.

## Origin

- **Originally derived from:** https://github.com/QuintinShaw/pi-dynamic-workflows
  ([`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows), MIT)
- **Derivation point:** v2.6.0 (`622f6df`); aligned to upstream v2.7.0 (`b11fdbd`, a version-string-only release with no code changes vs 2.6.0)
- **Original author:** Michael Livs (`pi-dynamic-workflows`); upstream maintainer: QuintinShaw
- **License:** MIT, retained (see [LICENSE](./LICENSE))

`main` carries upstream v2.7.0 plus all of the changes below.

## Changes from upstream

| Edit   | Summary                                                                 |
|--------|-------------------------------------------------------------------------|
| EDIT 1 | 4096-item fan-out cap                                                   |
| EDIT 2 | 524,288-byte (512 KB) script-size cap + 30,000 ms `runInContext` timeout |
| EDIT 3 | `<task-notification>` / `<usage>` / `<recovery>` XML result delivery     |
| EDIT 4 | Built-in `code-review` workflow (scope → find → verify → sweep → synthesize) |
| EDIT 5 | per-subagent transcript logging (`ManagedRun.transcriptDir`)            |
| EDIT 6 | live progress panel polish + concurrency floor                          |
| EDIT 7 | per-subagent **context modes** — main-agent rules don't leak into subagents (default `focused`) + `/modes` command (see [docs/context-modes.md](./docs/context-modes.md)) |

## Tracking upstream

Upstream is tracked so its fixes can be pulled in without this project being a
hard fork. To check for and pull upstream changes:

```bash
# one-time
git remote add upstream https://github.com/QuintinShaw/pi-dynamic-workflows.git

# periodically
git fetch upstream
git log --oneline main..upstream/main      # what's new upstream
git diff main upstream/main -- src/         # review the delta
# then cherry-pick / merge the commits you want, resolving against our edits, e.g.
git cherry-pick <sha>
npm test                                    # biome + tsc + unit gate must stay green
```

Re-check upstream periodically (e.g. on each upstream release).

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

825/825 unit tests pass; the full `npm test` gate (biome + build + unit) is green.
