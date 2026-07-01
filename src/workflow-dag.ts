/**
 * @fileoverview Dependency-aware DAG execution for workflow scripts.
 *
 * Adapted from open-multi-agent's `task/queue.ts` (dependency-aware task queue
 * with cascade failure/skip), reshaped to this engine's authoring model:
 *
 *  - Pure topology + cascade logic lives here; the caller injects the executor
 *    (`runWave`), so concurrency stays gated by the run's shared limiter and the
 *    `agent()` callSeq ordering remains resume-deterministic.
 *  - Nodes run in deterministic WAVES (all currently-ready nodes, in declaration
 *    order) — NOT a completion-timing promise-graph. `callIndex` is assigned
 *    synchronously at the top of `agent()`, so stable wave membership yields a
 *    reproducible callSeq, which is what makes resume replay correctly. A
 *    timing-driven graph would scramble callSeq and break resume.
 *  - When a node fails, every node that (transitively) depends on it is SKIPPED
 *    rather than left blocked forever (cascade skip), so a wave never deadlocks
 *    on a dead upstream.
 */

export type DagNodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface DagNode<T = unknown> {
  /** Unique id within this `dag()` call. */
  readonly id: string;
  /** Ids this node waits for. All must reach "done" before it runs. */
  readonly dependsOn?: readonly string[];
  /** Work to perform once dependencies are satisfied. Receives done deps' results by id. */
  readonly run: (deps: Readonly<Record<string, T>>) => Promise<T> | T;
}

export interface DagOutcome<T = unknown> {
  /** Results of nodes that reached "done", keyed by id. */
  readonly results: Record<string, T>;
  readonly status: Record<string, DagNodeStatus>;
  /** Error messages for failed nodes, keyed by id. */
  readonly errors: Record<string, string>;
  /** Skipped nodes mapped to the failed/skipped dependency id that caused the skip. */
  readonly skipped: Record<string, string>;
  /** True when every node reached "done". */
  readonly ok: boolean;
}

/**
 * One settled node result from a wave. Recoverable failures are returned as
 * `{ ok: false }`; non-recoverable failures (token budget / agent-limit) must be
 * THROWN by `runWave` so they halt the whole run, exactly like `parallel()`.
 */
export type WaveResult<T> =
  | { readonly id: string; readonly ok: true; readonly value: T }
  | { readonly id: string; readonly ok: false; readonly error: string };

export interface DagWaveItem<T> {
  readonly node: DagNode<T>;
  /** Results of this node's already-"done" dependencies, keyed by id. */
  readonly deps: Record<string, T>;
}

export type RunWave<T> = (batch: ReadonlyArray<DagWaveItem<T>>) => Promise<ReadonlyArray<WaveResult<T>>>;

/** Thrown for malformed graphs (bad id, missing dep, duplicate id, cycle). */
export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagValidationError";
  }
}

/** Validate node shape, dependency references, uniqueness, and acyclicity. */
export function validateDag<T>(nodes: ReadonlyArray<DagNode<T>>): void {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || n.id.length === 0)
      throw new DagValidationError("each dag node needs a non-empty string id");
    if (isReservedDagId(n.id)) throw new DagValidationError(`reserved dag node id "${n.id}"`);
    if (typeof n.run !== "function") throw new DagValidationError(`dag node "${n.id}" needs a run() function`);
    if (n.dependsOn !== undefined) {
      if (!Array.isArray(n.dependsOn)) throw new DagValidationError(`dag node "${n.id}" dependsOn must be an array`);
      for (const dep of n.dependsOn) {
        if (typeof dep !== "string" || dep.length === 0)
          throw new DagValidationError(`dag node "${n.id}" dependsOn entries must be non-empty strings`);
      }
    }
    if (ids.has(n.id)) throw new DagValidationError(`duplicate dag node id "${n.id}"`);
    ids.add(n.id);
  }
  for (const n of nodes)
    for (const dep of n.dependsOn ?? [])
      if (!ids.has(dep)) throw new DagValidationError(`dag node "${n.id}" depends on unknown id "${dep}"`);
  detectCycle(nodes);
}

function isReservedDagId(id: string): boolean {
  return id === "__proto__" || id === "prototype" || id === "constructor";
}

function detectCycle<T>(nodes: ReadonlyArray<DagNode<T>>): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 1 = on the current DFS stack, 2 = fully explored.
  const mark = new Map<string, 1 | 2>();
  const visit = (id: string, path: readonly string[]): void => {
    const m = mark.get(id);
    if (m === 2) return;
    if (m === 1) throw new DagValidationError(`dependency cycle: ${[...path, id].join(" -> ")}`);
    mark.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...path, id]);
    mark.set(id, 2);
  };
  for (const n of nodes) visit(n.id, []);
}

/**
 * Execute a DAG in deterministic waves. `runWave` runs one wave of ready nodes
 * and returns their settled results; the caller owns concurrency/limiter and may
 * throw to abort the whole run on a non-recoverable failure.
 */
export async function runDag<T = unknown>(
  nodes: ReadonlyArray<DagNode<T>>,
  runWave: RunWave<T>,
): Promise<DagOutcome<T>> {
  validateDag(nodes);

  const status = new Map<string, DagNodeStatus>(nodes.map((n) => [n.id, "pending"]));
  const results: Record<string, T> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  const skipped: Record<string, string> = Object.create(null);

  const isDead = (id: string): boolean => status.get(id) === "failed" || status.get(id) === "skipped";

  // Cascade-skip every pending node whose dependency already failed/skipped.
  // Repeat to a fixpoint so skips propagate transitively before each wave.
  const cascadeSkips = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        if (status.get(n.id) !== "pending") continue;
        const badDep = (n.dependsOn ?? []).find(isDead);
        if (badDep !== undefined) {
          status.set(n.id, "skipped");
          skipped[n.id] = badDep;
          changed = true;
        }
      }
    }
  };

  for (;;) {
    cascadeSkips();

    // Ready = pending nodes whose deps are all done. Stable declaration order
    // keeps wave membership — and therefore agent() callSeq — reproducible.
    const ready = nodes.filter(
      (n) => status.get(n.id) === "pending" && (n.dependsOn ?? []).every((d) => status.get(d) === "done"),
    );
    if (ready.length === 0) break;

    for (const n of ready) status.set(n.id, "running");

    const batch: DagWaveItem<T>[] = ready.map((node) => ({
      node,
      deps: Object.fromEntries((node.dependsOn ?? []).map((d) => [d, results[d]])) as Record<string, T>,
    }));

    const settled = await runWave(batch);
    const settledById = new Map(settled.map((r) => [r.id, r]));
    for (const node of ready) {
      const r = settledById.get(node.id);
      if (!r) {
        // runWave dropped a node — treat as a failure so dependents skip, not hang.
        status.set(node.id, "failed");
        errors[node.id] = "no result returned for node";
        continue;
      }
      if (r.ok) {
        status.set(node.id, "done");
        results[node.id] = r.value;
      } else {
        status.set(node.id, "failed");
        errors[node.id] = r.error;
      }
    }
  }

  const statusObj = Object.fromEntries(status) as Record<string, DagNodeStatus>;
  const ok = Object.values(statusObj).every((s) => s === "done");
  return { results, status: statusObj, errors, skipped, ok };
}
