/// <reference types="node" />

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { guardCtxReadPath } from "../src/lean-ctx-guardrail.js";

const cwd = join(process.cwd(), "tests/fixtures/lean-ctx-guardrail");

test("guardCtxReadPath rejects invalid and escaping paths before filesystem probing", () => {
  const calls: string[] = [];
  const exists = (path: string) => {
    calls.push(path);
    return true;
  };

  assert.equal(guardCtxReadPath("", { cwd, exists }).kind, "invalid");
  assert.equal(guardCtxReadPath("-rf", { cwd, exists }).kind, "invalid");
  assert.equal(guardCtxReadPath("bad\u0000path", { cwd, exists }).kind, "invalid");
  assert.equal(guardCtxReadPath("../outside.ts", { cwd, exists }).kind, "invalid");
  assert.deepEqual(calls, [], "invalid paths should not touch the filesystem");
});

test("guardCtxReadPath rejects directory reads with concise listing and index-file hints", () => {
  const outcome = guardCtxReadPath("components/Button", { cwd });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "directory");
  assert.equal(outcome.normalizedPath, "components/Button");
  assert.match(outcome.reason, /directory/i);
  assert.match(outcome.fallbackHint ?? "", /components\/Button\/index\.tsx/);
  assert.match(outcome.fallbackHint ?? "", /ctx_ls/);
});

test("guardCtxReadPath returns missing with fffind/ctx_grep fallback instead of probing bridge reads", () => {
  const outcome = guardCtxReadPath("components/DoesNotExist.ts", { cwd });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing");
  assert.equal(outcome.normalizedPath, "components/DoesNotExist.ts");
  assert.match(outcome.fallbackHint ?? "", /fffind DoesNotExist\.ts/);
  assert.match(outcome.fallbackHint ?? "", /ctx_grep DoesNotExist\.ts/);
});

test("guardCtxReadPath resolves missing frontend component paths to directory-module index files", () => {
  const outcome = guardCtxReadPath("components/Button.tsx", { cwd });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, "frontendFallback");
  assert.equal(outcome.normalizedPath, "components/Button/index.tsx");
  assert.match(outcome.fallbackHint ?? "", /ctx_read components\/Button\/index\.tsx/);
});

test("guardCtxReadPath resolves missing frontend component paths to sibling extension variants", () => {
  const outcome = guardCtxReadPath("components/Card.tsx", { cwd });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, "frontendFallback");
  assert.equal(outcome.normalizedPath, "components/Card.jsx");
});

test("guardCtxReadPath skips package source internals before expensive reads when internals are disabled", () => {
  const outcome = guardCtxReadPath("web/node_modules/@tanstack/query-core/src/mutationObserver.ts", { cwd });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
  assert.match(outcome.reason, /Package internals/i);
  assert.match(outcome.fallbackHint ?? "", /web\/node_modules\/@tanstack\/query-core\/package\.json/);
});

test("guardCtxReadPath skips missing package internals even when the exact file is unavailable", () => {
  const outcome = guardCtxReadPath("web/node_modules/@tanstack/query-core/src/missingInternal.ts", { cwd });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
  assert.match(outcome.fallbackHint ?? "", /README\.md/);
});

test("guardCtxReadPath allows package internals only when explicitly enabled", () => {
  const outcome = guardCtxReadPath("web/node_modules/@tanstack/query-core/src/mutationObserver.ts", {
    cwd,
    allowPackageInternals: true,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, "file");
});

test("guardCtxReadPath allows package docs without source-mode opt-in", () => {
  const outcome = guardCtxReadPath("web/node_modules/@tanstack/query-core/README.md", { cwd });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, "file");
});

test("guardCtxReadPath rejects symlinks that resolve outside the repository", () => {
  const outcome = guardCtxReadPath("safe/link-to-secret.ts", {
    cwd: "/repo",
    exists: () => true,
    realpath: (path) => (path === "/repo" ? "/repo" : "/outside/secret.ts"),
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "invalid");
  assert.match(outcome.reason, /symlink|outside/i);
});

test("guardCtxReadPath blocks symlinks that resolve to package internals", () => {
  const outcome = guardCtxReadPath("app/vendor/Button.ts", {
    cwd: "/repo",
    exists: () => true,
    realpath: (path) => (path === "/repo" ? "/repo" : "/repo/web/node_modules/pkg/src/Button.ts"),
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
  assert.equal(outcome.normalizedPath, "web/node_modules/pkg/src/Button.ts");
});

test("guardCtxReadPath blocks package-internal directories even when directory reads are allowed", () => {
  const outcome = guardCtxReadPath("web/node_modules/@tanstack/query-core/src", {
    cwd,
    allowDirectory: true,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
});

test("guardCtxReadPath rejects non-regular filesystem entries", () => {
  const outcome = guardCtxReadPath("tmp/socket", {
    cwd: "/repo",
    exists: () => true,
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => false, isFile: () => false }),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "invalid");
  assert.match(outcome.reason, /regular file/i);
});

test("guardCtxReadPath validates frontend fallback candidates are regular files", () => {
  const outcome = guardCtxReadPath("components/Widget.tsx", {
    cwd: "/repo",
    exists: (path) => path === "/repo/components/Widget/index.tsx",
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => true, isFile: () => false }),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing");
});

test("guardCtxReadPath blocks frontend fallback candidates under package internals", () => {
  const outcome = guardCtxReadPath("web/node_modules/pkg/src.tsx", {
    cwd: "/repo",
    exists: (path) => path === "/repo/web/node_modules/pkg/src/index.tsx",
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
  assert.equal(outcome.normalizedPath, "web/node_modules/pkg/src/index.tsx");
});

test("guardCtxReadPath does not fall back missing components to parent index files", () => {
  const outcome = guardCtxReadPath("components/Buton.tsx", {
    cwd: "/repo",
    exists: (path) => path === "/repo/components/index.tsx",
    realpath: (path) => path,
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing");
});

test("guardCtxReadPath points nested node_modules hints at the matched package root", () => {
  const outcome = guardCtxReadPath("web/node_modules/.pnpm/@scope+pkg@1/node_modules/@scope/pkg/src/file.ts", {
    cwd,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
  assert.match(
    outcome.fallbackHint ?? "",
    /web\/node_modules\/\.pnpm\/@scope\+pkg@1\/node_modules\/@scope\/pkg\/package\.json/,
  );
});

test("guardCtxReadPath allows the repository root directory when directory reads are enabled", () => {
  const outcome = guardCtxReadPath(".", { cwd, allowDirectory: true });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, "directory");
  assert.equal(outcome.normalizedPath, ".");
});

test("guardCtxReadPath treats package build directories as package internals", () => {
  const outcome = guardCtxReadPath("web/node_modules/@tanstack/query-core/build/private.js", { cwd });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "packageInternal");
});
