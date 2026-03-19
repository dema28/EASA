import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import { initSqliteStore } from "../storage/sqliteStore.js";
import { makeTempDir, writeJson } from "./testUtils.js";

function buildFixtureRow({ id, question, a, b, c, d, correct }) {
  return { id, question, a, b, c, d, correct };
}

test("initSqliteStore: migrates questions.json and collapses duplicates by fingerprint", () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, "test.sqlite");
  const questionsJsonPath = path.join(tmpDir, "questions.json");

  const row1 = buildFixtureRow({
    id: "QX1",
    question: "In accordance with Ohm's law, which statement is correct?",
    a: "The current is proportional to voltage.",
    b: "Resistance equals voltage times current.",
    c: "Voltage equals current divided by resistance.",
    d: "Voltage equals current times resistance.",
    correct: "D",
  });
  const row2 = buildFixtureRow({
    id: "QX2",
    question: "In accordance with Ohm's law, which statement is correct?",
    a: "The current is proportional to voltage.",
    b: "Resistance equals voltage times current.",
    c: "Voltage equals current divided by resistance.",
    d: "Voltage equals current times resistance.",
    correct: "D",
  });

  writeJson(questionsJsonPath, [row1, row2]);

  const store = initSqliteStore({ dbPath, questionsJsonPath });
  const active = store.getActiveQuestions();
  assert.equal(active.length, 1);
  assert.equal(active[0].subject_code, "aircraft_electrical");
  assert.equal(active[0].topic_code, "electrical_theory");
});

test("saveActiveQuestions: collapses identical questions (regression against multi-row duplicates)", () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, "test2.sqlite");
  const questionsJsonPath = path.join(tmpDir, "questions.json");
  writeJson(questionsJsonPath, []); // keep DB empty initially

  const store = initSqliteStore({ dbPath, questionsJsonPath });

  store.saveActiveQuestions({
    rows: [
      buildFixtureRow({
        id: "QY1",
        question:
          "A busbar provides a maintenance bus connection in the aircraft electrical switchboard, ensuring load shedding during a short circuit.",
        a: "A maintenance bus conductor feeding a circuit breaker for load shedding.",
        b: "A method for storing energy in capacitors.",
        c: "A system for plotting weather.",
        d: "A navigation procedure unrelated to electrical protection.",
        correct: "A",
      }),
      buildFixtureRow({
        id: "QY2",
        question:
          "A busbar provides a maintenance bus connection in the aircraft electrical switchboard, ensuring load shedding during a short circuit.",
        a: "A maintenance bus conductor feeding a circuit breaker for load shedding.",
        b: "A method for storing energy in capacitors.",
        c: "A system for plotting weather.",
        d: "A navigation procedure unrelated to electrical protection.",
        correct: "A",
      }),
    ],
  });

  const active = store.getActiveQuestions();
  assert.equal(active.length, 1);
  assert.equal(active[0].subject_code, "aircraft_electrical");
  assert.equal(active[0].topic_code, "distribution_protection");
});

test("setQuestionVerificationByExternalId: toggles is_verified and source_type", () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, "test3.sqlite");
  const questionsJsonPath = path.join(tmpDir, "questions.json");
  writeJson(questionsJsonPath, []);

  const store = initSqliteStore({ dbPath, questionsJsonPath });
  const seed = buildFixtureRow({
    id: "QV1",
    question:
      "A busbar provides a maintenance bus connection in the aircraft electrical switchboard, ensuring load shedding during a short circuit.",
    a: "A maintenance bus conductor feeding a circuit breaker for load shedding.",
    b: "A method for storing energy in capacitors.",
    c: "A system for plotting weather.",
    d: "A navigation procedure unrelated to electrical protection.",
    correct: "A",
  });
  store.saveActiveQuestions({ rows: [seed] });

  const before = store.getActiveQuestions().find((q) => q.id === "QV1");
  assert.ok(before);
  assert.equal(Boolean(before.is_verified), true); // saveActiveQuestions treats manual/imported as verified

  const changed = store.setQuestionVerificationByExternalId({
    externalId: "QV1",
    verified: false,
    unverifiedSourceType: "AI_inferred_needs_review",
  });
  assert.ok(changed.changedRows >= 1);

  const after = store.getActiveQuestions().find((q) => q.id === "QV1");
  assert.equal(Boolean(after.is_verified), false);
  assert.equal(after.source_type, "AI_inferred_needs_review");
});

