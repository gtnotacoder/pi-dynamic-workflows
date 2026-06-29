# Supervisor telemetry/env policy

This runbook covers tmux/supervisor-launched Pi sessions such as issue-delivery,
review, and repair panes.

## Hindsight / epimetheus

Supervisors must **never** launch workers with a blank override like:

```sh
HINDSIGHT_API_URL= pi ...
```

A blank value masks normal Hindsight configuration discovery and produces noisy
runtime errors such as `epimetheus: apiUrl is required`.

Use one of these two explicit modes instead:

1. **Inherit normal config**: omit `HINDSIGHT_API_URL` from the child env. This lets
   Pi/Hindsight use config files or project defaults.
2. **Force a server**: set a non-empty URL, e.g. `HINDSIGHT_API_URL=http://...`.

The package exports `prepareSupervisorTelemetryEnv(env, { hindsightApiUrl })` and
`normalizeHindsightApiUrlEnv()` for launchers. They remove blank
`HINDSIGHT_API_URL`, preserve non-empty values, or inject an explicit non-empty
URL.

## Langfuse

Langfuse credentials should stay out of chat and shell transcripts. The supported
supervisor pattern is to load them from a secret-managed env file at process
launch, for example:

```sh
op run --env-file ~/.config/pi/langfuse.env -- pi ...
```

The parent shell does not need to have `LANGFUSE_PUBLIC_KEY` or
`LANGFUSE_SECRET_KEY` set. Operators can confirm configuration without printing
secrets by checking booleans from `prepareSupervisorTelemetryEnv()`:

- `langfuse.publicKeyPresent`
- `langfuse.secretKeyPresent`
- `langfuse.endpointConfigured` (true only when `LANGFUSE_BASE_URL`,
  `LANGFUSE_BASEURL`, or `LANGFUSE_HOST` is explicitly set)
- `langfuse.includePayloads`

Tracing still follows the runtime rules in `src/langfuse-tracing.ts`:

- tracing enables only when public and secret keys are present and not explicitly disabled;
- payloads and absolute run paths are redacted unless `LANGFUSE_INCLUDE_PAYLOADS=true`.

## Pi telemetry parentage

Before launching a supervised top-level Pi process, call
`prepareSupervisorTelemetryEnv()` on the child env. When called before spawn, it
cannot know the future child PID, so it conservatively scrubs inherited
`PI_TELEMETRY_*` values even if they are valid for the supervisor process. That
prevents unrelated tmux/Pi children from attaching to the supervisor's old trace.

If a launcher prepares env after creating a child process and knows the actual
child PID/parentage, it may pass `childRuntime` to allow the normal
`PI_TELEMETRY_*` preservation rules for a proven direct child or marked subagent.

## Secret-safe smoke check

A launcher can log this diagnostic object without leaking secrets:

```ts
const env = { ...process.env };
const decision = prepareSupervisorTelemetryEnv(env, { hindsightApiUrl: process.env.HINDSIGHT_API_URL });
console.log({
  hindsightApiUrlAction: decision.hindsightApiUrlAction,
  piTelemetryReason: decision.piTelemetry.reason,
  piTelemetryScrubbed: decision.piTelemetry.scrubbed,
  langfuse: decision.langfuse,
});
```

Do not print raw `LANGFUSE_*`, `HINDSIGHT_API_URL`, or provider API keys.
