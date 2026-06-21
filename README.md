# pi-dynamic-workflows (gtnotacoder fork)

A vendored, patched fork of [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) (MIT) — Claude-Code-style dynamic workflows for [Pi](https://pi.dev).

**This is not the upstream package.** We vendor it, apply internal "Claude-Code-fidelity" patches, and maintain it for our own use. See **[PROVENANCE.md](./PROVENANCE.md)** for exactly what changed (EDITs 1–6), the fork point, and upstream-tracking history.

- **Upstream:** https://github.com/QuintinShaw/pi-dynamic-workflows
- **npm:** https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows
- **Based on:** v2.6.0 — now tracking upstream **v2.7.0**
- **License:** MIT, retained from upstream (see [LICENSE](./LICENSE))

## Install

Point Pi's agent settings at this checkout, build, and restart Pi:

```jsonc
// ~/.pi/agent/settings.json
{ "packages": [ "/path/to/this/repo" ] }
```

```bash
npx tsc        # build dist/
# then restart pi
```

## Status

Patched-fork parity vs. Claude Code 2.1.185: **15/17** (matches CC best). **764/764** unit tests pass. Details in [PROVENANCE.md](./PROVENANCE.md).