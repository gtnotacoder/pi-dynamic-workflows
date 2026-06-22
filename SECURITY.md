# Security model

`pi-dynamic-workflows` executes workflow scripts as **trusted code**.

Node's `vm` is used as a deterministic JavaScript realm for authoring guardrails (for example, disabling `Math.random()` and no-arg `Date`). It is **not** a security sandbox. Workflow scripts receive host bridge functions such as `agent()`, `parallel()`, `log()`, and `process.cwd()`; a determined script can use those host objects to reach host capabilities.

## Safe use

- Run workflows you wrote, reviewed, or explicitly trust.
- Do not run unreviewed model-generated or third-party workflow scripts as untrusted input.
- Treat saved workflows as code in your repo/user profile.
- Use `/code-review` for review: it is constructed with read-only tools and host-computed git argv/patch data, so reviewer agents cannot write files or author shell commands.

## Current guardrails

- Script source size and synchronous setup are bounded.
- Async workflow runs have a wall-clock timeout for suspended promises.
- Per-agent timeouts abort the subagent attempt and wait for it to settle before freeing limiter slots/worktrees.
- Run IDs are validated before persistence path joins.
- Resume hashes include resolved context primitives to avoid replaying results under a different subagent context.

## Not provided

This package does not provide OS-level isolation for untrusted workflow JavaScript, nor a same-process hard kill for CPU-bound post-await loops. Real untrusted execution requires a process/container sandbox with a narrow RPC boundary.
