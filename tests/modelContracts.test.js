import test from "node:test";
import assert from "node:assert/strict";
import { parseStrictRerankerJson } from "../storage/modelContracts.js";

test("parseStrictRerankerJson: valid contract", () => {
  const raw = JSON.stringify({
    suggested_answer: "b",
    confidence: 0.73,
    evidence_basis: "Matched option cues and subject constraints",
    matched_question_ids: ["q1", "q2"],
    insufficient_evidence: false,
  });

  const out = parseStrictRerankerJson(raw);
  assert.equal(out.suggested_answer, "B");
  assert.equal(out.confidence, 0.73);
  assert.equal(out.matched_question_ids.length, 2);
  assert.equal(out.insufficient_evidence, false);
});

test("parseStrictRerankerJson: rejects non-JSON (regression vs unsafe parsing)", () => {
  assert.throws(() => parseStrictRerankerJson("D"), /JSON/i);
  assert.throws(() => parseStrictRerankerJson("D)"), /JSON/i);
});

test("parseStrictRerankerJson: rejects invalid confidence bounds", () => {
  const raw = JSON.stringify({
    suggested_answer: "A",
    confidence: 1.5,
    evidence_basis: "Enough evidence basis text",
    matched_question_ids: ["q1"],
    insufficient_evidence: false,
  });
  assert.throws(() => parseStrictRerankerJson(raw), /confidence/i);
});

test("parseStrictRerankerJson: insufficient_evidence requires low confidence", () => {
  const raw = JSON.stringify({
    suggested_answer: "C",
    confidence: 0.9,
    evidence_basis: "Not enough evidence but model too confident",
    matched_question_ids: [],
    insufficient_evidence: true,
  });
  assert.throws(() => parseStrictRerankerJson(raw), /insufficient_evidence/i);
});

