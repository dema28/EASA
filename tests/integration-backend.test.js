import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { makeTempDir, writeJson } from "./testUtils.js";

test("backend integration: save/dedupe/retrieve/answer/review", async () => {
  const tmpDir = makeTempDir("easa-backend-");
  const dbPath = path.join(tmpDir, "backend.sqlite");
  const questionsJsonPath = path.join(tmpDir, "questions.json");
  writeJson(questionsJsonPath, []);

  // Ensure we don't accidentally call external providers.
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  const oldEnv = {
    EASA_START_SERVER: process.env.EASA_START_SERVER,
    EASA_DB_PATH: process.env.EASA_DB_PATH,
    EASA_QUESTIONS_JSON_PATH: process.env.EASA_QUESTIONS_JSON_PATH,
  };

  process.env.EASA_START_SERVER = "false";
  process.env.EASA_DB_PATH = dbPath;
  process.env.EASA_QUESTIONS_JSON_PATH = questionsJsonPath;

  try {
    const { app } = await import("../server.js");
    const server = app.listen(0);

    const addr = server.address();
    assert.ok(addr && typeof addr === "object" && typeof addr.port === "number");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // 1) Seed DB via API
    const saveResp = await fetch(`${baseUrl}/api/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          id: "INT1",
          question: "In accordance with Ohm's law, which statement is correct?",
          a: "The current is proportional to voltage.",
          b: "Resistance equals voltage times current.",
          c: "Voltage equals current divided by resistance.",
          d: "Voltage equals current times resistance.",
          correct: "D",
          source_type: "manual",
          is_verified: true,
        },
      ]),
    });
    assert.equal(saveResp.status, 200);
    const saveJson = await saveResp.json();
    assert.equal(saveJson.success, true);

    // 2) Retrieval-only endpoint
    const retrieveResp = await fetch(`${baseUrl}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionText: [
          "In accordance with Ohm's law, which statement is correct?",
          "Voltage equals current times resistance.",
          "Resistance equals voltage times current.",
          "The current is proportional to voltage.",
          "Voltage equals current divided by resistance.",
        ].join("\n"),
        topN: 1,
      }),
    });
    assert.equal(retrieveResp.status, 200);
    const retrieveJson = await retrieveResp.json();
    assert.equal(retrieveJson.candidates.length, 1);
    assert.equal(retrieveJson.candidates[0].matched_external_id, "INT1");

    // 3) /api/answer bypass branch (no LLM provider configured, strong retrieval match).
    const answerResp = await fetch(`${baseUrl}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionText: [
          "In accordance with Ohm's law, which statement is correct?",
          "The current is proportional to voltage.",
          "Resistance equals voltage times current.",
          "Voltage equals current divided by resistance.",
          "Voltage equals current times resistance.",
        ].join("\n"),
      }),
    });
    assert.equal(answerResp.status, 200);
    const answerJson = await answerResp.json();
    assert.equal(answerJson.answer, "D");
    assert.equal(answerJson.llm_used, false);
    assert.equal(Boolean(answerJson.insufficient_evidence), false);

    // 4) Regression: /api/questions dedupe drops duplicate IDs.
    const dupSaveResp = await fetch(`${baseUrl}/api/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          id: "INT1",
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
          // Same ID => should be dropped by backend dedupe.
          id: "INT1",
          question: "Duplicate row with same ID; should be ignored.",
          a: "x",
          b: "y",
          c: "z",
          d: "w",
          correct: "D",
          source_type: "manual",
          is_verified: true,
        },
      ]),
    });
    assert.equal(dupSaveResp.status, 200);
    const dupSaveJson = await dupSaveResp.json();
    assert.equal(dupSaveJson.droppedDuplicates, 1);

    // 5) Manual review toggle (verified -> needs review)
    const reviewResp = await fetch(`${baseUrl}/api/questions/INT1/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verified: false,
        unverified_source_type: "AI_inferred_needs_review",
      }),
    });
    assert.equal(reviewResp.status, 200);

    const getResp = await fetch(`${baseUrl}/api/questions`);
    assert.equal(getResp.status, 200);
    const all = await getResp.json();
    const row = all.find((x) => x.id === "INT1");
    assert.ok(row);
    assert.equal(Boolean(row.is_verified), false);
    assert.equal(row.source_type, "AI_inferred_needs_review");

    server.close();
  } finally {
    // Restore environment.
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

