import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { filterSkillsByName } from "../src/context-mode.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/**
 * Per-agent skills allowlist — `agent(prompt, { skills: ["name", ...] })`.
 *
 * Coverage:
 *   1. filterSkillsByName (pure) — filters by name, reports unknowns, [] ⇒ zero skills.
 *   2. Workflow-layer threading — `skills` is forwarded verbatim to the agent runner
 *      (undefined preserves today's behavior; [] is a fence that means zero skills).
 *   3. Resume identity — changing the allowlist busts the cached result.
 *   4. End-to-end loader wiring — a real DefaultResourceLoader built exactly as
 *      WorkflowAgent.run builds it (noSkills:false + skillsOverride filter) loads
 *      ONLY the named skills; an empty allowlist loads ZERO skills; absence of the
 *      option preserves the full skill set.
 */

// ── 1. filterSkillsByName: the pure enforcement helper ───────────────────────

describe("filterSkillsByName", () => {
  it("keeps only skills whose name appears in the allowlist", () => {
    const discovered = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
    const { skills, unknown } = filterSkillsByName(discovered, ["alpha", "gamma"]);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["alpha", "gamma"],
    );
    assert.deepEqual(unknown, []);
  });

  it("reports names that matched nothing (caller warns, never fails)", () => {
    const discovered = [{ name: "alpha" }];
    const { skills, unknown } = filterSkillsByName(discovered, ["alpha", "nope", "also-missing"]);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["alpha"],
    );
    assert.deepEqual(unknown, ["nope", "also-missing"]);
  });

  it("an empty allowlist is a fence: zero skills, NOT all skills", () => {
    const discovered = [{ name: "alpha" }, { name: "beta" }];
    const { skills, unknown } = filterSkillsByName(discovered, []);
    assert.equal(skills.length, 0);
    assert.deepEqual(unknown, []);
  });

  it("preserves discovery order (does not reorder by allowlist)", () => {
    const discovered = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const { skills } = filterSkillsByName(discovered, ["c", "a"]);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["a", "c"],
    );
  });
});

// ── 2. Workflow-layer threading: agent() → agentRunner.run ───────────────────

interface CapturedCall {
  label: string | undefined;
  skills: readonly string[] | undefined;
}

function capturingRunner(calls: CapturedCall[]) {
  return {
    async run(prompt: string, options: Record<string, unknown>) {
      // The workflow VM hands us sandbox-realm arrays whose prototype differs from
      // the host Array.prototype, so assert/strict deepEqual flags them as
      // "same structure but not reference-equal". Coerce to a host array (or
      // undefined) before capturing so deepStrictEqual compares values, not realms.
      const raw = options.skills;
      const skills = Array.isArray(raw) ? Array.from(raw as Iterable<string>) : (raw as string[] | undefined);
      calls.push({
        label: options.label as string | undefined,
        skills,
      });
      return `ran:${prompt}`;
    },
  };
}

test("agent() threads `skills` through to the runner verbatim (undefined when absent)", async () => {
  const calls: CapturedCall[] = [];
  await runWorkflow(
    `export const meta = { name: 'skills_threading_absent', description: 'absent' }
const a = await agent('step', { label: 'a' })
return a`,
    { agent: capturingRunner(calls), concurrency: 1, persistLogs: false },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skills, undefined, "absence of the option preserves today's behavior");
});

test("agent() threads a non-empty `skills` allowlist through to the runner", async () => {
  const calls: CapturedCall[] = [];
  await runWorkflow(
    `export const meta = { name: 'skills_threading_named', description: 'named' }
const a = await agent('step', { label: 'a', skills: ['langfuse', 'shadcn'] })
return a`,
    { agent: capturingRunner(calls), concurrency: 1, persistLogs: false },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].skills, ["langfuse", "shadcn"]);
});

test("agent() threads an empty `skills` array through (fence → zero skills, not 'all')", async () => {
  const calls: CapturedCall[] = [];
  await runWorkflow(
    `export const meta = { name: 'skills_threading_empty', description: 'empty' }
const a = await agent('step', { label: 'a', skills: [] })
return a`,
    { agent: capturingRunner(calls), concurrency: 1, persistLogs: false },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].skills, []);
});

// ── 3. Resume identity: changing the allowlist busts the cache ───────────────

test("resume: a cached result under one skills allowlist does NOT replay after the allowlist changes", async () => {
  const script = `export const meta = { name: 'skills_resume', description: 'resume' }
const a = await agent('step', { label: 'a', skills: SKILLS })
return a`;
  const journal: JournalEntry[] = [];
  const first: CapturedCall[] = [];
  // Phase 1: allowlist ['alpha'] — runs live and is journaled.
  await runWorkflow(script.replace("SKILLS", "['alpha']"), {
    agent: capturingRunner(first),
    concurrency: 1,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(first.length, 1, "phase 1: the agent ran live");

  // Phase 2: same script + journal, but allowlist ['beta']. The hash must NOT match
  // and the call must run live instead of replaying the cached result.
  const second: CapturedCall[] = [];
  await runWorkflow(script.replace("SKILLS", "['beta']"), {
    agent: capturingRunner(second),
    concurrency: 1,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.length, 1, "phase 2: allowlist changed ⇒ cache miss ⇒ live re-run");
  assert.deepEqual(second[0].skills, ["beta"]);
});

test("resume: an unchanged allowlist replays the cached result (cache hit)", async () => {
  const script = `export const meta = { name: 'skills_resume_hit', description: 'resume hit' }
const a = await agent('step', { label: 'a', skills: ['alpha'] })
return a`;
  const journal: JournalEntry[] = [];
  const first: CapturedCall[] = [];
  await runWorkflow(script, {
    agent: capturingRunner(first),
    concurrency: 1,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(first.length, 1, "phase 1: ran live");

  const second: CapturedCall[] = [];
  await runWorkflow(script, {
    agent: capturingRunner(second),
    concurrency: 1,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.length, 0, "phase 2: unchanged allowlist ⇒ cache hit ⇒ no live run");
});

// ── 4. End-to-end loader wiring: real DefaultResourceLoader built as the agent does ──

/**
 * Write three real skill files (alpha/beta/gamma) into the fake home's
 * `~/.pi/agent/skills/<name>/SKILL.md`. Each has a frontmatter `name` so the SDK
 * loader discovers them by name.
 */
function writeSkills(agentDir: string) {
  const skillsDir = join(agentDir, "skills");
  for (const name of ["alpha", "beta", "gamma"]) {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [`---`, `name: ${name}`, `description: ${name} skill`, `---`, `# ${name}`, `Body for ${name}.`].join("\n"),
      "utf-8",
    );
  }
  return skillsDir;
}

/**
 * Build a DefaultResourceLoader EXACTLY as WorkflowAgent.run builds it for an
 * active skills allowlist (noSkills:false + skillsOverride filter by name), so
 * the SDK wiring — not just the pure helper — is exercised. Uses a real
 * SettingsManager and a fake home so real skill files are discovered.
 */
function buildLoaderAsAgent(
  cwd: string,
  settingsManager: SettingsManager,
  skillsAllowlist: string[] | undefined,
): DefaultResourceLoader {
  const noSkills = skillsAllowlist !== undefined && skillsAllowlist.length === 0;
  const skillsOverride =
    skillsAllowlist !== undefined && skillsAllowlist.length > 0
      ? (base: { skills: { name: string }[]; diagnostics: unknown }) => {
          const filtered = filterSkillsByName(base.skills, skillsAllowlist);
          for (const name of filtered.unknown) {
            // Mirror the agent's warn (do not fail) behavior.
            // eslint-disable-next-line no-console
            console.warn(`[workflow] skills allowlist: no skill named "${name}" (skipped)`);
          }
          return { skills: filtered.skills, diagnostics: base.diagnostics } as typeof base;
        }
      : undefined;
  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noSkills,
    ...(skillsOverride ? { skillsOverride: skillsOverride as never } : {}),
  });
}

async function withSkillSandbox(fn: (cwd: string, settingsManager: SettingsManager) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-skills-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-skills-home-"));
  await withFakeHomeAsync(fakeHome, async () => {
    const agentDir = getAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeSkills(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    await settingsManager.reload();
    await fn(cwd, settingsManager);
  });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}

test("end-to-end: a non-empty skills allowlist loads ONLY the named skills", async () => {
  await withSkillSandbox(async (cwd, settingsManager) => {
    const loader = buildLoaderAsAgent(cwd, settingsManager, ["alpha", "gamma"]);
    await loader.reload();
    const { skills } = loader.getSkills();
    assert.deepEqual(skills.map((s) => s.name).sort(), ["alpha", "gamma"], "only the named skills are loaded");
  });
});

test("end-to-end: an empty skills allowlist loads ZERO skills (fence)", async () => {
  await withSkillSandbox(async (cwd, settingsManager) => {
    const loader = buildLoaderAsAgent(cwd, settingsManager, []);
    await loader.reload();
    const { skills } = loader.getSkills();
    assert.equal(skills.length, 0, "an empty allowlist yields zero skills, not all skills");
  });
});

test("end-to-end: absence of the allowlist preserves the full discovered skill set (today's behavior)", async () => {
  await withSkillSandbox(async (cwd, settingsManager) => {
    const loader = buildLoaderAsAgent(cwd, settingsManager, undefined);
    await loader.reload();
    const { skills } = loader.getSkills();
    assert.deepEqual(
      skills.map((s) => s.name).sort(),
      ["alpha", "beta", "gamma"],
      "all discovered skills load when the allowlist is absent",
    );
  });
});

test("end-to-end: an allowlist with unknown names loads the known ones and warns (no failure)", async () => {
  await withSkillSandbox(async (cwd, settingsManager) => {
    const loader = buildLoaderAsAgent(cwd, settingsManager, ["alpha", "nope"]);
    await loader.reload();
    const { skills } = loader.getSkills();
    assert.deepEqual(
      skills.map((s) => s.name),
      ["alpha"],
      "the known name loads; the unknown name is skipped, not a failure",
    );
  });
});
