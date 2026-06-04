import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { extractValidated, resolveStructuredOutput, type StructuredSession } from "../src/agent.js";
import type { StructuredOutputCapture } from "../src/structured-output.js";

const Schema = Type.Object({ word: Type.String() });

describe("extractValidated", () => {
  it("extracts a fenced ```json block that validates", () => {
    assert.deepEqual(extractValidated('blah\n```json\n{"word":"hi"}\n```\nmore', Schema), { word: "hi" });
  });

  it("extracts a bare {...} object embedded in prose", () => {
    assert.deepEqual(extractValidated('here it is: {"word":"hi"} done', Schema), { word: "hi" });
  });

  it("coerces types toward the schema, then validates", () => {
    const NumSchema = Type.Object({ n: Type.Number() });
    assert.deepEqual(extractValidated('{"n":"5"}', NumSchema), { n: 5 });
  });

  it("returns undefined for prose with no JSON", () => {
    assert.equal(extractValidated("there is no json here", Schema), undefined);
  });

  it("returns undefined when the JSON does not satisfy the schema (no fabrication)", () => {
    assert.equal(extractValidated('{"notWord": 1}', Schema), undefined);
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(extractValidated("{word: ", Schema), undefined);
  });
});

describe("resolveStructuredOutput", () => {
  const opts = { maxSchemaRetries: 2 };
  const noText = () => "";

  function makeSession(behavior: { callAfter?: number } = {}): {
    session: StructuredSession;
    capture: StructuredOutputCapture<{ word: string }>;
    prompts: () => number;
  } {
    let prompts = 0;
    const capture: StructuredOutputCapture<{ word: string }> = { called: false, value: undefined };
    const session: StructuredSession = {
      async prompt() {
        prompts++;
        if (behavior.callAfter && prompts >= behavior.callAfter) {
          capture.called = true;
          capture.value = { word: "ok" };
        }
      },
      setActiveToolsByName() {},
      messages: [],
    };
    return { session, capture, prompts: () => prompts };
  }

  it("returns the captured value without re-prompting when already called", async () => {
    const { session, capture, prompts } = makeSession();
    capture.called = true;
    capture.value = { word: "done" };
    assert.deepEqual(await resolveStructuredOutput(session, capture, Schema, opts, noText), { word: "done" });
    assert.equal(prompts(), 0, "no repair prompts when already called");
  });

  it("recovers via a bounded repair re-prompt", async () => {
    const { session, capture, prompts } = makeSession({ callAfter: 1 });
    assert.deepEqual(await resolveStructuredOutput(session, capture, Schema, opts, noText), { word: "ok" });
    assert.equal(prompts(), 1, "one repair prompt recovered it");
  });

  it("falls back to strict prose extraction when repair fails", async () => {
    const { session, capture } = makeSession();
    const r = await resolveStructuredOutput(session, capture, Schema, opts, () => '{"word":"fromProse"}');
    assert.deepEqual(r, { word: "fromProse" });
  });

  it("throws SCHEMA_NONCOMPLIANCE when repair and extraction both fail", async () => {
    const { session, capture } = makeSession();
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, opts, () => "no json at all"),
      /structured_output/i,
    );
  });

  it("honors an aborted signal", async () => {
    const { session, capture } = makeSession();
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, { ...opts, signal: ctrl.signal }, noText),
      /aborted/i,
    );
  });
});
