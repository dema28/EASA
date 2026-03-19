import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { classifyQuestion } from "./atplClassifier.js";
import OpenAI from "openai";

function ensureDirExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCorrectOption(value) {
  const s = String(value ?? "").trim().toUpperCase();
  const map = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const letter = map[s] ?? s;
  if (!["A", "B", "C", "D"].includes(letter)) return null;
  return letter;
}

function fingerprintFrom(normalizedQuestionText, normalizedOptionsABCD) {
  // Stable identity for "same question + same options" across imports/edits.
  const payload =
    `${normalizedQuestionText}\n` +
    `A:${normalizedOptionsABCD.A}\n` +
    `B:${normalizedOptionsABCD.B}\n` +
    `C:${normalizedOptionsABCD.C}\n` +
    `D:${normalizedOptionsABCD.D}\n`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function parseAiQuestionText(questionText) {
  // Frontend sends: `${question}\n${a}\n${b}\n${c}\n${d}`
  const lines = String(questionText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const question = lines[0] ?? "";
  const a = lines[1] ?? "";
  const b = lines[2] ?? "";
  const c = lines[3] ?? "";
  const d = lines[4] ?? "";

  return { question, options: { A: a, B: b, C: c, D: d } };
}

function nowIso() {
  return new Date().toISOString();
}

export function initSqliteStore({ dbPath, questionsJsonPath }) {
  const dbDir = path.dirname(dbPath);
  ensureDirExists(dbDir);

  const db = new Database(dbPath);
  const openaiKey = process.env.OPENAI_API_KEY;
  const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
  const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

  // Schema
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      external_id TEXT,
      question_text TEXT NOT NULL,
      normalized_question_text TEXT NOT NULL,
      subject_code TEXT,
      subject_name TEXT,
      topic_code TEXT,
      topic_name TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      is_verified INTEGER NOT NULL DEFAULT 0,
      correct_option TEXT,
      explanation TEXT,
      inference_confidence REAL,
      inference_evidence_basis TEXT,
      inference_insufficient_evidence INTEGER,
      inference_matched_question_ids TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      times_seen INTEGER NOT NULL DEFAULT 0,
      classification_confidence REAL,
      classification_evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      embedding_json TEXT
    );

    CREATE TABLE IF NOT EXISTS question_options (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      option_key TEXT NOT NULL CHECK(option_key IN ('A','B','C','D')),
      option_text TEXT NOT NULL,
      normalized_option_text TEXT NOT NULL,
      UNIQUE(question_id, option_key),
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS question_attempts (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      attempt_type TEXT NOT NULL,
      provider TEXT,
      model_raw_response TEXT,
      answer_choice TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_questions_is_active ON questions(is_active);
    CREATE INDEX IF NOT EXISTS idx_questions_normalized_question ON questions(normalized_question_text);
    CREATE INDEX IF NOT EXISTS idx_attempts_question_id ON question_attempts(question_id);
  `);

  function ensureQuestionColumn(columnName, columnDefSql) {
    const cols = db.prepare("PRAGMA table_info(questions)").all().map((c) => c.name);
    if (cols.includes(columnName)) return;
    db.exec(`ALTER TABLE questions ADD COLUMN ${columnDefSql}`);
  }

  // Ensure classification columns exist (for existing DBs).
  ensureQuestionColumn("subject_name", "subject_name TEXT");
  ensureQuestionColumn("topic_name", "topic_name TEXT");
  ensureQuestionColumn("classification_confidence", "classification_confidence REAL");
  ensureQuestionColumn("classification_evidence_json", "classification_evidence_json TEXT");

  // Ensure inference/explainability columns exist (for existing DBs).
  ensureQuestionColumn("inference_confidence", "inference_confidence REAL");
  ensureQuestionColumn("inference_evidence_basis", "inference_evidence_basis TEXT");
  ensureQuestionColumn(
    "inference_insufficient_evidence",
    "inference_insufficient_evidence INTEGER"
  );
  ensureQuestionColumn(
    "inference_matched_question_ids",
    "inference_matched_question_ids TEXT"
  );

  function ensureFts5Index() {
    const ftsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions_fts' LIMIT 1")
      .get();
    if (!ftsExists) {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(question_id UNINDEXED, doc);`);
    }

    const ftsCount = db.prepare("SELECT COUNT(*) AS c FROM questions_fts").get().c;
    if (ftsCount === 0) {
      // Rebuild index deterministically from normalized question+options.
      db.exec(`DELETE FROM questions_fts;`);
      const qRows = db
        .prepare(
          `SELECT id, normalized_question_text
           FROM questions
           WHERE is_active = 1`
        )
        .all();

      const optStmt = db.prepare(
        `SELECT normalized_option_text
         FROM question_options
         WHERE question_id = @qid
         ORDER BY option_key`
      );

      const insert = db.prepare(
        `INSERT INTO questions_fts (question_id, doc) VALUES (@qid, @doc)`
      );

      for (const q of qRows) {
        const optRows = optStmt.all({ qid: q.id });
        const doc =
          `${q.normalized_question_text ?? ""} ` +
          optRows.map((r) => r.normalized_option_text ?? "").join(" ");
        insert.run({ qid: q.id, doc });
      }
    }
  }

  function updateFtsForQuestion(questionId, normalizedQuestionText, normalizedOptions) {
    // Ensure FTS exists lazily in case DB was created before retrieval stage.
    ensureFts5Index();

    const doc =
      `${normalizedQuestionText ?? ""} ` +
      [normalizedOptions.A, normalizedOptions.B, normalizedOptions.C, normalizedOptions.D]
        .map((t) => String(t ?? ""))
        .join(" ");

    db.prepare("DELETE FROM questions_fts WHERE question_id = ?").run(questionId);
    db.prepare("INSERT INTO questions_fts (question_id, doc) VALUES (?, ?)").run(questionId, doc);
  }

  ensureFts5Index();

  function safeParseJson(jsonText) {
    if (!jsonText || typeof jsonText !== "string") return null;
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }

  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return null;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i++) {
      const ai = Number(a[i] ?? 0);
      const bi = Number(b[i] ?? 0);
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    if (normA === 0 || normB === 0) return null;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async function embedTexts(texts) {
    if (!openai) throw new Error("Embeddings unavailable: OPENAI_API_KEY not set");
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });
    // openai SDK returns data[] in same order as input
    return response.data.map((d) => d.embedding);
  }

  async function ensureQuestionEmbeddings(questionId) {
    const existing = db.prepare("SELECT embedding_json FROM questions WHERE id = ?").get(questionId);
    const parsed = safeParseJson(existing?.embedding_json);
    if (
      parsed &&
      parsed.version === 2 &&
      Array.isArray(parsed.question_embedding) &&
      parsed.question_embedding.length > 0 &&
      Array.isArray(parsed.combined_embedding) &&
      parsed.combined_embedding.length > 0
    ) {
      return parsed;
    }

    // Build docs from normalized text only (good for explainability & determinism).
    const q = db.prepare("SELECT normalized_question_text FROM questions WHERE id = ?").get(questionId);
    const opts = db
      .prepare(
        `SELECT option_key, normalized_option_text
         FROM question_options
         WHERE question_id = @qid
         AND option_key IN ('A','B','C','D')`
      )
      .all({ qid: questionId });

    const optByKey = { A: "", B: "", C: "", D: "" };
    for (const r of opts) {
      if (Object.prototype.hasOwnProperty.call(optByKey, r.option_key)) {
        optByKey[r.option_key] = r.normalized_option_text ?? "";
      }
    }

    const questionDoc = String(q?.normalized_question_text ?? "").trim();
    // Order-agnostic: sorting options helps when the option order changes.
    const optionValues = [optByKey.A, optByKey.B, optByKey.C, optByKey.D].slice().sort();
    const combinedDoc = `${questionDoc} ${optionValues.join(" ")}`.trim();

    const [questionEmbedding, combinedEmbedding] = await embedTexts([questionDoc, combinedDoc]);

    const stored = {
      version: 2,
      model: EMBEDDING_MODEL,
      doc_type: "question_plus_options",
      combined_doc_order: "sorted_options",
      question_embedding: questionEmbedding,
      combined_embedding: combinedEmbedding,
      stored_at: nowIso(),
    };

    db.prepare(`UPDATE questions SET embedding_json = @j WHERE id = @id`).run({
      j: JSON.stringify(stored),
      id: questionId,
    });

    return stored;
  }

  async function buildMissingEmbeddings({ limit = 200 } = {}) {
    if (!openai) {
      return { built: 0, skipped: 0, reason: "OPENAI_API_KEY not set" };
    }

    const qids = db
      .prepare(
        `SELECT id
         FROM questions
         WHERE is_active = 1
           AND (
             embedding_json IS NULL
             OR embedding_json = ''
             OR embedding_json NOT LIKE '%\"version\":2%'
           )
         LIMIT @limit`
      )
      .all({ limit });

    let built = 0;
    for (const r of qids) {
      await ensureQuestionEmbeddings(r.id);
      built++;
    }
    return { built, skipped: 0 };
  }

  // Migration from JSON to SQLite (only if SQLite is empty)
  const activeCount = db.prepare("SELECT COUNT(*) AS c FROM questions").get().c;
  if (activeCount === 0 && questionsJsonPath && fs.existsSync(questionsJsonPath)) {
    try {
      const raw = fs.readFileSync(questionsJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        migrateQuestionsJson({ db, rows: parsed });
      }
    } catch {
      // Non-fatal: server can still run with empty DB.
    }
  }

  function upsertQuestionAndOptions({
    externalId,
    questionText,
    options,
    correctOption,
    sourceType,
    isVerified,
    setIsActive,
    inferenceConfidence,
    inferenceEvidenceBasis,
    inferenceInsufficientEvidence,
    inferenceMatchedQuestionIds,
  }) {
    const classification = classifyQuestion({
      externalId,
      questionText,
      options,
    });

    const normalizedQuestionText = normalizeText(questionText);
    const normalizedOptions = {
      A: normalizeText(options.A),
      B: normalizeText(options.B),
      C: normalizeText(options.C),
      D: normalizeText(options.D),
    };

    const fingerprint = fingerprintFrom(normalizedQuestionText, normalizedOptions);
    const existing = db.prepare("SELECT id FROM questions WHERE fingerprint = ?").get(fingerprint);

    const questionId = existing?.id ?? crypto.randomUUID();
    const t = nowIso();

    db.prepare(
      `INSERT INTO questions (
        id, fingerprint, external_id, question_text, normalized_question_text,
        subject_code, subject_name, topic_code, topic_name,
        classification_confidence, classification_evidence_json,
        source_type, is_verified, correct_option, explanation,
        inference_confidence, inference_evidence_basis, inference_insufficient_evidence, inference_matched_question_ids,
        is_active, times_seen,
        created_at, updated_at
      ) VALUES (
        @id, @fingerprint, @external_id, @question_text, @normalized_question_text,
        @subject_code, @subject_name, @topic_code, @topic_name,
        @classification_confidence, @classification_evidence_json,
        @source_type, @is_verified, @correct_option, NULL,
        @inference_confidence, @inference_evidence_basis, @inference_insufficient_evidence, @inference_matched_question_ids,
        @is_active, 0,
        @created_at, @updated_at
      )
      ON CONFLICT(fingerprint) DO UPDATE SET
        external_id = excluded.external_id,
        question_text = excluded.question_text,
        normalized_question_text = excluded.normalized_question_text,
        subject_code = CASE
          WHEN questions.subject_code IS NULL OR questions.subject_code = 'unknown' OR questions.classification_confidence IS NULL OR questions.classification_confidence < 0.6
          THEN excluded.subject_code ELSE questions.subject_code END,
        subject_name = CASE
          WHEN questions.subject_code IS NULL OR questions.subject_code = 'unknown' OR questions.classification_confidence IS NULL OR questions.classification_confidence < 0.6
          THEN excluded.subject_name ELSE questions.subject_name END,
        topic_code = CASE
          WHEN questions.subject_code IS NULL OR questions.subject_code = 'unknown' OR questions.classification_confidence IS NULL OR questions.classification_confidence < 0.6
          THEN excluded.topic_code ELSE questions.topic_code END,
        topic_name = CASE
          WHEN questions.subject_code IS NULL OR questions.subject_code = 'unknown' OR questions.classification_confidence IS NULL OR questions.classification_confidence < 0.6
          THEN excluded.topic_name ELSE questions.topic_name END,
        classification_confidence = CASE
          WHEN questions.subject_code IS NULL OR questions.subject_code = 'unknown' OR questions.classification_confidence IS NULL OR questions.classification_confidence < 0.6
          THEN excluded.classification_confidence ELSE questions.classification_confidence END,
        classification_evidence_json = CASE
          WHEN questions.subject_code IS NULL OR questions.subject_code = 'unknown' OR questions.classification_confidence IS NULL OR questions.classification_confidence < 0.6
          THEN excluded.classification_evidence_json ELSE questions.classification_evidence_json END,
        source_type = excluded.source_type,
        is_verified = excluded.is_verified,
        correct_option = excluded.correct_option,
        inference_confidence = CASE
          WHEN questions.is_verified = 1 AND excluded.is_verified = 0 THEN questions.inference_confidence
          ELSE excluded.inference_confidence END,
        inference_evidence_basis = CASE
          WHEN questions.is_verified = 1 AND excluded.is_verified = 0 THEN questions.inference_evidence_basis
          ELSE excluded.inference_evidence_basis END,
        inference_insufficient_evidence = CASE
          WHEN questions.is_verified = 1 AND excluded.is_verified = 0 THEN questions.inference_insufficient_evidence
          ELSE excluded.inference_insufficient_evidence END,
        inference_matched_question_ids = CASE
          WHEN questions.is_verified = 1 AND excluded.is_verified = 0 THEN questions.inference_matched_question_ids
          ELSE excluded.inference_matched_question_ids END,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    `
    ).run({
      id: questionId,
      fingerprint,
      external_id: externalId ?? null,
      question_text: String(questionText ?? "").trim(),
      normalized_question_text: normalizedQuestionText,
      subject_code: classification.subject_code ?? "unknown",
      subject_name: classification.subject_name ?? "Unknown",
      topic_code: classification.topic_code ?? "unknown",
      topic_name: classification.topic_name ?? "Unknown",
      classification_confidence: classification.classification_confidence ?? null,
      classification_evidence_json: JSON.stringify(classification.evidence ?? {}),
      source_type: sourceType ?? "manual",
      is_verified: isVerified ? 1 : 0,
      correct_option: correctOption ?? null,
      is_active: setIsActive ? 1 : 0,
      inference_confidence:
        inferenceConfidence === null || inferenceConfidence === undefined
          ? null
          : Number(inferenceConfidence),
      inference_evidence_basis:
        inferenceEvidenceBasis === null || inferenceEvidenceBasis === undefined
          ? null
          : String(inferenceEvidenceBasis),
      inference_insufficient_evidence:
        inferenceInsufficientEvidence === null || inferenceInsufficientEvidence === undefined
          ? null
          : inferenceInsufficientEvidence
            ? 1
            : 0,
      inference_matched_question_ids:
        inferenceMatchedQuestionIds === null || inferenceMatchedQuestionIds === undefined
          ? JSON.stringify([])
          : Array.isArray(inferenceMatchedQuestionIds)
            ? JSON.stringify(inferenceMatchedQuestionIds)
            : String(inferenceMatchedQuestionIds),
      created_at: t,
      updated_at: t,
    });

    const optionT = nowIso();
    const upsertOption = db.prepare(`
      INSERT INTO question_options (
        id, question_id, option_key, option_text, normalized_option_text
      ) VALUES (
        @id, @question_id, @option_key, @option_text, @normalized_option_text
      )
      ON CONFLICT(question_id, option_key) DO UPDATE SET
        option_text = excluded.option_text,
        normalized_option_text = excluded.normalized_option_text
    `);

    for (const optionKey of ["A", "B", "C", "D"]) {
      upsertOption.run({
        id: crypto.randomUUID(),
        question_id: questionId,
        option_key: optionKey,
        option_text: String(options[optionKey] ?? "").trim(),
        normalized_option_text: normalizedOptions[optionKey],
      });
    }

    // Update FTS index for lexical retrieval.
    updateFtsForQuestion(questionId, normalizedQuestionText, normalizedOptions);

    return questionId;
  }

  function setQuestionsActiveByFingerprints({ fingerprints }) {
    const t = nowIso();
    if (!fingerprints || fingerprints.length === 0) {
      db.prepare("UPDATE questions SET is_active = 0, updated_at = ? WHERE is_active = 1").run(t);
      return;
    }
    const placeholders = fingerprints.map(() => "?").join(",");
    const stmt = db.prepare(
      `UPDATE questions SET is_active = 0, updated_at = ?
       WHERE is_active = 1 AND fingerprint NOT IN (${placeholders})`
    );
    stmt.run(t, ...fingerprints);
  }

  function getActiveQuestions() {
    const questionsRes = db
      .prepare(
        `SELECT
          id, external_id, question_text, correct_option,
          source_type, is_verified,
          subject_code, subject_name,
          topic_code, topic_name,
          classification_confidence,
          inference_confidence, inference_evidence_basis,
          inference_insufficient_evidence, inference_matched_question_ids
         FROM questions
         WHERE is_active = 1
         ORDER BY created_at DESC`
      )
      .all();

    const optionsByQuestionId = {};
    for (const r of questionsRes) optionsByQuestionId[r.id] = { A: "", B: "", C: "", D: "" };

    if (questionsRes.length > 0) {
      const ids = questionsRes.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const optionRows = db
        .prepare(
          `SELECT question_id, option_key, option_text
           FROM question_options
           WHERE question_id IN (${placeholders})`
        )
        .all(...ids);
      for (const or of optionRows) {
        optionsByQuestionId[or.question_id][or.option_key] = or.option_text;
      }
    }

    return questionsRes.map((q) => ({
      id: q.external_id ?? "",
      question: q.question_text,
      a: optionsByQuestionId[q.id]?.A ?? "",
      b: optionsByQuestionId[q.id]?.B ?? "",
      c: optionsByQuestionId[q.id]?.C ?? "",
      d: optionsByQuestionId[q.id]?.D ?? "",
      correct: q.correct_option ?? "",
      source_type: q.source_type ?? "manual",
      is_verified: q.is_verified === 1,
      subject_code: q.subject_code ?? "unknown",
      subject_name: q.subject_name ?? "Unknown",
      topic_code: q.topic_code ?? "unknown",
      topic_name: q.topic_name ?? "Unknown",
      classification_confidence: q.classification_confidence ?? null,
      inference_confidence: q.inference_confidence ?? null,
      inference_evidence_basis: q.inference_evidence_basis ?? null,
      inference_insufficient_evidence:
        q.inference_insufficient_evidence === 1,
      inference_matched_question_ids: (() => {
        const parsed = safeParseJson(q.inference_matched_question_ids);
        return Array.isArray(parsed) ? parsed : [];
      })(),
    }));
  }

  function getActiveQuestionsWithOptionsForImport() {
    const rows = db
      .prepare(
        `SELECT
          q.id,
          q.external_id,
          q.question_text,
          q.normalized_question_text,
          q.correct_option,
          q.source_type,
          q.is_verified,
          q.times_seen,
          q.created_at,
          q.updated_at,
          o.option_key,
          o.option_text,
          o.normalized_option_text
        FROM questions q
        LEFT JOIN question_options o
          ON o.question_id = q.id
        WHERE q.is_active = 1
        ORDER BY q.created_at DESC`
      )
      .all();

    const byQuestionId = new Map();
    for (const r of rows) {
      if (!byQuestionId.has(r.id)) {
        byQuestionId.set(r.id, {
          id: r.id,
          external_id: r.external_id ?? "",
          question_text: r.question_text ?? "",
          normalized_question_text: r.normalized_question_text ?? "",
          correct_option: r.correct_option ?? null,
          source_type: r.source_type ?? "manual",
          is_verified: r.is_verified === 1,
          options: {
            A: { option_text: "", normalized_option_text: "" },
            B: { option_text: "", normalized_option_text: "" },
            C: { option_text: "", normalized_option_text: "" },
            D: { option_text: "", normalized_option_text: "" },
          },
        });
      }

      if (r.option_key) {
        byQuestionId.get(r.id).options[r.option_key] = {
          option_text: r.option_text ?? "",
          normalized_option_text: r.normalized_option_text ?? "",
        };
      }
    }

    return Array.from(byQuestionId.values());
  }

  function tokenizeForSearch(text) {
    // Lexical tokenization for deterministic similarity (no stemming).
    const s = String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) return [];
    return s.split(" ").filter(Boolean).filter((t) => t.length >= 2);
  }

  function toTokenSet(tokens) {
    return new Set(tokens);
  }

  function jaccardFromSets(aSet, bSet) {
    if (aSet.size === 0 && bSet.size === 0) return 1;
    if (aSet.size === 0 || bSet.size === 0) return 0;
    let inter = 0;
    for (const x of aSet) if (bSet.has(x)) inter++;
    const union = aSet.size + bSet.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  function overlapTokens(aSet, bSet, limit = 12) {
    const out = [];
    for (const x of aSet) {
      if (bSet.has(x)) out.push(x);
      if (out.length >= limit) break;
    }
    return out;
  }

  function optionSimilarityOrderAgnostic({ incomingOptionTokenSets, candidateOptionTokenSets }) {
    // For each incoming option: best match among candidate options, then average.
    const bestMatches = [];
    let sum = 0;
    for (let i = 0; i < incomingOptionTokenSets.length; i++) {
      const incoming = incomingOptionTokenSets[i];
      let best = { j: -1, score: 0 };
      for (let j = 0; j < candidateOptionTokenSets.length; j++) {
        const score = jaccardFromSets(incoming, candidateOptionTokenSets[j]);
        if (score > best.score) best = { j, score };
      }
      sum += best.score;
      bestMatches.push(best);
    }
    const avg = sum / incomingOptionTokenSets.length;
    return { avg, bestMatches };
  }

  function buildFtsQueryFromTokens(tokens, maxTerms = 18) {
    const unique = Array.from(new Set(tokens));
    const filtered = unique.filter((t) => t.length >= 2);
    const limited = filtered.slice(0, maxTerms);
    // OR query improves recall for short questions.
    return limited.map((t) => t.replace(/[^a-z0-9\-]/g, "")).filter(Boolean).join(" OR ");
  }

  function parseQuestionTextForRetrieval(questionText) {
    const { question, options } = parseAiQuestionText(questionText);
    return { question, options };
  }

  async function retrieveSimilarQuestions({
    questionText,
    topN = 10,
    semanticMode = "auto", // "auto" | "on" | "off"
  } = {}) {
    const parsed = parseQuestionTextForRetrieval(questionText);
    const incomingQuestion = parsed.question ?? "";
    const incomingOptions = parsed.options ?? { A: "", B: "", C: "", D: "" };

    const classification = classifyQuestion({
      externalId: null,
      questionText: incomingQuestion,
      options: incomingOptions,
    });

    const incomingQuestionTokens = tokenizeForSearch(incomingQuestion);
    const incomingQuestionSet = toTokenSet(incomingQuestionTokens);

    const incomingOptionKeys = ["A", "B", "C", "D"];
    const incomingOptionTokenSets = incomingOptionKeys.map((k) => toTokenSet(tokenizeForSearch(incomingOptions[k] ?? "")));

    const combinedForFts = [incomingQuestion, ...incomingOptionKeys.map((k) => incomingOptions[k] ?? "")].join(" ");
    const ftsTokens = tokenizeForSearch(combinedForFts);
    const ftsQuery = buildFtsQueryFromTokens(ftsTokens);

    const strictSubject =
      classification.subject_code !== "unknown" &&
      classification.classification_confidence >= 0.6 &&
      typeof classification.subject_code === "string";

    const semanticEnabled =
      semanticMode === "on" ? Boolean(openai) : semanticMode === "off" ? false : Boolean(openai);
    let queryQuestionEmbedding = null;
    let queryCombinedEmbedding = null;

    if (semanticEnabled) {
      const normalizedQuestionForEmbed = normalizeText(incomingQuestion);
      const normalizedOptionsForEmbed = {
        A: normalizeText(incomingOptions.A),
        B: normalizeText(incomingOptions.B),
        C: normalizeText(incomingOptions.C),
        D: normalizeText(incomingOptions.D),
      };
      const questionDoc = String(normalizedQuestionForEmbed ?? "").trim();
      // Order-agnostic: sort options before embedding doc.
      const optionValues = [
        normalizedOptionsForEmbed.A,
        normalizedOptionsForEmbed.B,
        normalizedOptionsForEmbed.C,
        normalizedOptionsForEmbed.D,
      ]
        .slice()
        .sort();
      const combinedDoc = `${questionDoc} ${optionValues.join(" ")}`.trim();
      try {
        const [qe, ce] = await embedTexts([questionDoc, combinedDoc]);
        queryQuestionEmbedding = qe;
        queryCombinedEmbedding = ce;
      } catch (e) {
        // Semantic similarity becomes best-effort only.
        queryQuestionEmbedding = null;
        queryCombinedEmbedding = null;
      }
    }

    // 1) Candidate generation using FTS if available.
    let candidateRows = [];
    try {
      const ftsAvailable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions_fts' LIMIT 1")
        .get();

      if (ftsAvailable && ftsQuery) {
        const candidateSql = strictSubject
          ? `SELECT
               q.id,
               q.external_id,
               q.question_text,
               q.normalized_question_text,
               q.correct_option,
               q.source_type,
               q.is_verified,
               q.subject_code, q.subject_name,
               q.topic_code, q.topic_name,
               q.classification_confidence,
               q.embedding_json
             FROM questions_fts f
             JOIN questions q ON q.id = f.question_id
             WHERE q.is_active = 1 AND q.subject_code = @subject_code
               AND f.doc MATCH @match
             ORDER BY bm25(f) ASC
             LIMIT @limit`
          : `SELECT
               q.id,
               q.external_id,
               q.question_text,
               q.normalized_question_text,
               q.correct_option,
               q.source_type,
               q.is_verified,
               q.subject_code, q.subject_name,
               q.topic_code, q.topic_name,
               q.classification_confidence,
               q.embedding_json
             FROM questions_fts f
             JOIN questions q ON q.id = f.question_id
             WHERE q.is_active = 1
               AND f.doc MATCH @match
             ORDER BY bm25(f) ASC
             LIMIT @limit`;

        candidateRows = db
          .prepare(candidateSql)
          .all({
            subject_code: classification.subject_code,
            match: ftsQuery,
            limit: 200,
          });
      }
    } catch {
      // If FTS fails for any reason, we fallback to scan.
    }

    // 2) Fallback scan if FTS yields nothing.
    if (!candidateRows || candidateRows.length === 0) {
      candidateRows = db
        .prepare(
          strictSubject
            ? `SELECT
                 id, external_id, question_text, normalized_question_text, correct_option, is_verified,
                 subject_code, subject_name, topic_code, topic_name, classification_confidence, embedding_json
               FROM questions
               WHERE is_active = 1 AND subject_code = @subject_code
               ORDER BY updated_at DESC
               LIMIT 200`
            : `SELECT
                 id, external_id, question_text, normalized_question_text, correct_option, is_verified,
                 subject_code, subject_name, topic_code, topic_name, classification_confidence, embedding_json
               FROM questions
               WHERE is_active = 1
               ORDER BY updated_at DESC
               LIMIT 200`
        )
        .all({ subject_code: classification.subject_code });
    }

    const candidateIds = candidateRows.map((r) => r.id);
    const placeholders = candidateIds.map(() => "?").join(",");
    let optionRows = [];
    if (candidateIds.length > 0) {
      optionRows = db
        .prepare(
          `SELECT question_id, option_key, option_text, normalized_option_text
           FROM question_options
           WHERE question_id IN (${placeholders})`
        )
        .all(...candidateIds);
    }

    const optionsByQid = new Map();
    for (const qid of candidateIds) {
      optionsByQid.set(qid, {
        A: { option_text: "", normalized_option_text: "" },
        B: { option_text: "", normalized_option_text: "" },
        C: { option_text: "", normalized_option_text: "" },
        D: { option_text: "", normalized_option_text: "" },
      });
    }
    for (const or of optionRows) {
      const row = optionsByQid.get(or.question_id);
      if (!row) continue;
      row[or.option_key] = {
        option_text: or.option_text ?? "",
        normalized_option_text: or.normalized_option_text ?? "",
      };
    }

    // If semantic is enabled, compute embeddings for a small number of top candidates that miss them.
    // This keeps hybrid ranking practical while avoiding embedding generation for the whole corpus per request.
    if (semanticEnabled && queryCombinedEmbedding && candidateRows.length > 0) {
      const semanticComputeLimit = 20;
      let computed = 0;

      for (let i = 0; i < Math.min(candidateRows.length, semanticComputeLimit); i++) {
        const c = candidateRows[i];
        const parsed = safeParseJson(c.embedding_json);
        const hasCombined =
          parsed &&
          parsed.version === 2 &&
          Array.isArray(parsed.combined_embedding) &&
          parsed.combined_embedding.length > 0;

        if (hasCombined) continue;

        try {
          const stored = await ensureQuestionEmbeddings(c.id);
          c.embedding_json = JSON.stringify(stored);
          computed++;
        } catch {
          // Best-effort only. Leave semantic disabled for this candidate.
        }

        if (computed >= semanticComputeLimit) break;
      }
    }

    // 3) Compute similarity & rank.
    const results = candidateRows.map((c) => {
      const candidateQuestionTokens = tokenizeForSearch(c.normalized_question_text ?? c.question_text ?? "");
      const candidateQuestionSet = toTokenSet(candidateQuestionTokens);
      const questionSim = jaccardFromSets(incomingQuestionSet, candidateQuestionSet);

      const incomingOptKeys = ["A", "B", "C", "D"];
      const candidateOptionTokenSets = incomingOptKeys.map((k) =>
        toTokenSet(tokenizeForSearch((optionsByQid.get(c.id)?.[k]?.normalized_option_text ?? "")))
      );

      const optionSimRes = optionSimilarityOrderAgnostic({
        incomingOptionTokenSets,
        candidateOptionTokenSets,
      });

      const optionSim = optionSimRes.avg;
      const combinedSim = questionSim * 0.65 + optionSim * 0.35;

      let subjectBoost = 0;
      if (classification.subject_code !== "unknown" && classification.classification_confidence >= 0.6) {
        if (c.subject_code === classification.subject_code) {
          subjectBoost += 0.08 * classification.classification_confidence;
          if (c.topic_code && classification.topic_code !== "unknown" && c.topic_code === classification.topic_code) {
            subjectBoost += 0.04;
          }
        }
      }

      if (c.is_verified === 1) subjectBoost += 0.02;

      // Semantic similarity: cosine similarity over embeddings (best-effort).
      // We only use semantic when both query and candidate embeddings are available.
      let semCosine = null;
      let semScore01 = null;
      let semanticUsed = false;

      if (queryCombinedEmbedding && c.embedding_json) {
        const parsed = safeParseJson(c.embedding_json);
        const candidateCombinedEmbedding = parsed?.combined_embedding ?? null;
        if (
          parsed?.version === 2 &&
          Array.isArray(candidateCombinedEmbedding) &&
          candidateCombinedEmbedding.length > 0
        ) {
          const cos = cosineSimilarity(queryCombinedEmbedding, candidateCombinedEmbedding);
          if (typeof cos === "number") {
            semCosine = cos;
            semScore01 = (cos + 1) / 2; // map [-1..1] -> [0..1]
            semanticUsed = true;
          }
        }
      }

      const semWeight = semanticUsed ? 0.4 : 0;
      const lexWeight = semanticUsed ? 0.6 : 1.0;
      const finalScore = combinedSim * lexWeight + (semScore01 ?? 0) * semWeight + subjectBoost;

      const matchedQuestionTokens = overlapTokens(incomingQuestionSet, candidateQuestionSet, 14);

      const bestMatches = optionSimRes.bestMatches.map((bm, idx) => {
        const candidateKey = incomingOptKeys[bm.j] ?? null;
        return {
          incoming_option_key: incomingOptKeys[idx],
          matched_candidate_option_key: candidateKey,
          jaccard: Number(bm.score.toFixed(3)),
        };
      });

      return {
        matched_question_id: c.id,
        matched_external_id: c.external_id ?? "",
        similarity_score: Number(finalScore.toFixed(4)),
        similarity_evidence: {
          question_sim: Number(questionSim.toFixed(4)),
          option_sim: Number(optionSim.toFixed(4)),
          combined_sim: Number(combinedSim.toFixed(4)),
          semantic_used: semanticUsed,
          semantic_cosine: semCosine === null ? null : Number(semCosine.toFixed(4)),
          semantic_score_01: semScore01 === null ? null : Number(semScore01.toFixed(4)),
          subject_boost: Number(subjectBoost.toFixed(4)),
          matched_question_tokens: matchedQuestionTokens,
        },
        reason: {
          evidence: semanticUsed
            ? "hybrid(lexical_token_jaccard + semantic_cosine_embeddings) + subject-aware boost"
            : "lexical_token_jaccard + subject-aware boost (semantic embeddings missing/unavailable)",
          option_best_matches: bestMatches,
        },
        subject_code: c.subject_code ?? "unknown",
        subject_name: c.subject_name ?? "Unknown",
        topic_code: c.topic_code ?? "unknown",
        topic_name: c.topic_name ?? "Unknown",
        known_correct: c.correct_option ?? null,
        options: optionsByQid.get(c.id) ?? { A: {}, B: {}, C: {}, D: {} },
        question_text: c.question_text ?? "",
      };
    });

    results.sort((a, b) => b.similarity_score - a.similarity_score);
    return { classification, candidates: results.slice(0, topN) };
  }

  function setQuestionClassificationByExternalId({
    externalId,
    subject_code,
    subject_name,
    topic_code,
    topic_name,
    classification_confidence,
    classification_evidence_json,
  }) {
    const t = nowIso();
    const payload = {
      external_id: externalId ?? null,
      subject_code: subject_code ?? "unknown",
      subject_name: subject_name ?? "Unknown",
      topic_code: topic_code ?? "unknown",
      topic_name: topic_name ?? "Unknown",
      classification_confidence:
        classification_confidence === null || classification_confidence === undefined
          ? null
          : Number(classification_confidence),
      classification_evidence_json:
        classification_evidence_json === null || classification_evidence_json === undefined
          ? JSON.stringify({})
          : typeof classification_evidence_json === "string"
            ? classification_evidence_json
            : JSON.stringify(classification_evidence_json),
      updated_at: t,
    };

    const info = db
      .prepare(
        `UPDATE questions
         SET
           subject_code = @subject_code,
           subject_name = @subject_name,
           topic_code = @topic_code,
           topic_name = @topic_name,
           classification_confidence = @classification_confidence,
           classification_evidence_json = @classification_evidence_json,
           updated_at = @updated_at
         WHERE external_id = @external_id`
      )
      .run(payload);

    return { changedRows: info.changes };
  }

  function setQuestionVerificationByExternalId({
    externalId,
    verified,
    unverifiedSourceType,
  }) {
    const t = nowIso();
    const nextSourceType = verified ? "manual" : unverifiedSourceType ?? "AI_inferred_needs_review";

    const info = db
      .prepare(
        `UPDATE questions
         SET source_type = @source_type,
             is_verified = @is_verified,
             updated_at = @updated_at
         WHERE external_id = @external_id`
      )
      .run({
        external_id: externalId ?? null,
        source_type: nextSourceType,
        is_verified: verified ? 1 : 0,
        updated_at: t,
      });

    return { changedRows: info.changes };
  }

  function upsertImportedQuestionWithoutDeactivation({
    externalId,
    questionText,
    options,
    correctOption,
    sourceType,
    isVerified,
  }) {
    const normalizedQuestionText = normalizeText(questionText);
    const normalizedOptions = {
      A: normalizeText(options.A),
      B: normalizeText(options.B),
      C: normalizeText(options.C),
      D: normalizeText(options.D),
    };

    return upsertQuestionAndOptions({
      externalId,
      questionText: questionText,
      options: {
        A: options.A,
        B: options.B,
        C: options.C,
        D: options.D,
      },
      correctOption,
      sourceType,
      isVerified,
      setIsActive: true,
    });
  }

  function updateQuestionAndOptionsById({
    questionId,
    // If preserveRaw is true, we do not overwrite raw question_text / option_text.
    preserveRaw,
    questionText,
    normalizedQuestionText,
    options,
    normalizedOptions,
    correctOption,
    sourceType,
    isVerified,
  }) {
    const t = nowIso();

    // Question row
    db.prepare(
      `UPDATE questions
       SET
         ${preserveRaw ? "question_text = question_text," : "question_text = @question_text,"}
         normalized_question_text = @normalized_question_text,
         correct_option = @correct_option,
         source_type = @source_type,
         is_verified = @is_verified,
         updated_at = @updated_at
       WHERE id = @id`
    ).run({
      id: questionId,
      question_text: String(questionText ?? ""),
      normalized_question_text: String(normalizedQuestionText ?? ""),
      correct_option: correctOption,
      source_type: sourceType,
      is_verified: isVerified ? 1 : 0,
      updated_at: t,
    });

    // Options row
    const optionKeys = ["A", "B", "C", "D"];
    for (const optionKey of optionKeys) {
      const rawText = String(options[optionKey] ?? "").trim();
      const normalizedText = String(normalizedOptions[optionKey] ?? "").trim();

      db.prepare(
        `UPDATE question_options
         SET
           ${preserveRaw ? "option_text = option_text," : "option_text = @option_text,"}
           normalized_option_text = @normalized_option_text
         WHERE question_id = @question_id AND option_key = @option_key`
      ).run({
        question_id: questionId,
        option_key: optionKey,
        option_text: rawText,
        normalized_option_text: normalizedText,
      });
    }

    // Update FTS for lexical retrieval using normalized content we were given.
    updateFtsForQuestion(questionId, normalizedQuestionText, {
      A: normalizedOptions.A,
      B: normalizedOptions.B,
      C: normalizedOptions.C,
      D: normalizedOptions.D,
    });
  }

  function saveActiveQuestions({ rows }) {
    // Upsert questions+options, then mark only these fingerprints as active.
    const fingerprints = [];

    for (const row of rows) {
      const correctOption = normalizeCorrectOption(row.correct);
      if (!correctOption) continue;

      const sourceType = String(row.source_type ?? "manual").trim() || "manual";
      const isVerified = row.is_verified ?? ["manual", "imported"].includes(sourceType);

      const questionId = upsertQuestionAndOptions({
        externalId: row.id,
        questionText: row.question,
        options: { A: row.a, B: row.b, C: row.c, D: row.d },
        correctOption,
        sourceType,
        isVerified,
        setIsActive: true,
        inferenceConfidence: row.inference_confidence ?? null,
        inferenceEvidenceBasis: row.inference_evidence_basis ?? null,
        inferenceInsufficientEvidence: row.inference_insufficient_evidence ?? null,
        inferenceMatchedQuestionIds: row.inference_matched_question_ids ?? [],
      });

      // Recompute fingerprint to collect it for deactivation update.
      const normalizedQuestionText = normalizeText(row.question);
      const normalizedOptions = {
        A: normalizeText(row.a),
        B: normalizeText(row.b),
        C: normalizeText(row.c),
        D: normalizeText(row.d),
      };
      fingerprints.push(fingerprintFrom(normalizedQuestionText, normalizedOptions));
    }

    // Deactivate everything else so UI behaves like the old "overwrite list" behavior.
    setQuestionsActiveByFingerprints({ fingerprints });
  }

  function recordAiAttempt({ questionText, provider, answerChoice, rawResponse }) {
    const { question, options } = parseAiQuestionText(questionText);
    const correctOption = normalizeCorrectOption(answerChoice);
    if (!correctOption) return;

    const normalizedQuestionText = normalizeText(question);
    const normalizedOptions = {
      A: normalizeText(options.A),
      B: normalizeText(options.B),
      C: normalizeText(options.C),
      D: normalizeText(options.D),
    };
    const fingerprint = fingerprintFrom(normalizedQuestionText, normalizedOptions);
    const existing = db.prepare("SELECT id, is_verified, is_active FROM questions WHERE fingerprint = ?").get(fingerprint);

    // Never downgrade a verified question's correctness/source.
    if (existing && existing.is_verified === 1) {
      const t = nowIso();
      db.prepare(
        `INSERT INTO question_attempts (
          id, question_id, attempt_type, provider, model_raw_response, answer_choice, success, created_at
        ) VALUES (
          @id, @question_id, 'AI_answer_generation', @provider, @model_raw_response, @answer_choice, 1, @created_at
        )`
      ).run({
        id: crypto.randomUUID(),
        question_id: existing.id,
        provider: provider ?? null,
        model_raw_response: rawResponse ?? null,
        answer_choice: correctOption,
        created_at: t,
      });

      db.prepare(`UPDATE questions SET times_seen = times_seen + 1, updated_at = ? WHERE id = ?`).run(t, existing.id);
      return;
    }

    const sourceType = "AI_inferred";
    const isVerified = false;
    const setIsActive = existing ? existing.is_active === 1 : false;

    const questionId = upsertQuestionAndOptions({
      externalId: null,
      questionText: question,
      options,
      correctOption,
      sourceType,
      isVerified,
      setIsActive,
    });

    const t = nowIso();
    db.prepare(
      `INSERT INTO question_attempts (
        id, question_id, attempt_type, provider, model_raw_response, answer_choice, success, created_at
      ) VALUES (
        @id, @question_id, 'AI_answer_generation', @provider, @model_raw_response, @answer_choice, 1, @created_at
      )`
    ).run({
      id: crypto.randomUUID(),
      question_id: questionId,
      provider: provider ?? null,
      model_raw_response: rawResponse ?? null,
      answer_choice: correctOption,
      created_at: t,
    });

    db.prepare(`UPDATE questions SET times_seen = times_seen + 1, updated_at = ? WHERE id = ?`).run(t, questionId);
  }

  function migrateQuestionsJson({ db, rows }) {
    const insertTx = db.transaction(() => {
      for (const row of rows) {
        const correctOption = normalizeCorrectOption(row.correct);
        if (!correctOption) continue;
        if (typeof row.question !== "string") continue;
        if (typeof row.a !== "string" || typeof row.b !== "string" || typeof row.c !== "string" || typeof row.d !== "string") continue;

        const options = { A: row.a, B: row.b, C: row.c, D: row.d };
        upsertQuestionAndOptions({
          externalId: row.id,
          questionText: row.question,
          options,
          correctOption,
          sourceType: "imported",
          isVerified: true,
          setIsActive: true,
        });
      }
    });

    insertTx();
  }

  // Stage 4: classify existing active corpus if classification is missing.
  // This keeps the MVP stable when we add new classification columns after the first run.
  const missingToClassify = db
    .prepare(
      `SELECT id, external_id, question_text
       FROM questions
       WHERE is_active = 1
         AND (subject_code IS NULL OR classification_confidence IS NULL)`
    )
    .all();

  if (missingToClassify.length > 0) {
    const optionRowsFor = db.prepare(
      `SELECT option_key, option_text
       FROM question_options
       WHERE question_id = @qid`
    );

    const updateStmt = db.prepare(
      `UPDATE questions
       SET
         subject_code = @subject_code,
         subject_name = @subject_name,
         topic_code = @topic_code,
         topic_name = @topic_name,
         classification_confidence = @classification_confidence,
         classification_evidence_json = @classification_evidence_json,
         updated_at = @updated_at
       WHERE id = @id`
    );

    for (const q of missingToClassify) {
      const optionsRows = optionRowsFor.all({ qid: q.id });
      const options = { A: "", B: "", C: "", D: "" };
      for (const or of optionsRows) {
        if (or.option_key && ["A", "B", "C", "D"].includes(or.option_key)) {
          options[or.option_key] = or.option_text ?? "";
        }
      }

      const classification = classifyQuestion({
        externalId: q.external_id,
        questionText: q.question_text,
        options,
      });

      updateStmt.run({
        id: q.id,
        subject_code: classification.subject_code ?? "unknown",
        subject_name: classification.subject_name ?? "Unknown",
        topic_code: classification.topic_code ?? "unknown",
        topic_name: classification.topic_name ?? "Unknown",
        classification_confidence: classification.classification_confidence ?? null,
        classification_evidence_json: JSON.stringify(classification.evidence ?? {}),
        updated_at: nowIso(),
      });
    }
  }

  return {
    getActiveQuestions,
    getActiveQuestionsWithOptionsForImport,
    upsertImportedQuestionWithoutDeactivation,
    retrieveSimilarQuestions,
    updateQuestionAndOptionsById,
    saveActiveQuestions,
    recordAiAttempt,
    buildMissingEmbeddings,
    setQuestionClassificationByExternalId,
    setQuestionVerificationByExternalId,
  };
}

