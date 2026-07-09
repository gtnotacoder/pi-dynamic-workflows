# Model-tier routing — release 0.2.2

## Goal

Make workflow-authored model selection explicit, deterministic, locally configurable, and quality-preserving for the current model pack without hard-coding one operator's providers into portable workflows.

## Shipped runtime behavior

- `ModelTierConfig` accepts optional `routingNotes`; these machine-local operator rules are injected into the workflow tool's model-facing authoring guidance.
- The authoring guidance includes the concrete current tier map, available model IDs, tier purposes, precedence, and the fact that retries do not escalate automatically.
- Every logical run snapshots model-tier configuration once, including nested saved workflows, preventing mid-run config edits from routing different calls inconsistently.
- Resume identities include the concrete routed model. Changing the model behind a tier invalidates the affected journal suffix instead of replaying output produced by a different model; compatible 0.2.1 journals still replay when their recorded concrete model matches.
- Blank tier entries normalize to the actual session-model fallback before hashing and display.
- `/workflows-models` emits non-blocking warnings for missing standard tiers and duplicate mappings that make an escalation retry the same model; resetting tiers preserves independent operator `routingNotes`.
- `modelTierConfigWarnings` is exported for embedders and tests.

Resolution precedence remains:

1. explicit `agent(..., { model })`;
2. model bound by `agentType`;
3. explicit `tier`;
4. phase model;
5. configured `medium` for untagged agents;
6. session model.

Each tier maps to one model. There is no implicit provider fallback and retries do not change tiers.

## Documentation

- `docs/model-routing-specialization.md` is the full operator and workflow-author reference: role matrix, escalation patterns, pinning policy, cache caveats, saved-workflow audit rules, and provider-route context limits.
- `README.md` documents the runtime contract and links the full reference.
- `docs/architecture.md` documents precedence, per-run snapshots, and resume invalidation.
- `CONTEXT.md` defines model tier, escalation ladder, and model pin.
- `docs/provider-behavior-benchmarks.md` uses the current Luna/GLM/Opus comparison set.

## Qualified local profile

The operator profile applied on the development VM is:

```text
small  = litellm-ny2/local-qwen27
medium = litellm-ny2/oc-glm52
big    = openai-codex/gpt-5.6-sol
```

GPT-5.6 Luna is the fast-medium/trace-analysis canary; Terra is a medium-plus or independent OpenAI refuter; Opus/Fable are explicit Anthropic frontier specialists; Gemini is retained only for multimodal/Google-grounded or deliberate model-family diversity. GPT-5.5 is retired from active routing.

This mapping, the GPT-5.6 entries in `~/.pi/agent/models.json`, user agent definitions, and saved-workflow migrations are intentionally machine-local and are not overwritten by the npm package.

## GPT-5.6 context qualification

OpenAI's public API cards advertise 1.05M context, but the ChatGPT Codex route used by `openai-codex` exposes 372k. Compaction-off, no-tool probes placed five markers throughout each prompt:

| Model | Exact retrieval accepted | Next probe |
|---|---:|---|
| Luna | 370,270 total tokens | ~375k `context_length_exceeded` |
| Terra | 370,315 total tokens | ~375k `context_length_exceeded` |
| Sol | 370,268 total tokens | ~375k `context_length_exceeded` |

The machine-local `openai-codex` entries therefore remain at `contextWindow: 372000`; a direct `openai` API route would need separate TPM and end-to-end validation before using 1.05M.

## Verification

- `npm test`: 1,414 passed, 0 failed, 0 skipped.
- `npm run check:workflow-lock`: 0 errors; expected warnings remain for externally stored saved workflows.
- LSP and pi-lens: 0 blocking diagnostics in changed source files.
- `npm pack --dry-run`: routing documentation, source, and built artifacts included; tests excluded.
- Active user/project saved workflows contain no GPT-5.5 pins.

Known upstream SDK gaps are tracked separately:

- `earendil-works/pi#6468`: stable prompt-cache key independent of subagent session ID.
- `earendil-works/pi#6469`: GPT-5.6 cache-write telemetry.
