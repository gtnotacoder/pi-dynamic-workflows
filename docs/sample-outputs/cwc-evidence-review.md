---
title: Context Window Controller
subtitle: Evidence review summary and implementation stance
company: netg
date: June 2026
version: v0.1 first pass
brand: netg
---

## Executive verdict

<div class="metric-row">
  <div class="metric-card"><div class="metric-value">15</div><div class="metric-label">Findings survived</div></div>
  <div class="metric-card"><div class="metric-value">0</div><div class="metric-label">Findings discarded</div></div>
  <div class="metric-card"><div class="metric-value">1</div><div class="metric-label">Blocking uncertainty</div></div>
</div>

<div class="callout-success"><strong>Bottom line:</strong> the CWC architecture is sound enough to implement.</div>

<div class="callout-warning"><strong>Guardrail:</strong> arrival demotion must own <code>persist → verify → replace</code>. Do not assume the runtime already retained byte-exact tool output.</div>

---

## What the findings validate

<div class="cols"><div>

### Cache economics

- Prefix caches are sensitive to the first changed token
- Tail appends are cheap
- Middle rewrites must be batched
- Anthropic cache fields make this measurable

</div><div>

### Data safety

- Manifest stores pointers, not payloads
- Hindsight recall is not byte-exact retrieval
- Sidecar remains prudent until handles are proven
- Summaries must replay byte-identically

</div></div>

<div class="callout"><strong>Design implication:</strong> reduce live prefix size early, but only through cache-safe surfaces.</div>

---

## The one unresolved premise

<div class="callout-warning"><strong>Unproven:</strong> every tool output is synchronously retained with a usable handle before arrival-plane rewriting.</div>

### Required implementation contract

1. Capture raw tool output
2. Retain raw payload to Hindsight or sidecar
3. Verify the handle resolves byte-exactly
4. Only then emit the envelope or stub
5. If any step fails, keep the raw output live

<pre><code>raw output → retain → verify → replace
            no verify → no replace</code></pre>

---

## Runtime risks to probe first

| Area | Risk | Required behavior |
| --- | --- | --- |
| Claude Code hooks | <code>updatedToolOutput</code> may be ignored for some tools/versions | Version-gate and fail closed |
| Tool failures | Failure path may not honor replacement | Test <code>PostToolUseFailure</code> behavior |
| Hindsight wrapper | Existing wrapper may only expose <code>retain</code>/<code>recall</code> | Add get-by-handle or sidecar |
| LiteLLM | Proxy layer does not own canonical history | Do not use as curation layer |

---

## What CWC should store

### Manifest: hot index only

- Span identity and session ownership
- Sequence position and span type
- Hindsight ref and optional blob hash
- Raw/live token counts
- State: live or demoted
- Frozen summary envelope
- Safety flags: pinned, load-bearing, recent, active edit
- Access/demotion metadata for tuning

<div class="callout-danger"><strong>Never store raw tool or file payloads in the manifest.</strong></div>

---

## The safe operating model

```mermaid
flowchart LR
    A[Tool output] --> B[Retain raw payload]
    B --> C[Verify handle]
    C --> D{Safe to demote?}
    D -->|No| E[Keep raw at tail]
    D -->|Yes| F[Emit frozen envelope]
    F --> G[Retrieve by handle if needed]
```

---

## Implementation stance

| Phase | Build | Ship rule |
| --- | --- | --- |
| 1 | Manifest + arrival plane | Fail closed to raw output |
| 2 | Batched curation plane | One thresholded cache break only |
| 3 | Retrieve / recall + tuning | Tune toward low, nonzero refetch rate |

<div class="callout"><strong>Start narrow:</strong> Phase 1 gives immediate token savings with minimal cache risk.</div>

---

## Safety rules that become tests

- No per-turn middle edits
- Stable zone is immutable except scheduled summary-anchor updates
- Recent-K, pinned, load-bearing, open-task, and active-edit spans are never demoted
- Demoted summaries are generated once and replayed byte-for-byte
- Missing handle or blob means no demotion
- Re-fetched content returns at the tail

---

## Next actions

<div class="metric-row">
  <div class="metric-card"><div class="metric-value">1</div><div class="metric-label">Probe hook matrix</div></div>
  <div class="metric-card"><div class="metric-value">2</div><div class="metric-label">Verify byte-exact retrieval</div></div>
  <div class="metric-card"><div class="metric-value">3</div><div class="metric-label">Implement Phase 1</div></div>
</div>

### Decision

Proceed with CWC, but treat arrival retention as CWC-owned until the target runtime proves otherwise.
