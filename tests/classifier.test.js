import test from "node:test";
import assert from "node:assert/strict";
import { classifyQuestion } from "../storage/atplClassifier.js";

test("classifyQuestion: detects electrical theory from Ohm's law cues", () => {
  const out = classifyQuestion({
    externalId: "021.09 Part 5 Q0012 :",
    questionText: "In accordance with Ohm's law, which statement is correct?",
    options: {
      A: "The current is proportional to voltage.",
      B: "Resistance equals voltage times current.",
      C: "Voltage equals current divided by resistance.",
      D: "Voltage equals current times resistance.",
    },
  });

  assert.equal(out.subject_code, "aircraft_electrical");
  assert.equal(out.topic_code, "electrical_theory");
  assert.ok(out.classification_confidence >= 0.6);
});

test("classifyQuestion: detects distribution & protection via busbar cues", () => {
  const out = classifyQuestion({
    externalId: "021.09 Part 5 Q0020 :",
    questionText:
      "A busbar provides a maintenance bus connection in the aircraft electrical switchboard, ensuring load shedding during a short circuit.",
    options: {
      A: "A maintenance bus conductor feeding a circuit breaker for load shedding.",
      B: "A method for storing energy in capacitors.",
      C: "A system for plotting weather.",
      D: "A navigation procedure unrelated to electrical protection.",
    },
  });

  assert.equal(out.subject_code, "aircraft_electrical");
  assert.equal(out.topic_code, "distribution_protection");
});

