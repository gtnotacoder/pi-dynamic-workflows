#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(root, "docs/workflows/workflow-lock.json");
const strict = process.argv.includes("--strict");
const messages = [];

function add(severity, text) {
  messages.push({ severity, text });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expandSource(source) {
  if (typeof source !== "string" || source.length === 0) return null;
  if (source.startsWith("~/")) return null;
  if (isAbsolute(source)) return source;
  return resolve(root, source);
}

function isInsideRoot(path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (error) {
  console.error(`workflow-lock: failed to read ${lockPath}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

if (!isRecord(lock)) {
  console.error("workflow-lock: lock file must be a JSON object");
  process.exit(1);
}

if (lock.schema !== "pi-dynamic-workflows.workflow-lock.v1") {
  add("error", `unexpected schema ${JSON.stringify(lock.schema)}`);
}

if (!Array.isArray(lock.entries)) {
  add("error", "entries must be an array");
} else {
  const commands = new Map();
  const canonicals = new Map();

  for (const [index, entry] of lock.entries.entries()) {
    const label = isRecord(entry) && typeof entry.canonicalName === "string" ? entry.canonicalName : `entry[${index}]`;
    if (!isRecord(entry)) {
      add("error", `entry[${index}] must be an object`);
      continue;
    }

    if (typeof entry.canonicalName !== "string" || !entry.canonicalName)
      add("error", `${label}: missing canonicalName`);
    if (typeof entry.command !== "string" || !entry.command.startsWith("/")) {
      add("error", `${label}: command must start with /`);
    }
    if (typeof entry.kind !== "string" || !entry.kind) add("error", `${label}: missing kind`);
    if (typeof entry.source !== "string" || !entry.source) add("error", `${label}: missing source`);

    if (typeof entry.canonicalName === "string") {
      if (canonicals.has(entry.canonicalName)) add("error", `${label}: duplicate canonicalName`);
      canonicals.set(entry.canonicalName, label);
    }

    if (typeof entry.command === "string") {
      if (commands.has(entry.command)) add("error", `${label}: duplicate command ${entry.command}`);
      commands.set(entry.command, label);
    }

    if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) {
      add("error", `${label}: aliases must be an array when present`);
    }
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
      if (typeof alias !== "string" || !alias.startsWith("/")) add("error", `${label}: alias must start with /`);
      if (typeof alias === "string" && commands.has(alias)) {
        add("warning", `${label}: alias ${alias} is also registered as ${commands.get(alias)}`);
      }
    }

    const expanded = expandSource(entry.source);
    if (!expanded) {
      add("warning", `${label}: external source ${entry.source} is recorded but not hashed by this repo-local check`);
      continue;
    }

    if (!existsSync(expanded)) {
      add("warning", `${label}: source does not exist at ${entry.source}`);
      continue;
    }

    if (!isInsideRoot(expanded)) {
      add("warning", `${label}: source is outside the repository and was not hashed`);
      continue;
    }

    const actual = sha256(expanded);
    if (typeof entry.sha256 !== "string" || !entry.sha256) {
      add("warning", `${label}: repo-local source ${entry.source} has no sha256 in the lock`);
    } else if (entry.sha256 !== actual) {
      add("error", `${label}: sha256 drift for ${entry.source}: expected ${entry.sha256}, actual ${actual}`);
    }
  }
}

const errors = messages.filter((m) => m.severity === "error");
const warnings = messages.filter((m) => m.severity === "warning");

for (const message of messages) {
  const prefix = message.severity === "error" ? "ERROR" : "WARN";
  console.log(`${prefix}: ${message.text}`);
}

const mode = strict || lock.mode === "strict" ? "strict" : "warning";
console.log(
  `workflow-lock: checked ${Array.isArray(lock.entries) ? lock.entries.length : 0} entries with ${errors.length} error(s), ${warnings.length} warning(s), mode=${mode}`,
);

if (errors.length > 0 && mode === "strict") process.exit(1);
