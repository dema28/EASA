import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { initSqliteStore } from "../sqliteStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function ensureDirExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeUnicode(text) {
  return String(text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\u200B/g, "")
    .replace(/\u2013/g, "-")
    .replace(/\u2014/g, "-")
    .replace(/\u2212/g, "-")
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/\u201C/g, '"')
    .replace(/\u201D/g, '"')
    // OCR ligatures
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl");
}

function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function normalizeOptionLineForKeys(text) {
  // Remove leading markers like "+ A) ..." or "A) ...".
  return collapseWhitespace(
    normalizeUnicode(text)
      .replace(/^[\s]*\+[\s]*/g, "")
      .replace(/^[\s]*[ABCDabcd][\s]*\)?[\s]*/g, "")
  );
}

function normalizeCorrectLetter(value) {
  const s = String(value ?? "").trim().toUpperCase();
  const map = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const letter = map[s] ?? s;
  if (!["A", "B", "C", "D"].includes(letter)) return null;
  return letter;
}

function canonicalExact(text) {
  // Lowercase + whitespace normalization; punctuation preserved (but normalized dashes/quotes).
  const s = normalizeUnicode(text).toLowerCase();
  return collapseWhitespace(s);
}

function canonicalLoose(text) {
  // For dedup/search: remove most punctuation and make it robust to case/formatting.
  let s = normalizeUnicode(text).toLowerCase();

  // Normalize decimal separators: "1 , 5" => "1.5"
  s = s.replace(/(\d)\s*[.,]\s*(\d)/g, "$1.$2");

  // Remove spaces between digits: "1 000" => "1000"
  s = s.replace(/(\d)\s+(?=\d)/g, "$1");

  // Replace punctuation with spaces, keep letters/digits/spaces only.
  s = s.replace(/[^a-z0-9\s]/g, " ");

  // Collapse to tokens
  s = collapseWhitespace(s);
  return s;
}

function tokenSet(text) {
  const s = canonicalLoose(text);
  if (!s) return new Set();
  return new Set(s.split(" ").filter(Boolean));
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function stableHash(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function computeKeysFromRow(row) {
  const correctLetter = normalizeCorrectLetter(row.correct);
  if (!correctLetter) return null;

  const qRaw = normalizeUnicode(row.question);
  const questionExact = canonicalExact(qRaw);
  const questionLoose = canonicalLoose(qRaw);

  const opt = {
    A: normalizeOptionLineForKeys(row.a),
    B: normalizeOptionLineForKeys(row.b),
    C: normalizeOptionLineForKeys(row.c),
    D: normalizeOptionLineForKeys(row.d),
  };

  const optExact = {
    A: canonicalExact(opt.A),
    B: canonicalExact(opt.B),
    C: canonicalExact(opt.C),
    D: canonicalExact(opt.D),
  };

  const optLoose = {
    A: canonicalLoose(opt.A),
    B: canonicalLoose(opt.B),
    C: canonicalLoose(opt.C),
    D: canonicalLoose(opt.D),
  };

  const correctOptionTextOptLoose = optLoose[correctLetter];

  const optionExactOrdered =
    `${optExact.A}||${optExact.B}||${optExact.C}||${optExact.D}`;
  const optionLooseOrdered =
    `${optLoose.A}||${optLoose.B}||${optLoose.C}||${optLoose.D}`;

  // Order-insensitive set key: duplicates in option text are possible but unlikely.
  const optLooseValues = [optLoose.A, optLoose.B, optLoose.C, optLoose.D].sort();
  const optionLooseSet = optLooseValues.join("||");

  const questionLooseKey = questionLoose;
  const questionExactKey = questionExact;

  return {
    correctLetter,
    questionExactKey,
    questionLooseKey,
    optExact,
    optLoose,
    keys: {
      exactOrderedKey: stableHash(
        `${questionExactKey}|${optionExactOrdered}|${optExact[correctLetter]}`
      ),
      nearOrderedKey: stableHash(
        `${questionLooseKey}|${optionLooseOrdered}|${correctOptionTextOptLoose}`
      ),
      reorderKey: stableHash(
        `${questionLooseKey}|${optionLooseSet}|${correctOptionTextOptLoose}`
      ),
    },
  };
}

function computeOptionSetSimilarity(incomingOptLoose, candidateOptLoose) {
  const incoming = [incomingOptLoose.A, incomingOptLoose.B, incomingOptLoose.C, incomingOptLoose.D];
  const candidate = [candidateOptLoose.A, candidateOptLoose.B, candidateOptLoose.C, candidateOptLoose.D];

  const incomingTokens = incoming.map((t) => tokenSet(t));
  const candidateTokens = candidate.map((t) => tokenSet(t));

  // For each incoming option: best match in candidate options.
  const perOpt = [];
  for (let i = 0; i < incomingTokens.length; i++) {
    let best = 0;
    for (let j = 0; j < candidateTokens.length; j++) {
      best = Math.max(best, jaccard(incomingTokens[i], candidateTokens[j]));
    }
    perOpt.push(best);
  }

  const avg = perOpt.reduce((a, b) => a + b, 0) / perOpt.length;
  return avg;
}

function pickExistingCorrectOptionLetter({ incomingCorrectOptionLoose, candidateOptionsLoose }) {
  for (const k of ["A", "B", "C", "D"]) {
    if (candidateOptionsLoose[k] === incomingCorrectOptionLoose) return k;
  }
  return null;
}

async function main() {
  const logsDir = path.join(repoRoot, "logs");
  ensureDirExists(logsDir);
  const reportPath = process.env.EASA_IMPORT_REPORT_PATH
    ? path.resolve(process.env.EASA_IMPORT_REPORT_PATH)
    : path.join(logsDir, `import-report-${Date.now()}.json`);

  const dbPath = process.env.EASA_IMPORT_DB_PATH
    ? path.resolve(process.env.EASA_IMPORT_DB_PATH)
    : path.join(repoRoot, "data", "easa-atpl.sqlite");

  const inputJsonPath = process.env.EASA_IMPORT_INPUT_JSON_PATH
    ? path.resolve(process.env.EASA_IMPORT_INPUT_JSON_PATH)
    : path.join(repoRoot, "questions.json");

  // Sources: for now, the repo's only durable source is `questions.json`.
  const sources = [];
  if (fs.existsSync(inputJsonPath)) {
    sources.push({ name: path.basename(inputJsonPath), path: inputJsonPath });
  }

  // IMPORTANT: we disable initSqliteStore auto-migration here,
  // so the import pipeline is the single source of truth for DB changes.
  const store = initSqliteStore({ dbPath });

  const existing = store.getActiveQuestionsWithOptionsForImport();

  // Build indices for deterministic dedup decisions.
  const indexExactOrdered = new Map();
  const indexNearOrdered = new Map();
  const indexReorder = new Map();
  const indexByQuestionLooseKey = new Map();

  for (const ex of existing) {
    const existingCorrectLetter = ex.correct_option;
    if (!existingCorrectLetter || !["A", "B", "C", "D"].includes(existingCorrectLetter)) continue;

    const keys = computeKeysFromRow({
      id: ex.external_id,
      question: ex.question_text,
      a: ex.options.A.option_text,
      b: ex.options.B.option_text,
      c: ex.options.C.option_text,
      d: ex.options.D.option_text,
      correct: existingCorrectLetter,
    });
    if (!keys) continue;

    const questionLooseKey = keys.questionLooseKey;
    if (!indexByQuestionLooseKey.has(questionLooseKey)) indexByQuestionLooseKey.set(questionLooseKey, []);
    indexByQuestionLooseKey.get(questionLooseKey).push({ id: ex.id, external_id: ex.external_id, is_verified: ex.is_verified, keys, existing: ex });

    indexExactOrdered.set(keys.keys.exactOrderedKey, ex);
    indexNearOrdered.set(keys.keys.nearOrderedKey, ex);
    indexReorder.set(keys.keys.reorderKey, ex);
  }

  const report = {
    started_at: new Date().toISOString(),
    sources: sources.map((s) => ({ name: s.name, path: s.path })),
    totals: {
      input_rows: 0,
      inserted_new: 0,
      merged_exact_duplicates: 0,
      merged_near_duplicates: 0,
      merged_reordered_duplicates: 0,
      suspicious_near_duplicates: 0,
      inserted_needing_manual_review: 0,
      skipped_incomplete_records: 0,
      updated_existing_unverified: 0,
    },
    details: {
      skipped_incomplete: [],
      suspicious_near: [],
      examples_merged: [],
    },
  };

  // Import deterministically: stable order by external id then question.
  const allInputRows = [];
  for (const src of sources) {
    const raw = fs.readFileSync(src.path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) continue;
    for (const row of parsed) allInputRows.push({ ...row, __source: src.name });
  }

  allInputRows.sort((a, b) => {
    const aid = String(a.id ?? "").localeCompare(String(b.id ?? ""));
    if (aid !== 0) return aid;
    return String(a.question ?? "").localeCompare(String(b.question ?? ""));
  });

  report.totals.input_rows = allInputRows.length;

  for (const row of allInputRows) {
    const correctLetter = normalizeCorrectLetter(row.correct);
    const hasAllNonEmptyOptions =
      typeof row.a === "string" &&
      typeof row.b === "string" &&
      typeof row.c === "string" &&
      typeof row.d === "string" &&
      String(row.a).trim().length > 0 &&
      String(row.b).trim().length > 0 &&
      String(row.c).trim().length > 0 &&
      String(row.d).trim().length > 0;
    const hasAllOptions =
      typeof row.question === "string" &&
      String(row.question).trim().length > 0 &&
      hasAllNonEmptyOptions &&
      Boolean(correctLetter);

    if (!hasAllOptions) {
      report.totals.skipped_incomplete_records++;
      report.details.skipped_incomplete.push({ id: row.id, source: row.__source });
      continue;
    }

    const keys = computeKeysFromRow(row);
    if (!keys) {
      report.totals.skipped_incomplete_records++;
      report.details.skipped_incomplete.push({ id: row.id, source: row.__source, reason: "invalid correct" });
      continue;
    }

    const incomingCorrectOptionLoose = keys.optLoose[keys.correctLetter];

    const exExact = indexExactOrdered.get(keys.keys.exactOrderedKey);
    if (exExact) {
      report.totals.merged_exact_duplicates++;
      if (report.details.examples_merged.length < 10) {
        report.details.examples_merged.push({ id: row.id, matched_external_id: exExact.external_id, type: "exact" });
      }

      // Always update canonical normalized fields; only overwrite raw if existing is unverified.
      const wasUnverified = !exExact.is_verified;

      const existingKeys = computeKeysFromRow({
        id: exExact.external_id,
        question: exExact.question_text,
        a: exExact.options.A.option_text,
        b: exExact.options.B.option_text,
        c: exExact.options.C.option_text,
        d: exExact.options.D.option_text,
        correct: exExact.correct_option,
      });
      const correctLetterExisting = pickExistingCorrectOptionLetter({
        incomingCorrectOptionLoose,
        candidateOptionsLoose: existingKeys.optLoose,
      });

      if (!correctLetterExisting) {
        report.totals.suspicious_near_duplicates++;
        report.details.suspicious_near.push({
          id: row.id,
          matched_external_id: exExact.external_id,
          type: "exact_duplicate_mapping_failed",
        });
        continue;
      }

      store.updateQuestionAndOptionsById({
        questionId: exExact.id,
        preserveRaw: exExact.is_verified,
        questionText: row.question,
        normalizedQuestionText: keys.questionLooseKey,
        options: { A: row.a, B: row.b, C: row.c, D: row.d },
        normalizedOptions: { A: keys.optLoose.A, B: keys.optLoose.B, C: keys.optLoose.C, D: keys.optLoose.D },
        correctOption: correctLetterExisting,
        sourceType: "imported",
        isVerified: true,
      });

      exExact.is_verified = true;
      exExact.source_type = "imported";
      if (wasUnverified) report.totals.updated_existing_unverified++;
      continue;
    }

    const exNearOrdered = indexNearOrdered.get(keys.keys.nearOrderedKey);
    if (exNearOrdered) {
      report.totals.merged_near_duplicates++;
      const wasUnverified = !exNearOrdered.is_verified;

      const existingKeys = computeKeysFromRow({
        id: exNearOrdered.external_id,
        question: exNearOrdered.question_text,
        a: exNearOrdered.options.A.option_text,
        b: exNearOrdered.options.B.option_text,
        c: exNearOrdered.options.C.option_text,
        d: exNearOrdered.options.D.option_text,
        correct: exNearOrdered.correct_option,
      });
      const correctLetterExisting = pickExistingCorrectOptionLetter({
        incomingCorrectOptionLoose,
        candidateOptionsLoose: existingKeys.optLoose,
      });

      if (!correctLetterExisting) {
        report.totals.suspicious_near_duplicates++;
        report.details.suspicious_near.push({
          id: row.id,
          matched_external_id: exNearOrdered.external_id,
          type: "near_duplicate_mapping_failed",
        });
        continue;
      }

      store.updateQuestionAndOptionsById({
        questionId: exNearOrdered.id,
        preserveRaw: exNearOrdered.is_verified,
        questionText: row.question,
        normalizedQuestionText: keys.questionLooseKey,
        options: { A: row.a, B: row.b, C: row.c, D: row.d },
        normalizedOptions: { A: keys.optLoose.A, B: keys.optLoose.B, C: keys.optLoose.C, D: keys.optLoose.D },
        correctOption: correctLetterExisting,
        sourceType: "imported",
        isVerified: true,
      });

      exNearOrdered.is_verified = true;
      exNearOrdered.source_type = "imported";
      if (wasUnverified) report.totals.updated_existing_unverified++;

      if (report.details.examples_merged.length < 10) {
        report.details.examples_merged.push({ id: row.id, matched_external_id: exNearOrdered.external_id, type: "near" });
      }
      continue;
    }

    const exReorder = indexReorder.get(keys.keys.reorderKey);
    if (exReorder) {
      report.totals.merged_reordered_duplicates++;

      const existingKeys = computeKeysFromRow({
        id: exReorder.external_id,
        question: exReorder.question_text,
        a: exReorder.options.A.option_text,
        b: exReorder.options.B.option_text,
        c: exReorder.options.C.option_text,
        d: exReorder.options.D.option_text,
        correct: exReorder.correct_option,
      });

      const correctLetterExisting = pickExistingCorrectOptionLetter({
        incomingCorrectOptionLoose,
        candidateOptionsLoose: existingKeys.optLoose,
      });
      if (!correctLetterExisting) {
        // Should not happen, but keep conservative behavior.
        report.totals.suspicious_near_duplicates++;
        report.details.suspicious_near.push({
          id: row.id,
          type: "reordered_duplicate_but_correct_mapping_failed",
          matched_external_id: exReorder.external_id,
        });
        continue;
      }

      store.updateQuestionAndOptionsById({
        questionId: exReorder.id,
        preserveRaw: exReorder.is_verified,
        questionText: row.question,
        normalizedQuestionText: keys.questionLooseKey,
        options: { A: row.a, B: row.b, C: row.c, D: row.d },
        normalizedOptions: { A: keys.optLoose.A, B: keys.optLoose.B, C: keys.optLoose.C, D: keys.optLoose.D },
        correctOption: correctLetterExisting,
        sourceType: exReorder.source_type === "AI_inferred" ? "imported" : exReorder.source_type,
        isVerified: exReorder.is_verified ? exReorder.is_verified : true,
      });

      if (!exReorder.is_verified) {
        exReorder.is_verified = true;
      }
      if (exReorder.source_type === "AI_inferred") {
        exReorder.source_type = "imported";
      }

      if (report.details.examples_merged.length < 10) {
        report.details.examples_merged.push({
          id: row.id,
          matched_external_id: exReorder.external_id,
          type: "reordered",
        });
      }

      if (!exReorder.is_verified) report.totals.updated_existing_unverified++;
      continue;
    }

    // Suspicious near duplicates: same loose question key but different options
    const candidates = indexByQuestionLooseKey.get(keys.questionLooseKey) ?? [];
    let isSuspicious = false;
    let suspiciousMatch = null;
    if (candidates.length > 0) {
      for (const c of candidates) {
        const cKeys = computeKeysFromRow({
          id: c.existing.external_id,
          question: c.existing.question_text,
          a: c.existing.options.A.option_text,
          b: c.existing.options.B.option_text,
          c: c.existing.options.C.option_text,
          d: c.existing.options.D.option_text,
          correct: c.existing.correct_option,
        });

        const similarity = computeOptionSetSimilarity(keys.optLoose, cKeys.optLoose);
        if (similarity >= 0.9) {
          isSuspicious = true;
          suspiciousMatch = c.existing;
          report.totals.suspicious_near_duplicates++;
          report.details.suspicious_near.push({
            id: row.id,
            matched_external_id: c.existing.external_id,
            similarity: Number(similarity.toFixed(3)),
          });
          break; // one suspicious flag per incoming row
        }
      }
    }

    // Insert as new record (never silently drop).
    const insertedId = store.upsertImportedQuestionWithoutDeactivation({
      externalId: row.id,
      questionText: row.question,
      options: { A: row.a, B: row.b, C: row.c, D: row.d },
      correctOption: keys.correctLetter,
      sourceType: isSuspicious ? "imported_needs_review" : "imported",
      isVerified: !isSuspicious,
    });

    // Normalize fields deterministically for future retrieval.
    store.updateQuestionAndOptionsById({
      questionId: insertedId,
      preserveRaw: true,
      questionText: row.question,
      normalizedQuestionText: keys.questionLooseKey,
      options: { A: row.a, B: row.b, C: row.c, D: row.d },
      normalizedOptions: { A: keys.optLoose.A, B: keys.optLoose.B, C: keys.optLoose.C, D: keys.optLoose.D },
      correctOption: keys.correctLetter,
      sourceType: isSuspicious ? "imported_needs_review" : "imported",
      isVerified: !isSuspicious,
    });

    if (isSuspicious) {
      report.totals.inserted_needing_manual_review++;
      report.details.examples_merged.push({
        id: row.id,
        matched_external_id: suspiciousMatch?.external_id ?? null,
        type: "inserted_for_manual_review",
      });
    }

    // Make inserted record visible to dedup logic for later rows in the same import run.
    const insertedExisting = {
      id: insertedId,
      external_id: row.id,
      question_text: row.question,
      normalized_question_text: keys.questionLooseKey,
      correct_option: keys.correctLetter,
      source_type: isSuspicious ? "imported_needs_review" : "imported",
      is_verified: !isSuspicious,
      options: {
        A: { option_text: row.a, normalized_option_text: keys.optLoose.A },
        B: { option_text: row.b, normalized_option_text: keys.optLoose.B },
        C: { option_text: row.c, normalized_option_text: keys.optLoose.C },
        D: { option_text: row.d, normalized_option_text: keys.optLoose.D },
      },
    };

    indexExactOrdered.set(keys.keys.exactOrderedKey, insertedExisting);
    indexNearOrdered.set(keys.keys.nearOrderedKey, insertedExisting);
    indexReorder.set(keys.keys.reorderKey, insertedExisting);

    if (!indexByQuestionLooseKey.has(keys.questionLooseKey)) indexByQuestionLooseKey.set(keys.questionLooseKey, []);
    indexByQuestionLooseKey.get(keys.questionLooseKey).push({
      id: insertedExisting.id,
      external_id: insertedExisting.external_id,
      is_verified: insertedExisting.is_verified,
      keys,
      existing: insertedExisting,
    });

    report.totals.inserted_new++;
  }

  report.finished_at = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Import report written to:", reportPath);
  console.log("Totals:", report.totals);
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});

