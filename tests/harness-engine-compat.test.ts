import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkEngineFloor,
  compareSemver,
  parseSemver,
  readEngineVersionFromFile,
  stringifySemver,
} from "../src/engine-compat.js";
import {
  DEFAULT_SUPPORTED_SCHEMA_VERSIONS,
  loadHarnessConfigRegistry,
  parseHarnessConfigDescriptor,
} from "../src/harness-config.js";
import {
  runValidateHarness as exportedRunValidateHarness,
  validateHarnessFile as exportedValidateHarnessFile,
} from "../src/index.js";
import { runValidateHarness, validateHarnessFile } from "../src/validate-harness.js";

function writeDescriptor(dir: string, name: string, raw: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

/** Parse a semver, asserting it is non-null so tests avoid non-null assertions. */
function sem(input: string): { major: number; minor: number; patch: number } {
  const parsed = parseSemver(input);
  if (!parsed) throw new Error(`test semver parse failed: ${input}`);
  return parsed;
}

test("parseSemver / compareSemver handle leading major.minor.patch and ordering", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver("not-a-version"), null);
  assert.equal(parseSemver(undefined), null);
  // Pre-release suffix is retained; trailing junk is rejected (no silent prefix match).
  assert.deepEqual(parseSemver("0.1.7-rc.1"), { major: 0, minor: 1, patch: 7, prerelease: "rc.1" });
  assert.equal(parseSemver("0.1.0oops"), null, "trailing junk must not parse as a valid semver");
  assert.deepEqual(parseSemver("0.1.7+build.42"), { major: 0, minor: 1, patch: 7 });
  assert.equal(compareSemver(sem("1.0.0-rc.1"), sem("1.0.0")), -1, "pre-release is lower than the same release");
  assert.equal(compareSemver(sem("1.0.0"), sem("1.0.0-rc.1")), 1, "release is higher than its pre-release");
  assert.equal(compareSemver(parseSemver("0.1.7")!, parseSemver("0.1.10")!), -1);
  assert.equal(compareSemver(parseSemver("1.0.0")!, parseSemver("1.0.0")!), 0);
  assert.equal(compareSemver(parseSemver("2.0.0")!, parseSemver("1.9.9")!), 1);
  assert.equal(stringifySemver(parseSemver("0.1.7")!), "0.1.7");
});

test("checkEngineFloor: missing floor is ok; below floor is not; invalid floor errors", () => {
  const engine = parseSemver("0.1.7")!;
  assert.equal(checkEngineFloor(undefined, engine).ok, true);
  assert.equal(checkEngineFloor("", engine).ok, true);
  const below = checkEngineFloor("99.0.0", engine);
  assert.equal(below.ok, false);
  assert.match(below.reason ?? "", /below declared engine.min/);
  assert.equal(checkEngineFloor("0.0.1", engine).ok, true);
  const invalid = checkEngineFloor("garbage", engine);
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason ?? "", /Invalid engine.min/);
});

test("readEngineVersionFromFile reads this package's version", () => {
  const version = readEngineVersionFromFile(join(process.cwd(), "package.json"));
  assert.ok(version, "package.json version should parse");
  assert.ok(Number.isFinite((version as { major: number }).major), "parsed semver has a numeric major");
  assert.ok(Number.isFinite((version as { minor: number }).minor), "parsed semver has a numeric minor");
  assert.ok(Number.isFinite((version as { patch: number }).patch), "parsed semver has a numeric patch");
  // Deliberately not pinned to a literal version: a normal package bump must not break this test.
});

test("loader warns + skips a descriptor whose engine.min is above the running engine", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-engine-floor-"));
  const warnings: string[] = [];
  writeDescriptor(dir, "below.json", {
    schemaVersion: 1,
    id: "below",
    harness_type: "pi",
    engine: { min: "99.0.0" },
  });
  writeDescriptor(dir, "ok.json", {
    schemaVersion: 1,
    id: "ok",
    harness_type: "pi",
    engine: { min: "0.0.1" },
  });
  const registry = loadHarnessConfigRegistry("/unused", {
    projectDir: dir,
    userDir: dir,
    engineVersion: parseSemver("0.1.7"),
    onWarning: (message) => warnings.push(message),
  });
  assert.ok(registry.has("ok"), "descriptor within floor loads");
  // #87: a below-floor descriptor is retained as skipped (so an explicit --harness-config
  // can clean-skip with the reason) rather than dropped from the registry.
  assert.ok(registry.get("below")?.skipped, "below-floor descriptor is retained as skipped");
  assert.equal(registry.get("below")?.skipped && registry.get("below")?.harness_type === "pi", true);
  assert.ok(
    warnings.some((message) => message.includes("below declared engine.min")),
    "below-floor skip is warned",
  );
});

test("loader accepts a schemaVersion range and warns on deprecated versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-schema-range-"));
  const warnings: string[] = [];
  writeDescriptor(dir, "old.json", { schemaVersion: 1, id: "old", harness_type: "pi" });
  writeDescriptor(dir, "new.json", { schemaVersion: 2, id: "new", harness_type: "pi" });
  writeDescriptor(dir, "future.json", { schemaVersion: 3, id: "future", harness_type: "pi" });
  const registry = loadHarnessConfigRegistry("/unused", {
    projectDir: dir,
    userDir: dir,
    engineVersion: parseSemver("0.1.7"),
    supportedSchemaVersions: [1, 2],
    deprecatedSchemaVersions: [1],
    onWarning: (message) => warnings.push(message),
  });
  assert.ok(registry.has("old"), "deprecated-but-supported version still loads");
  assert.ok(registry.has("new"), "current version loads");
  assert.equal(registry.has("future"), false, "unsupported future version is skipped");
  assert.ok(
    warnings.some((message) => /Deprecated schemaVersion 1/.test(message)),
    "deprecated version emits a deprecation warning",
  );
  assert.ok(
    warnings.some((message) => /unsupported harness_config descriptor/.test(message) && message.includes("future")),
    "unsupported version skip is warned",
  );
});

test("parseHarnessConfigDescriptor preserves engine.min and rejects unsupported schemaVersion by default", () => {
  const config = parseHarnessConfigDescriptor(
    JSON.stringify({ schemaVersion: 1, id: "x", harness_type: "pi", engine: { min: "0.1.0" } }),
    "project",
  );
  assert.equal(config?.engineMin, "0.1.0");
  assert.equal(config?.schemaVersion, 1);
  assert.equal(
    parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 2, id: "x" }), "project"),
    null,
    "default supported set is [1], so 2 is rejected",
  );
  assert.equal(
    parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 1, id: "x" }), "project")?.schemaVersion,
    1,
  );
  assert.deepEqual([...DEFAULT_SUPPORTED_SCHEMA_VERSIONS], [1]);
});

test("validate-harness returns non-zero on a broken/incompatible descriptor without spawning agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-harness-"));
  const valid = writeDescriptor(dir, "valid.json", { schemaVersion: 1, id: "valid", harness_type: "pi" });
  const brokenSchema = writeDescriptor(dir, "broken.json", { schemaVersion: 99, id: "broken", harness_type: "pi" });
  const belowFloor = writeDescriptor(dir, "below.json", {
    schemaVersion: 1,
    id: "below",
    harness_type: "pi",
    engine: { min: "99.0.0" },
  });

  const validResult = validateHarnessFile(valid, { engineVersion: parseSemver("0.1.7") });
  assert.equal(validResult.ok, true, "valid descriptor passes");
  // No agents spawned: validateHarnessFile is synchronous and returns a plain object, never a Promise.
  assert.ok(!(validResult instanceof Promise), "validate-harness must not be async / must not spawn agents");

  const brokenResult = validateHarnessFile(brokenSchema, { engineVersion: parseSemver("0.1.7") });
  assert.equal(brokenResult.ok, false, "unsupported schemaVersion fails");
  assert.match(brokenResult.findings[0]?.message ?? "", /Unsupported schemaVersion/);

  const belowResult = validateHarnessFile(belowFloor, { engineVersion: parseSemver("0.1.7") });
  assert.equal(belowResult.ok, false, "below engine.min fails");
  assert.match(belowResult.findings.find((f) => f.level === "error")?.message ?? "", /engine.min/);

  const run = runValidateHarness([valid, belowFloor], { engineVersion: parseSemver("0.1.7") });
  assert.equal(run.exitCode, 1, "non-zero exit when any descriptor fails");
  const runAllOk = runValidateHarness([valid], { engineVersion: parseSemver("0.1.7") });
  assert.equal(runAllOk.exitCode, 0, "zero exit when all descriptors pass");
  assert.equal(runValidateHarness([]).exitCode, 2, "usage error is non-zero");
});

test("loader warns + skips a descriptor whose engine.min is a non-string value", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-engine-malformed-"));
  const warnings: string[] = [];
  writeDescriptor(dir, "malformed.json", {
    schemaVersion: 1,
    id: "malformed",
    harness_type: "pi",
    engine: { min: 99 },
  });
  const registry = loadHarnessConfigRegistry("/unused", {
    projectDir: dir,
    userDir: dir,
    engineVersion: sem("0.1.7"),
    onWarning: (message) => warnings.push(message),
  });
  assert.ok(registry.get("malformed")?.skipped, "malformed engine.min descriptor is retained as skipped");
  assert.ok(
    warnings.some((message) => /engine\.min must be a semver string/.test(message)),
    "malformed engine.min is warned",
  );
  const result = validateHarnessFile(join(dir, "malformed.json"), { engineVersion: sem("0.1.7") });
  assert.equal(result.ok, false, "validator fails on malformed engine.min");
  assert.match(result.findings.find((f) => f.level === "error")?.message ?? "", /engine\.min/);
});

// PR #108 finding 3: validate-harness must flag malformed requiredTools/preferredTools
// (including an explicit null), not just malformed engine.min. A present non-array
// would silently drop the requirement and bypass the clean-skip/degrade gate.
test("validate-harness fails on malformed requiredTools and preferredTools (incl. null)", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-harness-tool-malformed-"));
  const badReq = writeDescriptor(dir, "badreq.json", {
    schemaVersion: 1,
    id: "badreq",
    harness_type: "pi",
    requiredTools: "web_search",
  });
  const badPref = writeDescriptor(dir, "badpref.json", {
    schemaVersion: 1,
    id: "badpref",
    harness_type: "pi",
    preferredTools: ["read", 1],
  });
  const nullReq = writeDescriptor(dir, "nullreq.json", {
    schemaVersion: 1,
    id: "nullreq",
    harness_type: "pi",
    requiredTools: null,
  });
  const ok = writeDescriptor(dir, "ok.json", {
    schemaVersion: 1,
    id: "ok",
    harness_type: "pi",
    requiredTools: ["read", "bash"],
  });

  const reqResult = validateHarnessFile(badReq, { engineVersion: sem("0.1.7") });
  assert.equal(reqResult.ok, false, "malformed requiredTools fails validate-harness");
  assert.match(
    reqResult.findings.find((f) => f.level === "error")?.message ?? "",
    /requiredTools must be a non-empty string array/,
  );

  const prefResult = validateHarnessFile(badPref, { engineVersion: sem("0.1.7") });
  assert.equal(prefResult.ok, false, "malformed preferredTools fails validate-harness");
  assert.match(
    prefResult.findings.find((f) => f.level === "error")?.message ?? "",
    /preferredTools must be a non-empty string array/,
  );

  const nullResult = validateHarnessFile(nullReq, { engineVersion: sem("0.1.7") });
  assert.equal(nullResult.ok, false, "null requiredTools fails validate-harness");
  assert.match(
    nullResult.findings.find((f) => f.level === "error")?.message ?? "",
    /requiredTools must be a non-empty string array/,
  );

  // A well-formed non-empty string array still passes.
  const okResult = validateHarnessFile(ok, { engineVersion: sem("0.1.7") });
  assert.equal(okResult.ok, true, "well-formed requiredTools passes validate-harness");

  // The CLI exit code is non-zero when any descriptor has malformed tool lists.
  const run = runValidateHarness([badReq, badPref, nullReq, ok], { engineVersion: sem("0.1.7") });
  assert.equal(run.exitCode, 1, "CLI exits non-zero when any descriptor has malformed tool lists");
});

test("validate-harness checks a linked workflow script's meta.engine.min floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-harness-meta-floor-"));
  const descriptor = writeDescriptor(dir, "ok.json", {
    schemaVersion: 1,
    id: "ok",
    harness_type: "pi",
    script: "bench.js",
  });
  writeFileSync(
    join(dir, "bench.js"),
    "export const meta = { name: 'bench', description: 'x', engine: { min: '99.0.0' } }\nreturn 1\n",
  );
  const result = validateHarnessFile(descriptor, { engineVersion: sem("0.1.7") });
  assert.equal(result.ok, false, "script meta engine.min above running engine fails");
  assert.match(result.findings.find((f) => f.level === "error")?.message ?? "", /Workflow meta engine\.min/);
});

test("runValidateHarness applies a --script override and validates multiple descriptors", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-harness-cli-"));
  const descriptor = writeDescriptor(dir, "ok.json", { schemaVersion: 1, id: "ok", harness_type: "pi" });
  const second = writeDescriptor(dir, "second.json", { schemaVersion: 1, id: "second", harness_type: "pi" });
  const goodScript = join(dir, "good.js");
  writeFileSync(goodScript, "export const meta = { name: 'g', description: 'x' }\nreturn 1\n");
  // --script override applies to the descriptor; multiple positional args are all descriptors.
  const okRun = runValidateHarness([descriptor, second, "--script", goodScript], {
    engineVersion: sem("0.1.7"),
  });
  assert.equal(okRun.exitCode, 0, "valid descriptors + valid --script pass");
  assert.equal(okRun.results.length, 2, "both descriptors are validated, not treated as a descriptor+script pair");
  const badScript = join(dir, "bad.js");
  writeFileSync(
    badScript,
    "export const meta = { name: 'b', description: 'x', engine: { min: '99.0.0' } }\nreturn 1\n",
  );
  const badRun = runValidateHarness([descriptor, "--script", badScript], { engineVersion: sem("0.1.7") });
  assert.equal(badRun.exitCode, 1, "--script override's meta floor is checked");
  // Non-string meta.engine.min is rejected, not silently ignored.
  const nonStringScript = join(dir, "nonstring.js");
  writeFileSync(
    nonStringScript,
    "export const meta = { name: 'n', description: 'x', engine: { min: 99 } }\nreturn 1\n",
  );
  const nonStringRun = runValidateHarness([descriptor, "--script", nonStringScript], {
    engineVersion: sem("0.1.7"),
  });
  assert.equal(nonStringRun.exitCode, 1, "non-string meta engine.min is an error");
  // Missing --script value is a usage error, not silently ignored.
  assert.equal(runValidateHarness([descriptor, "--script"], { engineVersion: sem("0.1.7") }).exitCode, 2);
  assert.equal(runValidateHarness([descriptor, "--script="], { engineVersion: sem("0.1.7") }).exitCode, 2);
});

test("validate-harness API is exported from the package entry point", () => {
  assert.equal(typeof exportedValidateHarnessFile, "function");
  assert.equal(typeof exportedRunValidateHarness, "function");
  assert.equal(typeof parseSemver, "function");
});

test("validate-harness CLI bin exits 0 on a valid descriptor and non-zero on a missing one", async () => {
  const { spawnSync } = await import("node:child_process");
  // Run the SOURCE CLI via the tsx loader (dist/ is gitignored and not built by targeted test:unit).
  const cli = join(process.cwd(), "src", "validate-harness-cli.ts");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf-8" });
  const dir = mkdtempSync(join(tmpdir(), "vh-cli-"));
  const valid = writeDescriptor(dir, "valid.json", { schemaVersion: 1, id: "valid", harness_type: "pi" });
  const ok = run([valid]);
  assert.equal(ok.status, 0, "CLI exits 0 on a valid descriptor");
  const bad = run([join(dir, "missing.json")]);
  assert.equal(bad.status, 1, "CLI exits non-zero on a missing descriptor");
  assert.match(bad.stdout ?? "", /FAIL/, "CLI prints a FAIL line for the missing descriptor");
});
