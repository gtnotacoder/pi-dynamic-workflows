# Model routing and specialization

> **Status:** Reference — reviewed 2026-07-09 for GPT-5.6, Claude Fable 5 / Opus 4.8, GLM-5.2, Gemini 3.5 Flash, and the local Qwen route.

This document defines how this installation routes workflow roles without giving up final-output quality. The guiding policy is **local-first execution, evidence-first escalation, frontier verification**.

## Runtime facts

The runtime has three portable tiers. Each tier maps to exactly one `provider/model` string in `~/.pi/workflows/model-tiers.json`:

```json
{
  "tiers": {
    "small": "litellm-ny2/local-qwen27",
    "medium": "litellm-ny2/oc-glm52",
    "big": "openai-codex/gpt-5.6-sol"
  }
}
```

This is the conservative production profile while GPT-5.6 Luna is qualified in this harness.

Binding precedence is:

1. `agent(..., { model })`
2. model pinned by `agentType`
3. `agent(..., { tier })`
4. phase model in `meta.phases[]`
5. configured `medium` tier for an untagged agent
6. session model

Important consequences:

- A tier is **not** a fallback pool. There is no automatic provider failover.
- `retries` rerun the same route. They do not move from small to medium or big.
- An escalation ladder must explicitly select `small -> medium -> big` (or explicit models).
- Pinning a model in an escalation-capable `agentType` defeats tier escalation.
- Adjacent tiers mapped to the same model create the appearance of escalation without changing capability. `/workflows-models` warns about this shape.
- The model-tier config is snapshotted once per run. On resume, changing the model behind a tier invalidates that call's cached journal suffix.

Optional `routingNotes` in `model-tiers.json` are injected into the model-facing workflow-authoring prompt. They carry machine-specific specialization that cannot fit into three slots:

```json
{
  "tiers": {
    "small": "litellm-ny2/local-qwen27",
    "medium": "litellm-ny2/oc-glm52",
    "big": "openai-codex/gpt-5.6-sol"
  },
  "routingNotes": [
    "Prefer local Qwen for high-volume first attempts; deterministic checks and a big-tier verifier remain mandatory for consequential changes.",
    "Canary GPT-5.6 Luna for trace synthesis, fast structured-output loops, and selected medium work; use GLM-5.2 for proven project-scale execution and OpenAI-provider diversity.",
    "Use Terra, Opus, Fable, Gemini, or Kimi only for a documented specialization, provider fallback, or independent model-family review."
  ]
}
```

## Recommended roles

| Model | Default posture | Use it for | Do not use it for |
|---|---|---|---|
| `litellm-ny2/local-qwen27` | `small` | Repo inventory, targeted reads, narrow edits, repetitive transformations, first worker attempt, low-risk reporting | Sole final verifier for consequential changes; ambiguous architecture/security decisions |
| `litellm-ny2/oc-glm52` | `medium` (current proven route) | Multi-file implementation, long agent trajectories, project-scale context, correction rounds, independent non-OpenAI review | Final authority merely because it has a large context window |
| `openai-codex/gpt-5.6-luna` | Explicit medium canary | Fast/high-volume structured work, trace analysis, CI/log synthesis, schema-heavy tool loops, selected second attempts | Automatic promotion to the production medium slot before harness-level success/latency data exists |
| `openai-codex/gpt-5.6-terra` | Explicit medium-plus | A harder retry after Luna/GLM, balanced premium implementation, an OpenAI refuter when Sol is unnecessary | Routine local-first fan-out; final frontier gate when Sol is available |
| `openai-codex/gpt-5.6-sol` | `big` | Thinker/planner, controller synthesis, final semantic verifier, security review, difficult debugging, high-consequence decisions | Mechanical checks, broad cheap fan-out, work already proved by deterministic tooling |
| `meridian/claude-opus-4-8` | Explicit diverse frontier | Independent Anthropic verifier, cache-sensitive repeated context, long-running agentic coding, judgment/style review | Default big route when Sol is available; cheap bulk work |
| `meridian/claude-fable-5` | Explicit maximum Anthropic | Exceptional long-horizon work, stubborn architecture/research problems, highest-risk second frontier opinion | Routine reviews or fan-out; a default route without refusal/fallback handling |
| `google-ai-studio/gemini-3.5-flash` | Niche diversity only | Native audio/video/PDF or Google-grounded work, 1M multimodal context, independent family tie-breaks | Generic coding solely because it is fast; any slot already covered better by local Qwen/Luna/GLM |
| `openai-codex/gpt-5.5` | Retired control | Temporary regression benchmark or emergency launch fallback only | Any normal tier, phase default, or active reviewer/worker role |

Kimi remains useful as a separate-family adversarial refuter. Model diversity is valuable when reviewers fail differently; it is not a reason to run every available model.

## Why Luna has not immediately replaced GLM

GPT-5.6 Luna is a credible medium-tier candidate, not merely a small model:

- OpenAI documents a **1.05M context window** and 128k maximum output, so the old local `372000` registry value is stale.
- It supports structured outputs, function calling, reasoning, and a 90% cached-input discount.
- GPT-5.6 adds more reliable prompt caching with `prompt_cache_key`, 30-minute minimum retention, and explicit breakpoints.

GLM-5.2 also supports first-party automatic context caching and a 1M context window. The current `oc-glm52` bridge has not reported cache fields in local workflow telemetry, but missing telemetry is not proof that the provider performs no caching.

There is also a harness-specific limitation: Pi's `openai-codex` adapter derives `prompt_cache_key` from the subagent session ID. Every workflow `agent()` starts a fresh session, so cache reuse is strong within a multi-turn agent but separate fan-out agents may use different keys. Luna's cache therefore does not automatically make every fan-out cheaper.

The production choice remains GLM until Luna passes representative local evaluations for:

1. task success and semantic verifier pass rate;
2. structured-output/tool-call reliability;
3. wall-clock latency and timeout rate;
4. total fresh input, cache-write, cache-read, and output tokens;
5. provider quota/rate-limit behavior;
6. correction rounds required per accepted change.

If Luna wins those measures, promote it to `medium` and retain GLM as the explicit project-scale/provider-diversity route. This is a configuration change, not a code change.

## Quality-preserving workflow patterns

### Normal issue-sized implementation

```text
local Qwen worker
  -> host stageCheck
  -> GLM or Luna correction only if needed
  -> host stageCheck
  -> Sol semantic verifier
```

The cheap model does most token-heavy work. Quality comes from constrained scope, mechanical checks, correction feedback, and an independent frontier gate—not from sending every token to the frontier model.

### Difficult or repository-scale implementation

```text
local Qwen scout
  -> Sol planner
  -> GLM project-scale worker (or Terra when OpenAI-family behavior is required)
  -> host checks
  -> Sol verifier
  -> Opus/Fable second opinion only for unresolved high-risk findings
```

### Adversarial review

```text
Qwen finders
  -> GLM/Luna consolidation
  -> GLM/Kimi/Opus/Gemini family-diverse refuters as signaled by risk
  -> Sol controller verdict
```

Do not use model count as a proxy for confidence. A source-backed refutation or deterministic test should outweigh majority voting.

## Cache-aware routing

Cache behavior belongs to the **provider route plus harness**, not just the model name.

- GPT-5.6: writes cost 1.25x uncached input on API billing; reads cost 10% of input; the current API requires a stable cache key for improved matching. The Codex adapter supplies a session-derived key but does not currently expose explicit breakpoints from workflow scripts.
- GLM-5.2: Z.AI documents automatic cache recognition and `usage.prompt_tokens_details.cached_tokens`; verify whether the selected LiteLLM/Ollama route forwards those fields.
- Opus via Meridian: the dated local benchmark found reliable cache reuse across discrete calls with a shared prefix. Re-run before assuming that behavior for a different model or bridge version.
- Local Qwen: no provider bill, so compaction/throughput and GPU occupancy matter more than cached-token price.

Never route solely on advertised context size. Long prompts above 272k on GPT-5.6 receive higher long-context pricing, and excessive context can reduce focus even when it fits.

## Saved-workflow policy

Saved workflows should use tiers by default. An exact `model` is justified only for:

- explicit provider/model-family diversity;
- a measured capability unavailable from the configured tier;
- a deliberate provider fallback;
- a temporary qualification benchmark requested by the operator.

Audit saved workflows whenever the model pack changes:

1. Remove retired generation pins (`gpt-5.5`, old Opus revisions, stale Gemini defaults).
2. Ensure `model` does not accidentally override a `tier` on a worker/verifier.
3. Ensure retry rounds actually change route.
4. Keep final controllers/verifiers on `big` unless a documented diverse frontier override is intentional.
5. Keep model-specific benchmark fixtures pinned so historical comparisons remain reproducible; label them as controls, not defaults.

## Model-registry metadata

The local Pi model registry controls context-window guardrails and occupancy reporting. As of 2026-07-09, OpenAI documents Sol, Terra, and Luna at:

- context window: `1_050_000` tokens;
- maximum output: `128_000` tokens;
- input: text and image;
- reasoning: supported.

A stale smaller `contextWindow` causes premature warnings/compaction and can reject valid prompts. It does not make the provider itself smaller.

## Sources and requalification

Capability claims are time-sensitive. Re-run local qualification after a provider, bridge, model snapshot, system prompt, or tool schema changes.

- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [GPT-5.6 Sol model card](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5.6 Terra model card](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [GPT-5.6 Luna model card](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Claude model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Fable 5](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5)
- [Claude Opus 4.8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
- [GLM-5.2 overview](https://docs.z.ai/guides/llm/glm-5.2)
- [Z.AI context caching](https://docs.z.ai/guides/capabilities/cache)
- [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash)
- [Provider-behavior benchmark](./provider-behavior-benchmarks.md)
