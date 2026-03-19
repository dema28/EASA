import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { initSqliteStore } from "../storage/sqliteStore.js";
import { makeTempDir, writeJson } from "./testUtils.js";

test("retrieveSimilarQuestions: returns identical question despite option reordering (lexical ranking)", async () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, "rt.sqlite");
  const questionsJsonPath = path.join(tmpDir, "questions.json");
  writeJson(questionsJsonPath, []);

  const store = initSqliteStore({ dbPath, questionsJsonPath });

  store.saveActiveQuestions({
    rows: [
      {
        id: "R1",
        question: "In accordance with Ohm's law, which statement is correct?",
        a: "The current is proportional to voltage.",
        b: "Resistance equals voltage times current.",
        c: "Voltage equals current divided by resistance.",
        d: "Voltage equals current times resistance.",
        correct: "D",
        source_type: "manual",
        is_verified: true,
      },
      {
        id: "R2",
        question: "A busbar is used in an aircraft electrical system to distribute current.",
        a: "A connecting conductor in switchboard.",
        b: "A device to increase impedance.",
        c: "A method for storing energy in capacitors.",
        d: "A system for plotting weather.",
        correct: "A",
        source_type: "manual",
        is_verified: true,
      },
    ],
  });

  const reorderedQueryText = [
    "In accordance with Ohm's law, which statement is correct?",
    // Reordered options: correct option moved from D -> A
    "Voltage equals current times resistance.",
    "Resistance equals voltage times current.",
    "The current is proportional to voltage.",
    "Voltage equals current divided by resistance.",
  ].join("\n");

  const result = await store.retrieveSimilarQuestions({
    questionText: reorderedQueryText,
    topN: 1,
    semanticMode: "off",
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].matched_external_id, "R1");
  assert.equal(result.candidates[0].known_correct, "D");
  assert.equal(result.candidates[0].similarity_evidence.semantic_used, false);
  assert.ok(result.candidates[0].similarity_score >= 0.55);
});

test("retrieveSimilarQuestions: semanticMode=on without OPENAI key remains lexical-only (semantic_used=false)", async () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, "rt2.sqlite");
  const questionsJsonPath = path.join(tmpDir, "questions.json");
  writeJson(questionsJsonPath, []);

  const store = initSqliteStore({ dbPath, questionsJsonPath });
  store.saveActiveQuestions({
    rows: [
      {
        id: "S1",
        question: "In accordance with Ohm's law, which statement is correct?",
        a: "The current is proportional to voltage.",
        b: "Resistance equals voltage times current.",
        c: "Voltage equals current divided by resistance.",
        d: "Voltage equals current times resistance.",
        correct: "D",
        source_type: "manual",
        is_verified: true,
      },
    ],
  });

  const queryText = [
    "In accordance with Ohm's law, which statement is correct?",
    "The current is proportional to voltage.",
    "Resistance equals voltage times current.",
    "Voltage equals current divided by resistance.",
    "Voltage equals current times resistance.",
  ].join("\n");

  const result = await store.retrieveSimilarQuestions({
    questionText: queryText,
    topN: 1,
    semanticMode: "on",
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].matched_external_id, "S1");
  assert.equal(result.candidates[0].similarity_evidence.semantic_used, false);
});

