import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import child_process from "node:child_process";
import { fileURLToPath } from "url";
import { initSqliteStore } from "../storage/sqliteStore.js";
import { makeTempDir, writeJson } from "./testUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function runNodeScript(scriptPath, { env } = {}) {
  child_process.execFileSync("node", [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...(env ?? {}) },
    stdio: "pipe",
  });
}

test("importKnownQuestions: runs on provided input paths and populates DB", () => {
  const tmpDir = makeTempDir("easa-import-");
  const dbPath = path.join(tmpDir, "import.sqlite");
  const inputJsonPath = path.join(tmpDir, "questions.json");
  const reportPath = path.join(tmpDir, "import-report.json");

  // Two exact duplicates (same fingerprint) + one distinct question.
  const q1 = {
    id: "IMP1",
    question: "In accordance with Ohm's law, which statement is correct?",
    a: "The current is proportional to voltage.",
    b: "Resistance equals voltage times current.",
    c: "Voltage equals current divided by resistance.",
    d: "Voltage equals current times resistance.",
    correct: "D",
  };
  const q1dup = { ...q1, id: "IMP1_DUP" };
  const q2 = {
    id: "IMP2",
    question: "A busbar is used in an aircraft electrical switchboard to distribute current.",
    a: "A maintenance bus conductor feeding a circuit breaker for load shedding.",
    b: "A method for storing energy in capacitors.",
    c: "A system for plotting weather.",
    d: "A navigation procedure unrelated to electrical protection.",
    correct: "A",
  };

  writeJson(inputJsonPath, [q1, q1dup, q2]);
  runNodeScript(path.join(repoRoot, "storage", "import", "importKnownQuestions.js"), {
    env: {
      EASA_IMPORT_DB_PATH: dbPath,
      EASA_IMPORT_INPUT_JSON_PATH: inputJsonPath,
      EASA_IMPORT_REPORT_PATH: reportPath,
    },
  });

  assert.ok(fs.existsSync(reportPath), "expected import report file");

  const store = initSqliteStore({ dbPath });
  const active = store.getActiveQuestions();

  // q1 and q1dup are exact duplicates by question+options fingerprint => should collapse to 1.
  // q2 should be separate => total 2.
  assert.equal(active.length, 2);

  const imp2 = active.find((x) => x.id === "IMP2");
  assert.ok(imp2);
  assert.equal(imp2.correct, "A");
});

