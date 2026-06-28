import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const lockPath = join(root, "docs", "workflows", "workflow-lock.json");
const catalogPath = join(root, "docs", "workflows", "catalog.md");

function readLock(): Record<string, unknown> {
  const raw = readFileSync(lockPath, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`workflow-lock.json should be valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

/** Extract `/canonical` commands from the catalog.md canonical workflows table. */
function readCatalogCommands(): string[] {
  const md = readFileSync(catalogPath, "utf8");
  const start = md.indexOf("## Canonical workflows");
  assert.ok(start >= 0, "catalog.md should have a Canonical workflows section");
  const tableStart = md.indexOf("| Canonical |", start);
  assert.ok(tableStart >= 0, "catalog.md should have a canonical workflows table");
  // Skip the header + separator rows.
  const rowsStart = md.indexOf("\n", md.indexOf("|---|", tableStart));
  const sectionEnd = md.indexOf("\n## ", rowsStart);
  const table = sectionEnd >= 0 ? md.slice(rowsStart, sectionEnd) : md.slice(rowsStart);

  const commands: string[] = [];
  for (const line of table.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.includes("|")) continue;
    // Skip separator rows like |---|---|...
    if (/^\|[\s-|]+\|$/.test(trimmed)) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    const canonical = cells[0].replace(/^`+|`+$/g, "").trim();
    if (!canonical?.startsWith("/")) continue;
    commands.push(canonical);
  }
  return commands;
}

describe("workflow-lock", () => {
  it("parses lock entries", () => {
    const lock = readLock();
    assert.ok(Array.isArray(lock.entries), "lock should have entries array");
  });

  it("has a top-level collisionPolicy", () => {
    const lock = readLock();
    const policy = lock.collisionPolicy as Record<string, unknown> | undefined;
    assert.ok(policy, "lock should declare a collisionPolicy");
    assert.deepEqual(policy?.registrationOrder, ["builtin-command", "saved-workflow"]);
    assert.equal(policy?.savedWorkflowCommandCollision, "skip-and-warn");
    assert.equal(policy?.aliasCollisionSeverity, "warning");
  });

  it("every canonical catalog command has a matching lock entry", () => {
    const lock = readLock();
    const entries = (lock.entries as Array<Record<string, unknown>>).filter(
      (e) => typeof e.command === "string" && typeof e.canonicalName === "string",
    );
    const locked = new Set(entries.map((e) => e.command as string));

    const catalog = readCatalogCommands();
    assert.ok(catalog.length >= 5, `catalog should have several commands, got ${catalog.length}`);

    const missing = catalog.filter((cmd) => !locked.has(cmd));
    assert.deepEqual(missing, [], `catalog commands missing from workflow-lock.json: ${missing.join(", ")}`);
  });

  it("lock entry kinds are within the reserved set", () => {
    const lock = readLock();
    const entries = (lock.entries as Array<Record<string, unknown>>).filter((e) => typeof e.kind === "string");
    const allowed = new Set([
      "builtin-command",
      "bundled-template",
      "saved-workflow",
      "harness-metadata",
      "deprecated-alias",
    ]);
    for (const e of entries) {
      assert.ok(allowed.has(e.kind as string), `unexpected kind ${e.kind} for ${e.canonicalName}`);
    }
  });
});

/**
 * Run check-workflow-lock.mjs against a synthetic lock written to a temp dir
 * and return the combined stdout/stderr text. Exercises the real checker code
 * path so alias-collision behavior is validated end-to-end.
 */
function runCheckerAgainst(entries: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "wflock-"));
  try {
    mkdirSync(join(dir, "docs", "workflows"), { recursive: true });
    const lock = {
      schema: "pi-dynamic-workflows.workflow-lock.v1",
      generatedAt: "2026-06-28",
      mode: "warning",
      collisionPolicy: {
        registrationOrder: ["builtin-command", "saved-workflow"],
        savedWorkflowCommandCollision: "skip-and-warn",
        aliasCollisionSeverity: "warning",
      },
      entries,
    };
    const lockFile = join(dir, "docs", "workflows", "workflow-lock.json");
    writeFileSync(lockFile, JSON.stringify(lock));
    const script = join(root, "scripts", "check-workflow-lock.mjs");
    // Drive the checker at the real lock path via --lock so it reads the
    // synthetic entries; the default repo-relative path stays for `npm run`.
    return execFileSync("node", [script, "--lock", lockFile], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-workflow-lock alias collisions", () => {
  it("warns when an alias declared before a saved-workflow command collides with it", () => {
    // Order-independent check: the alias /foo is declared on an earlier entry
    // than the saved-workflow command /foo. The old order-dependent check
    // would miss this; the catalog promises alias collisions surface as warnings.
    const entries = [
      {
        canonicalName: "legacy-foo",
        command: "/legacy-foo",
        kind: "deprecated-alias",
        source: "~/external",
        aliases: ["/foo"],
      },
      {
        canonicalName: "foo-workflow",
        command: "/foo",
        kind: "saved-workflow",
        source: "~/external",
        aliases: [],
      },
    ];
    const out = runCheckerAgainst(entries);
    assert.match(out, /legacy-foo: alias \/foo is also registered as foo-workflow/);
  });

  it("does not warn when an alias equals its own entry's command", () => {
    const entries = [
      {
        canonicalName: "self-alias",
        command: "/self-alias",
        kind: "builtin-command",
        source: "~/external",
        aliases: ["/self-alias"],
      },
    ];
    const out = runCheckerAgainst(entries);
    assert.doesNotMatch(out, /self-alias: alias \/self-alias is also registered/);
  });

  it("warns in both orders for an alias/command collision", () => {
    // Command-first ordering (alias after its target command) must still warn.
    const entries = [
      {
        canonicalName: "foo-workflow",
        command: "/foo",
        kind: "saved-workflow",
        source: "~/external",
        aliases: [],
      },
      {
        canonicalName: "legacy-foo",
        command: "/legacy-foo",
        kind: "deprecated-alias",
        source: "~/external",
        aliases: ["/foo"],
      },
    ];
    const out = runCheckerAgainst(entries);
    assert.match(out, /legacy-foo: alias \/foo is also registered as foo-workflow/);
  });
});
