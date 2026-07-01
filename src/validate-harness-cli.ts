#!/usr/bin/env node
/**
 * `validate-harness` CLI — load+parse smoke gate for harness_config descriptors
 * (and optional linked workflow scripts) without spawning agents. Non-zero exit
 * on any error. See docs/repo-harness-bootstrapping.md and docs/harness-engine-compat.md.
 */
import { runValidateHarness } from "./validate-harness.js";

const result = runValidateHarness(process.argv.slice(2));
if (result.report) {
  console.log(result.report);
}
process.exit(result.exitCode);
