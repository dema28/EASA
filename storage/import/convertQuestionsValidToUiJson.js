import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function usage() {
  console.log("Usage:");
  console.log("  node storage/import/convertQuestionsValidToUiJson.js");
  console.log("");
  console.log("Env vars (recommended):");
  console.log("  EASA_VALID_INPUT_JSON_PATH   path to questions_valid.json");
  console.log("  EASA_VALID_OUTPUT_JSON_PATH  path to output questions.json (UI import format)");
  console.log("");
  console.log("Defaults:");
  console.log("  input : ./questions_valid.json (in repo root)");
  console.log("  output: ./questions.json (in repo root)");
}

function pickCorrectLetter(options) {
  if (!Array.isArray(options)) return null;
  const correct = options.find((o) => o && o.isCorrect === true);
  const id = correct?.id;
  const letter = String(id ?? "").trim().toUpperCase();
  if (!["A", "B", "C", "D"].includes(letter)) return null;
  return letter;
}

function optionTextByLetter(options) {
  const out = { A: "", B: "", C: "", D: "" };
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (!o || typeof o !== "object") continue;
    const key = String(o.id ?? "").trim().toUpperCase();
    if (!["A", "B", "C", "D"].includes(key)) continue;
    out[key] = typeof o.text === "string" ? o.text : String(o.text ?? "");
  }
  return out;
}

function main() {
  const inputPath = process.env.EASA_VALID_INPUT_JSON_PATH
    ? path.resolve(process.env.EASA_VALID_INPUT_JSON_PATH)
    : path.join(repoRoot, "questions_valid.json");

  const outputPath = process.env.EASA_VALID_OUTPUT_JSON_PATH
    ? path.resolve(process.env.EASA_VALID_OUTPUT_JSON_PATH)
    : path.join(repoRoot, "questions.json");

  if (!fs.existsSync(inputPath)) {
    console.error("Input JSON not found:", inputPath);
    usage();
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected top-level JSON array");
  }

  const out = [];
  let skipped = 0;

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      skipped++;
      continue;
    }

    const id = String(item.id ?? "").trim();
    const question = typeof item.questionText === "string" ? item.questionText : String(item.questionText ?? "");
    const options = item.options;

    const correct = pickCorrectLetter(options);
    const { A, B, C, D } = optionTextByLetter(options);

    // Be conservative: only emit records the UI/import pipeline can understand.
    const hasAllOptions = [A, B, C, D].every((x) => typeof x === "string" && x.trim().length > 0);
    if (!id || question.trim().length === 0 || !correct || !hasAllOptions) {
      skipped++;
      continue;
    }

    out.push({
      id,
      question,
      a: A,
      b: B,
      c: C,
      d: D,
      correct,
    });
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2), "utf8");

  console.log("Converted:", {
    input: inputPath,
    output: outputPath,
    total: parsed.length,
    emitted: out.length,
    skipped,
  });
}

main();

