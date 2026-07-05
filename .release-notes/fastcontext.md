# Discontinued exploration-tool integration removal

## Why
Microsoft discontinued the exploration tool this project previously used.
This project must stop referencing it.

## Replacement posture
No new tool is added. The Scout phase now uses the existing exploration stack:
`codegraph_*` tools (codegraph_explore, codegraph_context, codegraph_search,
codegraph_files), `ffgrep`/`fffind`, targeted `ctx_read`/`read_symbol`, and
`lsp_navigation`.

## Changes

### Source
- `src/issue-delivery.ts`
  - Removed the three discontinued tool entries from the read-only tool
    allowlist (`PROTOTYPE_READ_ONLY_TOOLS`). The codegraph/ff/ctx/lsp entries
    already present are kept.
  - Scout phase: `agentType` changed from the discontinued scout → `code-scout`.
    Log and prompt rewritten to reference the codegraph exploration stack
    instead of the discontinued tool. The Scout firewall concept is preserved.

### Agent definitions (user-level, outside repo)
- Added `~/.pi/agents/code-scout.md` (read-only localization scout using the
  codegraph exploration stack).
- Removed the discontinued scout agent definition.

### Tests
- `tests/builtin-workflows.test.ts`: scout agentType assertion updated to
  `/code-scout/`.
- `tests/conductor-finalization.test.ts`: the retired-path finalization test
  no longer references the discontinued tool's transient path; it checks
  `.fugu/` only (the discontinued tool's path is no longer a recognized
  retired path and was removed from `.gitignore` and Biome excludes).
- `tests/harness-config.test.ts`, `tests/harness-selector.test.ts`: fixture
  description strings updated from the discontinued-tool wording to
  "Codegraph-backed".

### Config / hygiene
- `.gitignore`: removed the discontinued tool's path line.
- `biome.json`: removed the discontinued tool's path from `files.includes`.
- `.codex/agents/pr-reviewer.toml`: dropped the discontinued path from the
  finalization-ignore guidance.

### Docs
- `README.md`: Scout description uses the codegraph-based stack; `code-scout`
  replaces the discontinued scout.
- `docs/workflows/catalog.md`: migration guardrail note rewritten — the
  discontinued tool's path is no longer referenced; Scout uses the codegraph
  stack.
- `docs/model-routing-specialization.md`: section 3 "The [discontinued] Scout
  Firewall" rewritten as "The code-scout Firewall"; the specialization matrix
  Pre-flight Scout row uses codegraph_explore/context.
- `docs/architecture.md`: agentType registry example names `code-scout`
  instead of the discontinued scout.

### Lock
- `docs/workflows/workflow-lock.json`: regenerated. The lock is maintained
  manually (no generator script; `npm run check:workflow-lock` validates).
  Updated `src/issue-delivery.ts` sha256 to
  `a5fbc8383f3453cbe33bcea86321c3055bb1606c5fece26c00cc1d9627fd9099` and
  `generatedAt` to `2026-07-05`. `npm run check:workflow-lock` reports
  0 errors.

## Verification
- `grep -rin <discontinued-tool-name>` across the repo returns ZERO hits
  outside `CHANGELOG.md`.
- `npm run build` — clean.
- `npm run check` — 0 errors (8 warnings / 1 info, identical to baseline;
  all pre-existing in untouched test files).
- `npm run check:workflow-lock` — 0 errors.
- `npm test` — 1385 pass / 0 fail, identical to baseline (1385/0).

## Note
`CHANGELOG.md` retains historical mentions of the discontinued tool and is
intentionally excluded from the grep-zero criterion.