# Provider-behavior benchmarks (caching, throughput, context)

> **Status:** Reference — reusable benchmark fixture; describes current shipped behavior.

A reusable workflow fixture for measuring **provider behavior** — prompt caching,
fan-out vs sequential reuse, and context handling — across pinned models, using the
harness's own telemetry (persisted run state + Langfuse traces). It is deliberately
generic so it can grow to cover other behaviors (throughput, JSON-mode, context-window
pressure, compaction) without new plumbing.

The canonical test fixture is `harness_cache_benchmark`. It is **not bundled as a shipped
slash command**; install it manually as a machine-local saved workflow before invoking it.
The script is version-controlled below so the test is reproducible across machines.

## What it measures

It reuses a large, **byte-identical stable prefix** across calls. The first ("prime")
call establishes the cache; the following ("reuse") calls should read it on
cache-capable providers. From the per-call usage we derive the cache-read fraction:

```
cache-read fraction = cacheRead / (input + cacheRead)
```

(Not `cacheRead / input` — that can exceed 100% because providers report cached prompt
tokens separately from fresh input.)

## Cache-equivalence constraint (and how it relates to context modes)

Provider caching keys on the **full prefix**, which is:

```
[ system prompt: the four context-mode channels ] + [ stable reference block ] + [ variable tail ]
```

The system prompt is governed entirely by the [context mode](./context-modes.md) of the
agent (base prompt, `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, skills). Therefore:

> **Cache reuse is only valid within `(model + resolved contextMode + identical stable-prefix)`.**

Practical consequences:

- `prime` and `reuse` calls must share the **same model** and the **same resolved
  contextMode**, or their prefixes differ and nothing hits.
- The default mode `focused` blocks the volatile main-agent append channel, which makes
  subagent prefixes smaller and more stable — i.e. *more* cacheable. Fan-out agents that
  all run `focused` on the same model naturally share a cache.
- A wave that deliberately mixes modes (e.g. `scoped` reviewers + `focused` workers) will
  not share a cache across the groups, and should not — different personas are different
  prefixes by design.

This benchmark does not change context-mode resolution; it only *consumes* the resolved
mode as part of the cache-equivalence key.

## Parameters

| Param | Default | Meaning |
|---|---|---|
| `models` | `openai-codex/gpt-5.5,meridian/claude-opus-4-8:high` | Comma-separated `provider/modelId` specs to compare. |
| `repeats` | `3` | Reuse calls per model after the prime (1–10). |
| `contextBlocks` | `140` | Size of the stable reference prefix (20–4000; 140 ≈ a few thousand tokens). |
| `readMode` | `sequential` | `sequential`, or `parallel` (prime once, then fan out readers). Use `sequential` for strict per-agent row inspection; see the parallel caveat below. |
| `tag` | `default` | Baked into the prefix. Separate runs sharing the same `tag` share a provider cache. |

Install and run it locally:

1. Copy the canonical script below into `~/.pi/workflows/saved/harness_cache_benchmark.json`
   using the saved-workflow JSON shape supported by `WorkflowStorage` (for example,
   `{ "name": "harness_cache_benchmark", "description": "Provider cache benchmark", "script": "..." }`).
2. Restart/reload Pi so startup registration discovers the copied saved workflow file.
3. Run the saved slash command with params:

```text
/harness_cache_benchmark models=openai-codex/gpt-5.5,meridian/claude-opus-4-8:high repeats=3 readMode=parallel tag=ttl-10m
```

If the JSON file is not installed locally and the session has not been restarted after
copying it, `/harness_cache_benchmark` is not a guaranteed repo-shipped command.

## TTL probe (effective bridge cache lifetime)

The workflow VM has no timer (determinism realm), so the cache TTL is probed across
**separate runs** rather than with an in-script sleep:

1. Run with a fixed `tag`.
2. Wait N minutes.
3. Run again with the **same** `tag`.
4. If the second run's **prime** call shows `cacheRead > 0`, the prefix was still warm →
   effective TTL ≥ N. If it is cold (cacheWrite, no read), TTL < N.

Bracket the gap (e.g. 2 min, 10 min, 30 min) to estimate the effective cache lifetime of
the currently configured provider bridge. This fixture does **not** set Anthropic's
extended-cache headers; it cannot prove the 1-hour extended TTL unless the runtime/bridge
adds an explicit extended-cache option and the fixture is updated to enable it.

## How to read the results

Every run flows through the WorkflowManager, so all of these capture it automatically:

- **Persisted run state:** `~/.pi/workflows/projects/<project-key>/runs/<runId>.json`
  (per-agent `usage` incl. `cacheRead`/`cacheWrite`).
- **Deterministic report:** `/workflow-telemetry-report runId=<runId>` — per-model
  cache-read fraction, anomalies, trace links.
- **LLM analysis:** `/workflow_trace_analyzer runId=<runId>` — Spark `trace-analyst`
  narrative + checklist.
- **Langfuse:** trace id is `stableHex("trace:workflow:<runId>")`; each subagent is a
  generation carrying `usageDetails` with `cache_read`/`cache_write`.

## Measured findings (2026-06-30, GPT-5.5 codex vs Opus 4.8 Meridian)

Across three runs (default tag, sequential, 1 prime + 3 reuse, ~27k-token prefix):

| Model | Reuse cache-read | Stability |
|---|---|---|
| `meridian/claude-opus-4-8:high` | **100%** (`cacheRead`≈20.5k–39.3k/call, `input`=2) | Reliable on every reuse, every run. |
| `openai-codex/gpt-5.5` | **0%** typical; **62%** on 1 of 12 reuse calls | Sporadic — automatic prefix caching is best-effort across discrete calls. |

Cross-run (shared prefix):

- **2.5-min gap:** the later run's *prime* call read cache (`cacheRead`≈39,276) → prefix
  still warm across separate runs.
- **67-min gap:** prime was cold (fresh `cacheWrite`) → expired.
- ⇒ Cross-run caching is confirmed; the observed bridge/provider cache lifetime is bracketed
  between 2.5 min (warm) and 67 min (cold). A ~10–30-min spaced re-run can narrow that
  effective-lifetime bracket, but it does not prove Anthropic extended-cache mode was
  requested or honored.

Takeaways for routing:

- **Anthropic/Opus via the current bridge** caches reliably across *discrete* calls in the
  observed setup → best for **fan-out with shared context**.
- **OpenAI/GPT-5.5 (automatic prefix cache)** is unreliable across discrete short calls but
  strong **within one long multi-turn agent** (≈81% in production) → best for **iterative**
  single agents.
- **Ollama Cloud** exposes no cache fields at all (see provider notes) — `$0` flat-rate, so
  a throughput concern only.

## Canonical script

```js
export const meta = {
  name: 'harness_cache_benchmark',
  description:
    'Provider-behavior benchmark: prompt caching (prime vs reuse), sequential vs prime-then-fan-out reuse, and context handling across pinned models via a large stable prefix.',
  phases: [{ title: 'Probe' }, { title: 'Summary' }],
};

const input = args || {};
const models = String(input.models || 'openai-codex/gpt-5.5,meridian/claude-opus-4-8:high')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const reps = Math.max(1, Math.min(10, Number(input.repeats || 3)));
const blocks = Math.max(20, Math.min(4000, Number(input.contextBlocks || 140)));
const readMode = String(input.readMode || 'sequential').toLowerCase() === 'parallel' ? 'parallel' : 'sequential';
const tag = String(input.tag || 'default').trim();

const PARA =
  'In a distributed multi-agent harness, deterministic journaling, resume-safe replay, model-tier routing, ' +
  'and prompt caching jointly determine token efficiency and latency. Stable prompt prefixes enable provider-side ' +
  'cache reuse, lowering effective input cost and time-to-first-token across repeated calls.';
let reference = '';
for (let i = 0; i < blocks; i++) reference += '[' + i + '] ' + PARA + '\n';

const SHARED =
  'You are a harness provider-behavior benchmark probe. Cache tag: ' + tag + '. ' +
  'The following reference material is a fixed, stable prefix that is identical on every call with this tag. ' +
  'Keep it in context and rely on it.\n' +
  '=== REFERENCE START ===\n' + reference + '=== REFERENCE END ===\n';

function ask(model, tail) {
  // Keep workflow phase and task label identical across prime/reuse calls: Pi prepends
  // both before the user prompt, so varying them would break the measured stable prefix.
  // In readMode=parallel, duplicate labels make per-agent task-panel rows ambiguous until
  // manager completion matching is call-id-based; use aggregate usage/Langfuse or sequential
  // mode when inspecting individual rows.
  return agent(SHARED + '\n' + tail, { model, label: 'cache probe :: ' + model });
}

for (const model of models) {
  phase('Probe');
  await ask(model, 'Task: In ONE short sentence, state the overall topic of the reference. Do not quote it.');

  phase('Probe');
  if (readMode === 'parallel') {
    const thunks = [];
    for (let r = 1; r <= reps; r++) {
      const n = r;
      thunks.push(() =>
        ask(model, 'Follow-up #' + n + ': In ONE short sentence, mention reference item [' + n + '] only.'),
      );
    }
    await parallel(thunks);
  } else {
    for (let r = 1; r <= reps; r++) {
      await ask(model, 'Follow-up #' + r + ': In ONE short sentence, mention reference item [' + r + '] only.');
    }
  }
}

phase('Summary');
return { models, repeats: reps, contextBlocks: blocks, readMode, tag, approxPrefixChars: SHARED.length };
```

## Extending to other behaviors

The same harness generalizes: swap the per-call prompt/measurement to probe
throughput (tok/s), JSON-mode compliance, context-window pressure, or compaction
behavior, and read the results through the same telemetry surfaces. Keep the
cache-equivalence constraint in mind whenever a probe relies on a shared prefix.
