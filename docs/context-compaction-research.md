# Context Compaction & State Redaction Research

## Introduction

This research note supports [GitHub issue #11](https://github.com/gtnotacoder/pi-dynamic-workflows/issues/11), which tracks context degradation in the Worker–Verifier loop. The issue observes that repeated Worker verification failures, when recorded as raw chronological logs appended verbatim to the prompt, produce three compounding pathologies:

- **Prompt bloat** — each failed attempt adds a full transcript of tool calls, outputs, and diagnostics, inflating the context window without proportional informational gain.
- **Context dilution** — the signal-to-noise ratio drops as successive failure records crowd out the original task spec, plan, and relevant source context, pushing the instructions that matter toward the edges of the model's attention.
- **Stale state leakage** — intermediate file states, abandoned approaches, and superseded assumptions persist in the log and bleed into subsequent turns, causing the Worker to re-introduce reverted edits, chase already-resolved errors, or contradict the Verifier's latest verdict.

Together these failures turn a convergent loop into a divergent one: later attempts become *less* likely to succeed than earlier ones, because the model is effectively reasoning over a palimpsest of its own mistakes rather than a clean, compacted representation of current state. The remainder of this document investigates compaction strategies and redaction rules that restore convergence.

## Architectural Design: Feedback Compactor

The **Feedback Compactor** is the component that breaks the divergence described above. It sits between the Verifier's verdict and the next Worker turn, transforming an accumulating chronological error log into a single, compact, forward-looking artifact: the **Correction Delta**. Its job is *not* to summarize history faithfully — it is to extract the smallest set of corrective instructions that, when prepended to the next Worker prompt, maximizes the probability of convergence.

The design below specifies goals/non-goals, inputs, the processing pipeline, the redaction policy, the output contract, the integration point in the Worker–Verifier retry loop, and the failure modes the Compactor must tolerate.

### Goals & Non-Goals

**Goals**

- Collapse N rounds of chronological failure logs into one `Correction Delta` of bounded size, regardless of how many attempts have run.
- Preserve *root-cause signal* — the distinct, still-open reasons an attempt failed — while discarding *episodic noise* (which tool returned which buffer, transient diagnostics, duplicate stack traces).
- Order retained signal by **current relevance**, not by when it was first observed: the most recent verdict and the freshest open error dominate; superseded findings sink to the bottom or are dropped.
- Redact stale and sensitive state so the Worker cannot re-introduce reverted edits, chase resolved errors, or act on credentials/PII that leaked into logs.
- Produce an output with a stable, machine-readable contract so the orchestrator can merge it into the next prompt deterministically and so a Verifier can check the Delta against fresh runs without parsing prose.

**Non-Goals**

- The Compactor is **not** a Verifier. It does not re-run tests, re-execute tools, or re-judge correctness. It only reshapes existing verdicts. Re-judgment is a separate Verifier responsibility; conflating the two is a category error that re-introduces divergence.
- The Compactor does **not** attempt to fix the code. It emits instructions and constraints, never patches.
- The Compactor does **not** guarantee faithful historical recall. It is explicitly lossy by design; completeness of the audit trail is sacrificed for prompt fitness. A separate, append-only `Audit Log` (out of the prompt path) retains the full chronological record for human review.
- The Compactor does **not** decide when the retry loop gives up. Loop termination / escalation is the orchestrator's call, driven by attempt count and Delta convergence metrics, not by Compactor output directly.
- The Compactor does **not** redact the original task spec or the current canonical file state; it only redacts the *failure log stream*. The task spec and canonical state are owned by the caller.

### Inputs

The Compactor consumes a structured `CompactionRequest`, not raw prompt text. Pulling structured input keeps the pipeline deterministic and keeps the redaction policy operating on typed fields rather than fragile regex over prose.

```
CompactionRequest {
  taskSpec:        TaskSpec            // immutable; the original step instructions
  canonicalState:  CanonicalState      // current authoritative file state (post last attempt)
  rounds:          Round[]             // chronological, oldest → newest; 1..N
}

Round {
  index:           int                 // 1-based attempt number
  workerTrace:     TraceEntry[]        // tool calls + truncated outputs from that attempt
  verifierVerdict: VerifierVerdict      // structured verdict for that attempt
  ts:              string              // monotonic timestamp
}

VerifierVerdict {
  status:          "pass" | "fail" | "blocked"
  findings:        Finding[]            // structured failures
  notes:           string               // free-form, already short
}

Finding {
  id:              string               // stable hash of (rule, location, message)
  severity:        "error" | "warning" | "info"
  rule:            string               // e.g. "lsp:unused-import", "test:assert-eq"
  location:        Location             // file + line range
  message:         string
  firstObservedIn: int                  // round index where this root cause first appeared
  lastObservedIn:  int                  // round index where it was last seen
  status:          "open" | "resolved" | "superseded"
}
```

Three input invariants are enforced at the boundary:

1. `rounds` is non-empty and chronologically ordered; an empty rounds array is a caller bug, not a Compactor concern.
2. `canonicalState` reflects the *post*-last-attempt filesystem; the Compactor never reads the working tree itself, avoiding a TOCTOU gap with the Verifier.
3. `Finding.firstObservedIn` / `lastObservedIn` / `status` are maintained by the Verifier across rounds, not reconstructed by the Compactor. The Compactor trusts these annotations and only rewrites them when redaction forces a drop (see Redaction Policy).

### Processing Pipeline

The pipeline is a fixed five-stage transform. Each stage is pure (given the same `CompactionRequest`, it yields the same output) so the whole Compactor is deterministic and unit-testable in isolation.

**Stage 1 — Normalize.** Convert every round's heterogeneous trace entries and verdict notes into the canonical `Finding` shape above. Chronological error logs arrive as a mix of LSP diagnostics, test runner output, build stderr, and prose verifier notes; normalization maps each to `{rule, location, message, severity}` and assigns a stable `id`. Entries that cannot be mapped to a location are tagged `location = null` and retained only if they carry an explicit rule; unmappable free-form chatter is dropped at this stage. Normalization is the only stage permitted to *discard* records, and it does so only for structurally unrecognizable ones — it never drops a real diagnostic.

**Stage 2 — Group by root cause.** Cluster normalized findings by `id` (equivalently by `(rule, location, message)`), then promote each cluster to a single `RootCause` record carrying the union of rounds it appeared in, its `firstObservedIn`/`lastObservedIn`, and its current `status`. This is where episodic noise collapses: five rounds of "unused import on line 12" become one root cause, not five. Clustering is exact-match on `id`; approximate/fuzzy grouping is explicitly avoided because false merges combine unrelated failures and false splits re-inflate the prompt — both break convergence, and exact-match keeps the behavior auditable.

**Stage 3 — Deduplicate & resolve.** For each `RootCause`, collapse to its latest `status`. If a finding's `lastObservedIn` < current round and its latest status is `resolved` or `superseded`, it is moved to a `resolvedHistory` bucket that is *not* emitted into the Delta by default (it goes to the Audit Log). If it is still `open`, it survives. Deduplication also strips repeated stack-trace bodies, keeping only the first occurrence's trace and replacing repeats with a back-reference (`"same as round k"`), so the trace is present once per root cause, not once per observation.

**Stage 4 — Order by current relevance.** Rank surviving open root causes by a relevance score, not by `firstObservedIn`:

```
relevance = w_recent   * recency(rounds, lastObservedIn)
          + w_severity * severityWeight(severity)
          + w_blocker  * isBlocking(verifierVerdict.status == "blocked")
          + w_fresh    * freshness(firstObservedIn == lastObservedIn)  // newly introduced this round
```

The most recent, highest-severity, blocking, and newly-introduced findings float to the top; stale, low-severity, non-blocking ones sink. Weights default to `w_recent ≫ w_fresh > w_severity > w_blocker` so that *what the last verdict actually cared about* dominates, and old noise does not crowd out new signal. Ordering is stable and total so the output is reproducible.

**Stage 5 — Condense into the Correction Delta.** Take the top-K ranked open root causes (K bounded by the output contract's token budget) and render them through a fixed template into the single `Correction Delta` (see Output Contract). Any root causes beyond the budget are truncated with a one-line `"K additional low-relevance findings omitted; see Audit Log #<id>"` marker, never silently dropped. The Delta is the *only* prompt-bound artifact the Compactor emits.

### Redaction Policy

Redaction is applied between Stage 4 and Stage 5, after relevance ordering but before rendering, so the Delta never carries stale or sensitive state. Redaction is a denylist-by-rule pass with an allowlist escape, not a free-form rewrite.

1. **Stale state redaction.** Any finding whose `status ∈ {resolved, superseded}` is redacted from the Delta even if it survived earlier stages, *unless* the Verifier explicitly flagged it `keepForContext = true` (the allowlist escape). The rationale: a resolved error, once in the prompt, tempts the Worker to "fix" it again. The redacted finding is moved to the Audit Log with a tombstone marker so the decision is auditable.
2. **Superseded edit redaction.** Findings referencing file/ranges that the `canonicalState` diff shows have since been overwritten are stripped of their *stale snippet* content; only the rule + location + a `"stale; superseded by canonicalState"` tag survives, and only if `keepForContext` is set. This prevents the Worker from copying a reverted code block back out of the log.
3. **Sensitive state redaction.** Secrets, credentials, tokens, PII, and absolute paths that leaked into `workerTrace` outputs or `Finding.message` are masked by a fixed redactor (secret-pattern matchers + path relativization against the repo root). Masked spans are replaced with `«redacted:secret»` / `«redacted:path»`; the surrounding finding is retained. Redaction is mandatory and cannot be disabled by the Verifier — sensitive data must never re-enter the prompt path, regardless of relevance.
4. **Stale-assumption redaction.** Verifier `notes` from earlier rounds that assert assumptions since contradicted by the latest verdict (e.g. "assume X is the cause" when round N's verdict names Y) are dropped wholesale; the latest verdict's notes are authoritative and replace them.
5. **No redaction of task spec or canonical state.** The policy never touches `taskSpec` or `canonicalState`; those are the caller's responsibility and must reach the Worker intact.

Every redaction records a tombstone `{from: findingId, rule, reason}` in the Audit Log so a human can reconstruct what was removed and why.

### Output Contract: the Correction Delta

The Compactor emits exactly one artifact into the prompt path: the `Correction Delta`. It has a fixed, machine-readable shape so the orchestrator can splice it in deterministically and a downstream Verifier can diff future findings against it.

```
CorrectionDelta {
  attempt:        int          // round this Delta prepares (lastRound + 1)
  lastVerdict:    "pass"|"fail"|"blocked"
  openRootCauses: OpenRootCause[]   // ordered by relevance, top-K
  resolvedSummary: string | null   // one line: "M prior findings resolved in rounds …"
  omitted:        { count: int, auditLogId: string } | null
  constraints:    string[]     // hard "do not" rules derived from redactions
  generatedAt:    string       // monotonic ts; not wall-clock dependent
}

OpenRootCause {
  rank:           int          // 1-based relevance rank
  rule:           string
  location:       Location | null
  severity:       "error"|"warning"|"info"
  firstSeen:      int          // round index
  lastSeen:       int          // round index
  message:        string       // redacted, trimmed to N chars
  trace:          string | null   // first occurrence's trace only; back-ref otherwise
  blocking:       bool
}
```

Contract guarantees:

- **Bounded size.** Total rendered Delta ≤ `MAX_DELTA_TOKENS` (default budget set by the orchestrator, e.g. ~512 tokens). Overshoot triggers truncation plus the `omitted` marker, never silent loss.
- **Stable under no-op.** If no findings changed since the last compaction, the Delta's `openRootCauses` are byte-identical (same ordering, same messages). This lets the orchestrator detect a *stalled* loop and escalate rather than spin.
- **No history beyond tombstones.** The Delta carries no full round transcripts; episodic detail lives only in the Audit Log.
- **Constraints are additive.** The `constraints` array is the redaction policy's voice: `"do not re-introduce the reverted block at src/foo.go:42-58"`, `"do not re-chase resolved finding <id>"`. The Worker is instructed to treat `constraints` as hard rules.

The orchestrator merges the Delta into the next Worker prompt as a single block, replacing any prior Delta (there is at most one Delta in the prompt at a time), positioned immediately after the immutable `taskSpec` and before any per-turn plan.

### Integration Point in the Worker–Verifier Retry Loop

The Compactor is invoked exactly once per loop iteration, at a single, well-defined point: **after the Verifier has produced a verdict for attempt N, and before the Worker is dispatched for attempt N+1.** It is never called mid-attempt and never fed into the Verifier itself.

```
loop:
  1. dispatch Worker(taskSpec, canonicalState, priorDelta?) → attempt N
  2. apply attempt N edits to working tree
  3. dispatch Verifier(taskSpec, canonicalState) → verdict N
  4. if verdict N == pass: exit (success)
  5. append Round{index:N, workerTrace, verdict:N} to Audit Log
  6. dispatch Compactor(taskSpec, canonicalState, rounds[1..N]) → CorrectionDelta for N+1
  7. if Delta is byte-identical to the prior Delta (stall): escalate / exit
  8. goto 1 with priorDelta = CorrectionDelta
```

Placement rules that make the loop convergent:

- **The Delta is the only failure-derived content in the Worker prompt.** Raw `workerTrace` and prior verdicts are *not* passed to the Worker; they live only in the Audit Log. This is the key anti-bloat rule: the prompt's failure-derived footprint is O(1) in the number of attempts (bounded by `MAX_DELTA_TOKENS`), not O(N).
- **The Compactor sees all rounds; the Worker sees only the latest Delta.** This asymmetry is intentional: the Compactor is the single component allowed to hold cumulative state, so that every other component (Worker, Verifier) remains stateless across attempts and easy to reason about.
- **Stall detection lives at the orchestrator, not the Compactor.** Because the Delta is stable under no-op, the orchestrator can cheaply detect `Delta_{N+1} == Delta_N` and decide to escalate rather than re-dispatch — this is the loop's termination signal and it is owned by the orchestrator, per the non-goals.
- **Canonical state is the source of truth, not the Delta.** The Delta is advisory/instructional; the Verifier always re-derives findings against `canonicalState`, never against the Delta. This prevents the Compactor from becoming a hidden Verifier and keeps the two roles decoupled.

### Failure Modes

The Compactor must fail safe and fail loud. Each mode below has an explicit mitigation; none are permitted to silently corrupt the Delta or, worse, emit an empty Delta that hides a real failure.

- **Empty rounds array.** Treated as a caller contract violation; the Compactor raises `INVALID_REQUEST` and emits nothing. The loop must not run with zero rounds.
- **Verifier verdict missing or malformed.** Stage 1 cannot normalize without a verdict; the Compactor raises `VERIFIER_VERDICT_MISSING` and the orchestrator skips compaction, re-dispatching the Verifier rather than the Worker. This prevents the Compactor from inventing findings to fill the gap.
- **Stable-ID collision (two distinct findings hash to the same `id`).** Stage 2 would wrongly merge unrelated root causes. Mitigation: `id` is derived from a collision-resistant hash of `(rule, location, message)` and collisions are treated as a fatal `ID_COLLISION` error logged to the Audit Log, not silently deduplicated. Exact-match clustering makes this detectable rather than probabilistically hidden.
- **Token-budget overrun on the Delta.** Stage 5 truncates to top-K and emits the `omitted` marker with the Audit Log id. This is graceful degradation, not a failure; the omitted findings are recoverable by a human.
- **Redactor misses a secret pattern.** Treated as a security incident: the redactor is denylist-based, so a novel secret pattern slipping through is a bug to fix in the redactor rules, not a Compactor-logic fault. Mitigation: a separate, cheap secret-scan pass runs on the rendered Delta before it is allowed into the prompt; a hit raises `SECRET_LEAK` and blocks the prompt merge.
- **Compactor itself times out / crashes.** The orchestrator catches the failure, logs it to the Audit Log, and falls back to passing the *previous* Delta unchanged (if one exists) or a minimal `"prior attempt failed; re-verify against canonicalState"` Delta. The loop does not halt on Compactor failure, but it does surface it so a human can investigate the degradation. A crash must never produce a *blank* failure section in the Worker prompt — the fallback Delta always carries at least the loop's structural invariant (attempt count + last verdict status).
- **Stall false-positive.** If the Delta is byte-stable but the loop is genuinely progressing (e.g. the Worker is making unrelated edits the Verifier doesn't flag), the orchestrator's stall detector could escalate prematurely. Mitigation: stall is declared only after `STALL_ROUNDS` (default 2) consecutive identical Deltas *and* no change to `canonicalState`, so true stalls (same findings, same files) are distinguished from benign no-op rounds.
- **Lossy compaction hides a real, rare finding.** Because the Compactor is intentionally lossy, a low-relevance finding dropped from the Delta could be the actual blocker on a later round. Mitigation: the Audit Log retains everything, and the `omitted` marker always points a human to the full record; for autonomous runs, the orchestrator can raise the `MAX_DELTA_TOKENS` budget or lower the truncation threshold on escalation.

In every failure mode, the invariant is: **the Audit Log is complete and append-only; the Delta is bounded and best-effort.** The two are decoupled so that prompt-path degradation never implies record-loss, and record-loss never implies prompt corruption.

## Proposed JSON Schema

The schema below is the machine-readable contract for the **compacted feedback log** — the artifact the Feedback Compactor emits into the prompt path. It is a strict superset of the `CorrectionDelta` shape from the Output Contract: it adds the envelope fields an orchestrator needs to validate, version, and splice the Delta deterministically (schema version, source window, compaction metadata, redactions, evidence references, confidence), while keeping the core `openRootCauses` / `resolvedFailures` / `correctionDelta` payload intact. The orchestrator should treat a log that fails this schema as `INVALID_REQUEST` (see Failure Modes) and refuse to merge it into the Worker prompt.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://kneutral.org/schemas/compacted-feedback-log.v1.json",
  "title": "Compacted Feedback Log",
  "description": "Bounded, machine-readable artifact emitted by the Feedback Compactor into the Worker–Verifier prompt path. Replaces raw chronological failure logs with a single Correction Delta plus the metadata an orchestrator needs to validate and splice it.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "sourceWindow",
    "compaction",
    "findings",
    "rootCauses",
    "resolvedFailures",
    "activeFailures",
    "redactions",
    "evidence",
    "confidence",
    "severity",
    "correctionDelta"
  ],
  "properties": {
    "schemaVersion": {
      "type": "string",
      "description": "Semver-style version of this schema. Orchestrators MUST reject versions they cannot parse; bump on any breaking change to this shape.",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "examples": ["1.0.0"]
    },
    "sourceWindow": {
      "type": "object",
      "additionalProperties": false,
      "description": "The slice of rounds this log was compacted from. Lets the orchestrator confirm the Delta covers the full history and detect a stale compaction.",
      "required": ["firstRound", "lastRound", "roundCount", "canonicalStateRef"],
      "properties": {
        "firstRound": { "type": "integer", "minimum": 1 },
        "lastRound": { "type": "integer", "minimum": 1 },
        "roundCount": { "type": "integer", "minimum": 1 },
        "canonicalStateRef": {
          "type": "string",
          "description": "Opaque ref (e.g. git tree SHA) to the post-last-attempt canonical state the Compactor compacted against. Used to detect a TOCTOU mismatch with the current working tree."
        }
      }
    },
    "compaction": {
      "type": "object",
      "additionalProperties": false,
      "description": "Compaction metadata: provenance, budget, and structural invariants the orchestrator can check cheaply.",
      "required": ["compactorId", "generatedAt", "budgetTokens", "renderedTokens", "stallCandidate"],
      "properties": {
        "compactorId": {
          "type": "string",
          "description": "Stable id of the Compactor build/config that produced this log, for reproducibility audits."
        },
        "generatedAt": {
          "type": "string",
          "description": "Monotonic timestamp (NOT wall-clock dependent). Format is opaque to the schema; orchestrators compare for equality, not ordering."
        },
        "budgetTokens": { "type": "integer", "minimum": 0 },
        "renderedTokens": { "type": "integer", "minimum": 0 },
        "stallCandidate": {
          "type": "boolean",
          "description": "True if this Delta is byte-stable with the prior one. The orchestrator applies STALL_ROUNDS before escalating; this flag is advisory."
        }
      }
    },
    "findings": {
      "type": "array",
      "description": "Normalized findings surviving Stage 1, before grouping. Retained for auditability; the prompt path uses rootCauses/activeFailures, not this flat list.",
      "items": { "$ref": "#/$defs/finding" }
    },
    "rootCauses": {
      "type": "array",
      "description": "Root-cause clusters from Stage 2 (grouped findings), each carrying firstSeen/lastSeen and current status. This is the deduplicated, per-cause view.",
      "items": { "$ref": "#/$defs/rootCause" }
    },
    "resolvedFailures": {
      "type": "array",
      "description": "Root causes whose latest status is resolved or superseded. Emitted for audit/replay but NOT rendered into the Correction Delta by default (redaction rule 1), unless keepForContext is set.",
      "items": { "$ref": "#/$defs/rootCause" }
    },
    "activeFailures": {
      "type": "array",
      "description": "Open root causes ordered by Stage-4 relevance score, top-K. This is the set the Correction Delta is rendered from.",
      "items": { "$ref": "#/$defs/openRootCause" }
    },
    "redactions": {
      "type": "array",
      "description": "Tombstones for every redaction applied between Stage 4 and Stage 5. Lets a human reconstruct what was removed and why without re-parsing raw logs.",
      "items": { "$ref": "#/$defs/redaction" }
    },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["refs"],
      "properties": {
        "refs": {
          "type": "array",
          "description": "Back-references into the append-only Audit Log for traces, full round transcripts, and dropped findings. The prompt path never carries the raw evidence; only these refs.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["findingId", "auditLogId", "kind"],
            "properties": {
              "findingId": { "type": "string" },
              "auditLogId": { "type": "string", "description": "Opaque id into the Audit Log; never dereferenced by the Worker." },
              "kind": {
                "type": "string",
                "enum": ["trace", "verdict", "round-transcript", "omitted-finding"]
              }
            }
          }
        }
      }
    },
    "confidence": {
      "type": "object",
      "additionalProperties": false,
      "description": "Per-failure confidence that the root-cause clustering and relevance ranking are correct. Lets the orchestrator weight Delta items and detect low-confidence compactions worth re-running.",
      "required": ["method", "perCause"],
      "properties": {
        "method": {
          "type": "string",
          "enum": ["exact-match", "heuristic"],
          "description": "exact-match = Stage 2 stable-id clustering; heuristic = any fallback. Orchestrators SHOULD warn on heuristic."
        },
        "perCause": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["findingId", "score"],
            "properties": {
              "findingId": { "type": "string" },
              "score": { "type": "number", "minimum": 0, "maximum": 1 }
            }
          }
        }
      }
    },
    "severity": {
      "type": "object",
      "additionalProperties": false,
      "description": "Roll-up severity for the whole log, derived from the highest-severity active failure. Drives orchestrator escalation thresholds.",
      "required": ["level", "blockingCount"],
      "properties": {
        "level": { "type": "string", "enum": ["info", "warning", "error", "blocked"] },
        "blockingCount": { "type": "integer", "minimum": 0 }
      }
    },
    "correctionDelta": {
      "$ref": "#/$defs/correctionDelta",
      "description": "The single prompt-ready artifact: bounded, redacted, forward-looking corrective instructions the Worker receives. This is the only field spliced into the Worker prompt."
    }
  },
  "$defs": {
    "location": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path"],
      "properties": {
        "path": { "type": "string", "description": "Repo-relative; absolute paths MUST be relativized by the redactor." },
        "startLine": { "type": "integer", "minimum": 1 },
        "endLine": { "type": "integer", "minimum": 1 }
      }
    },
    "finding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "rule", "location", "message", "severity", "firstObservedIn", "lastObservedIn", "status"],
      "properties": {
        "id": { "type": "string", "description": "Stable hash of (rule, location, message). Collision ⇒ ID_COLLISION fatal error." },
        "rule": { "type": "string", "examples": ["lsp:unused-import", "test:assert-eq"] },
        "location": {
          "oneOf": [{ "$ref": "#/$defs/location" }, { "type": "null" }],
          "description": "null only for unanchored findings explicitly carrying a rule; unmappable chatter is dropped at Stage 1."
        },
        "message": { "type": "string", "description": "Already redacted: secrets masked, paths relativized, trimmed to N chars." },
        "severity": { "type": "string", "enum": ["error", "warning", "info"] },
        "firstObservedIn": { "type": "integer", "minimum": 1 },
        "lastObservedIn": { "type": "integer", "minimum": 1 },
        "status": { "type": "string", "enum": ["open", "resolved", "superseded"] }
      }
    },
    "rootCause": {
      "type": "object",
      "additionalProperties": false,
      "description": "A cluster of findings sharing one stable id, promoted to a single per-cause record.",
      "required": ["findingId", "rule", "location", "severity", "firstSeen", "lastSeen", "status", "rounds", "keepForContext"],
      "properties": {
        "findingId": { "type": "string" },
        "rule": { "type": "string" },
        "location": {
          "oneOf": [{ "$ref": "#/$defs/location" }, { "type": "null" }]
        },
        "severity": { "type": "string", "enum": ["error", "warning", "info"] },
        "firstSeen": { "type": "integer", "minimum": 1 },
        "lastSeen": { "type": "integer", "minimum": 1 },
        "status": { "type": "string", "enum": ["open", "resolved", "superseded"] },
        "rounds": {
          "type": "array",
          "description": "Round indices in which this cause was observed.",
          "items": { "type": "integer", "minimum": 1 }
        },
        "keepForContext": {
          "type": "boolean",
          "default": false,
          "description": "Verifier allowlist escape: a resolved/superseded cause the Verifier wants retained in the Delta. Defaults false."
        }
      }
    },
    "openRootCause": {
      "type": "object",
      "additionalProperties": false,
      "description": "An active open root cause rendered into the Correction Delta, ranked and bounded.",
      "required": ["rank", "findingId", "rule", "location", "severity", "firstSeen", "lastSeen", "message", "trace", "blocking"],
      "properties": {
        "rank": { "type": "integer", "minimum": 1, "description": "1-based relevance rank from Stage 4." },
        "findingId": { "type": "string" },
        "rule": { "type": "string" },
        "location": {
          "oneOf": [{ "$ref": "#/$defs/location" }, { "type": "null" }]
        },
        "severity": { "type": "string", "enum": ["error", "warning", "info"] },
        "firstSeen": { "type": "integer", "minimum": 1 },
        "lastSeen": { "type": "integer", "minimum": 1 },
        "message": { "type": "string", "description": "Redacted; trimmed to the Delta's per-item char budget." },
        "trace": {
          "oneOf": [{ "type": "string" }, { "type": "null" }],
          "description": "First occurrence's trace only; repeats use a back-reference like 'same as round k'. null if no trace retained."
        },
        "blocking": { "type": "boolean" }
      }
    },
    "redaction": {
      "type": "object",
      "additionalProperties": false,
      "description": "Tombstone for a single redaction decision.",
      "required": ["from", "rule", "reason"],
      "properties": {
        "from": { "type": "string", "description": "findingId that was redacted." },
        "rule": {
          "type": "string",
          "enum": ["stale-state", "superseded-edit", "sensitive", "stale-assumption", "truncation"]
        },
        "reason": { "type": "string", "description": "Human-readable rationale, e.g. 'resolved in round 3', 'secret pattern matched'." },
        "auditLogId": { "type": "string", "description": "Audit Log entry holding the redacted content for human recovery." }
      }
    },
    "correctionDelta": {
      "type": "object",
      "additionalProperties": false,
      "description": "The prompt-ready artifact. The orchestrator splices ONLY this field into the Worker prompt, positioned after taskSpec and before any per-turn plan.",
      "required": ["attempt", "lastVerdict", "openRootCauses", "resolvedSummary", "omitted", "constraints", "generatedAt"],
      "properties": {
        "attempt": { "type": "integer", "minimum": 1, "description": "Round this Delta prepares (lastRound + 1)." },
        "lastVerdict": { "type": "string", "enum": ["pass", "fail", "blocked"] },
        "openRootCauses": {
          "type": "array",
          "description": "Top-K active failures, ordered by relevance rank.",
          "items": { "$ref": "#/$defs/openRootCause" }
        },
        "resolvedSummary": {
          "oneOf": [{ "type": "string" }, { "type": "null" }],
          "description": "One line, e.g. 'M prior findings resolved in rounds …'; null if none."
        },
        "omitted": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["count", "auditLogId"],
              "properties": {
                "count": { "type": "integer", "minimum": 1 },
                "auditLogId": { "type": "string" }
              }
            },
            { "type": "null" }
          ],
          "description": "Truncation marker when Stage 5 exceeded the token budget; never silently drop."
        },
        "constraints": {
          "type": "array",
          "description": "Hard 'do not' rules derived from redactions, e.g. 'do not re-introduce the reverted block at src/foo.go:42-58'. Worker treats as hard rules.",
          "items": { "type": "string" }
        },
        "generatedAt": { "type": "string", "description": "Monotonic ts; not wall-clock." }
      }
    }
  }
}
```

### Orchestrator validation & usage notes

- **Validate before splice.** The orchestrator MUST validate every compacted log against this schema before merging it into the Worker prompt. A log that fails schema validation is treated as `INVALID_REQUEST` (per Failure Modes): the orchestrator skips the merge, logs the validation error to the Audit Log, and either falls back to the previous Delta unchanged or emits the minimal `"prior attempt failed; re-verify against canonicalState"` Delta. The Worker must never receive a structurally invalid log.
- **Version-gate on `schemaVersion`.** Orchestrators parse a fixed range of semver versions they understand and reject unknown ones. Bump the version on any breaking shape change; orchestrators should fail closed rather than guess at an unversioned payload.
- **Verify the source window.** Check `sourceWindow.lastRound == currentRound` and that `canonicalStateRef` matches the working tree's current ref. A mismatch means the Compactor ran against a stale snapshot (a TOCTOU gap) and the Delta should be discarded and re-compacted.
- **Splice only `correctionDelta`.** Only the `correctionDelta` field enters the Worker prompt. The envelope fields (`findings`, `rootCauses`, `resolvedFailures`, `redactions`, `evidence`, `confidence`, `severity`, `compaction`) are orchestrator-facing: they drive validation, escalation, and audit. Passing them into the Worker prompt would re-introduce the bloat the Compactor exists to prevent.
- **Stall detection.** Compare `correctionDelta` byte-for-byte with the prior turn's `correctionDelta` (the `compaction.stallCandidate` flag is a hint, not a verdict). Only escalate after `STALL_ROUNDS` (default 2) consecutive identical Deltas *and* no `canonicalState` change, per the stall false-positive mitigation.
- **Token-budget check.** Assert `compaction.renderedTokens <= compaction.budgetTokens` OR that `correctionDelta.omitted != null`. A log that overshot without emitting an `omitted` marker violates the bounded-size contract and should be rejected as malformed.
- **Heuristic-confidence warning.** If `confidence.method == "heuristic"`, the orchestrator should log a warning: exact-match clustering is the auditable default; heuristic clustering risks false merges/splits that break convergence.
- **Severity-driven escalation.** Use the top-level `severity` roll-up to gate escalation: a `blocked` level with a stalled Delta is a strong escalate signal; `info`/`warning` levels may warrant more retries before escalating.
- **Redaction auditability.** `redactions[]` and `evidence.refs[]` are the human-recovery path. They are never sent to the Worker, but the orchestrator should surface counts/metadata in its run status so a human reviewing a degraded loop can trace what was dropped without reading the Worker prompt.
- **No history in the prompt.** The schema deliberately keeps full round transcripts, traces, and dropped findings *out* of `correctionDelta` and reachable only via `evidence.refs` into the Audit Log. This enforces the O(1)-in-attempts prompt footprint that is the Compactor's core guarantee.
