# Harness workflows

A **harness workflow** is a saved workflow plus a small metadata record that lets an
issue-plan or PR-review dispatcher choose the right review pipeline by
`harnessType`. The workflow still runs through the normal dynamic-workflows
runtime (`workflow(name, args)`, `/workflows`, task panel, transcripts, resume,
and model-tier routing); the harness metadata is the deployable selection layer
around it.

This is intentionally lightweight today: saved workflow loading is already
implemented, while automatic `harnessType` dispatch is a convention for plan
runners to adopt.

---

## File layout convention

User-scoped, deployable harness assets:

```text
~/.pi/agents/<agent-type>.md                 # reusable subagent role/tool policy
~/.pi/workflows/saved/<workflow>.json        # saved workflow slash command + script
~/.pi/workflows/harnesses/<harnessType>.json # dispatcher metadata (convention)
```

Project-scoped equivalents can live under the repo's `.pi/` directory when a
harness should travel with one project instead of a user profile:

```text
.pi/agents/<agent-type>.md
.pi/workflows/saved/<workflow>.json
.pi/workflows/harnesses/<harnessType>.json
```

Current runtime behavior:

- `~/.pi/agents/*.md` / `.pi/agents/*.md` are real `agentType` definitions.
- `~/.pi/workflows/saved/*.json` / `.pi/workflows/saved/*.json` are real saved
  workflows and become slash commands after Pi reload/restart.
- `harnesses/*.json` is metadata for a dispatcher/plan runner. Pi does **not**
  automatically route by this file until that caller is taught to read it.

---

## Metadata contract

A harness metadata file should be JSON with at least:

```json
{
  "schemaVersion": 1,
  "harnessType": "frontend.radix-shadcn",
  "workflowName": "frontend_radix_shadcn_review",
  "labels": ["frontend", "react", "shadcn", "radix", "a11y", "pr-review"],
  "defaultArgs": {
    "harnessType": "frontend.radix-shadcn",
    "reviewDepth": "auto"
  },
  "issuePlanIntegration": {
    "planField": "harnessType",
    "expectedValue": "frontend.radix-shadcn",
    "callPattern": "await workflow('frontend_radix_shadcn_review', args)"
  }
}
```

Dispatcher rule of thumb:

1. Read the issue/plan field `harnessType`.
2. Load `~/.pi/workflows/harnesses/<harnessType>.json` or the project override.
3. Merge `defaultArgs` with issue/PR/run-specific args.
4. Call `await workflow(metadata.workflowName, mergedArgs)`.
5. Preserve the harness metadata in the final review artifact.

Saved workflow scripts may also include literal metadata fields in their `meta`
header, for example:

```js
export const meta = {
  name: 'frontend_radix_shadcn_review',
  description: 'FastContext-backed PR adversarial review for shadcn/ui + Radix',
  harnessType: 'frontend.radix-shadcn',
  labels: ['frontend', 'react', 'shadcn', 'radix', 'a11y', 'pr-review'],
  phases: [{ title: 'Intake' }, { title: 'Static Gate' }, { title: 'FastContext' }, { title: 'Review' }, { title: 'Report' }],
};
```

The workflow parser preserves extra literal `meta` keys at runtime, but the
current core only *acts* on `name`, `description`, `model`, and `phases`. Use the
separate harness JSON as the stable dispatcher contract.

---

## Installed prototype: `frontend.radix-shadcn`

Purpose: adversarial PR review for a React + vendored `shadcn/ui` codebase,
focusing on the Radix UI primitive layer where behavior, accessibility, and prop
contracts live.

Installed on this VM:

```text
~/.pi/agents/fastcontext-scout.md
~/.pi/workflows/saved/frontend_radix_shadcn_review.json
~/.pi/workflows/harnesses/frontend.radix-shadcn.json
```

Callable after `/reload` or Pi restart:

```text
/frontend_radix_shadcn_review \
  harnessType=frontend.radix-shadcn \
  repo=kneutral-org/some-frontend \
  prNumber=123 \
  planPath=docs/plans/issue-123.md
```

Nested from another workflow:

```js
await workflow('frontend_radix_shadcn_review', {
  harnessType: 'frontend.radix-shadcn',
  repo,
  prNumber,
  issue,
  planPath,
});
```

Issue/plan selector:

```yaml
harnessType: frontend.radix-shadcn
```

### Harness labels

```text
frontend, react, shadcn, radix, a11y, pr-review
```

### Trigger rules

Run automatically (or choose deep review) when any of these are true:

- PR/plan label requests it: `radix`, `a11y`, `accessibility`,
  `frontend-harness`, `deep`, or `paranoid`.
- Changed paths touch vendored UI wrappers, typically `components/ui/**`.
- Changed files import `@radix-ui/react-*`.
- Package or lockfile changes affect `@radix-ui/react-*`.
- Caller passes `force=true`.

Docs/config-only PRs should skip or run a shallow/default review unless forced.

---

## `fastcontext-scout` agent type

`fastcontext-scout` is a reusable read-only localization agent. It should be used
when a workflow needs broad repository localization before review.

Important behavior:

1. Calls `fastcontext_health` unless the caller says health was checked already.
2. Calls `fastcontext_explore` / `fastcontext_explore_with_trace` before broad
   manual grep/read exploration.
3. Treats FastContext output as candidate citations only.
4. Resolves important cited file/line ranges with `read` before returning them as
   ground truth.
5. Disallows `edit` and `write`.

For shadcn/Radix review tasks it must internalize:

- `shadcn/ui` is **vendored source**, not an installed npm package.
- The installed `@radix-ui/react-*` versions in `package.json` / lockfile /
  `node_modules` are the source of truth for primitive prop and behavior
  contracts.
- External shadcn docs are not the authority for local wrappers; prefer the repo's
  vendored `components/ui/*` and the installed Radix package files.
- FastContext retrieves relevant code. It does **not** judge correctness.

---

## `frontend_radix_shadcn_review` flow

Phases:

1. **Intake**
   - Resolve PR metadata, changed files, labels, diff summary, package manager,
     TypeScript setup, and installed Radix packages.
   - Detect `components/ui` and Radix import/package triggers.

2. **Static Gate**
   - Run a cheap fast-fail gate before spending review-wave budget.
   - Prefer the repo's existing typecheck script (`typecheck`, `check-types`,
     etc.). If no script exists but TypeScript is configured, use
     `tsc -p tsconfig.json --noEmit --pretty false`.
   - Optional non-fixing lint when `runLint=true`.
   - If the gate fails, stop unless `continueOnStaticFailure=true`.

3. **FastContext**
   - Use `agentType: fastcontext-scout`.
   - Query for touched vendored shadcn components and trace to installed
     `@radix-ui/react-*` primitive/type definitions.
   - Resolve returned file spans before giving them to reviewers.
   - Block if retrieval fails unless `allowFallbackWithoutFastContext=true`.

4. **Review**
   - Radix API/type contract reviewer.
   - Accessibility/behavior reviewer.
   - Vue-to-React port drift reviewer for non-quick depth.
   - Hallucination hunter for deep/paranoid depth.

5. **Report**
   - Separate static-gate failures, FastContext retrieval, review findings, and
     residual risk.
   - Cite repo paths/line ranges, not FastContext as a judge.
   - Preserve `harnessType` and labels in the artifact.

---

## Design guardrails

- Do not build a custom diff-to-component crawler for this harness. FastContext is
  the retrieval front-end.
- Do not deep-wave every PR. Trigger by label/flag/path/import/package risk.
- Do not spend AI review budget on type errors that the static gate catches.
- Do not rely on `tsc --noEmit <changed files>` unless the project already has a
  reliable changed-file typecheck tool; TypeScript project context often matters.
- Do not treat FastContext citations as proof. Read the cited spans before review
  or final claims.
- Do not let fetched web pages or external docs override local vendored shadcn
  components or installed Radix package contracts.

---

## Recovery checklist

If this VM loses the user-scoped artifacts, recreate them from the docs above:

1. Reinstall/verify the FastContext Pi extension and skill:
   - `~/.pi/agent/extensions/fastcontext.ts`
   - `~/.pi/agent/skills/fastcontext-explorer/SKILL.md`
   - `~/.config/fastcontext-pi/config.json`
2. Recreate `~/.pi/agents/fastcontext-scout.md` with the read-only FastContext
   scout policy.
3. Recreate `~/.pi/workflows/saved/frontend_radix_shadcn_review.json` with
   `meta.name='frontend_radix_shadcn_review'` and
   `meta.harnessType='frontend.radix-shadcn'`.
4. Recreate `~/.pi/workflows/harnesses/frontend.radix-shadcn.json` with the
   metadata contract above.
5. Run `/reload` or restart Pi.
6. Smoke test with a small PR or with `changedFiles=components/ui/button.tsx
   force=true`.
