import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import crypto from "crypto";
import { initSqliteStore } from "./storage/sqliteStore.js";
import { parseStrictRerankerJson } from "./storage/modelContracts.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const openaiKey = process.env.OPENAI_API_KEY;
const googleApiKey = process.env.GOOGLE_API_KEY;

let openai;
if (openaiKey) {
  openai = new OpenAI({ apiKey: openaiKey });
}

const questionsFile = process.env.EASA_QUESTIONS_JSON_PATH
  ? path.resolve(process.env.EASA_QUESTIONS_JSON_PATH)
  : path.join(__dirname, "questions.json");

// Ensure questions.json exists
if (!fs.existsSync(questionsFile)) {
  fs.writeFileSync(questionsFile, "[]");
}

const dbPath = process.env.EASA_DB_PATH ? path.resolve(process.env.EASA_DB_PATH) : path.join(__dirname, "data", "easa-atpl.sqlite");
const store = initSqliteStore({ dbPath, questionsJsonPath: questionsFile });

const logsDir = path.join(__dirname, "logs");
const modelLogsFile = path.join(logsDir, "model-responses.jsonl");

function ensureDirExists(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // Non-fatal: logging must never break the server.
  }
}

function safeTruncate(str, maxLen) {
  if (typeof str !== "string") return "";
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

function normalizeQuestionId(id) {
  return String(id || "").trim().toLowerCase().replace(/:/g, "");
}

function normalizeCorrectValue(value) {
  // Accept "A"-"D" (any case) and "1"-"4" for backwards compatibility.
  const s = String(value ?? "").trim().toUpperCase();
  const map = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const letter = map[s] ?? s;
  if (!["A", "B", "C", "D"].includes(letter)) return null;
  return letter;
}

function sendApiError(res, status, code, message, details) {
  const payload = { error: message, code };
  if (details !== undefined) payload.details = details;
  return res.status(status).json(payload);
}

function logModelInteraction({ provider, questionText, rawResponse, parsedAnswer, error }) {
  try {
    ensureDirExists(logsDir);
    const questionHash = crypto.createHash("sha256").update(String(questionText)).digest("hex");
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      provider,
      questionHash,
      questionPreview: safeTruncate(String(questionText ?? ""), 400),
      rawResponsePreview: safeTruncate(String(rawResponse ?? ""), 10000),
      parsedAnswer,
      error: error ? String(error?.message ?? error) : undefined,
    });
    fs.appendFileSync(modelLogsFile, line + "\n", "utf8");
  } catch {
    // Logging must never break the request.
  }
}

function validateQuestionsArray(payload) {
  if (!Array.isArray(payload)) {
    return { ok: false, error: "Invalid data: expected an array" };
  }

  const out = [];
  for (let i = 0; i < payload.length; i++) {
    const row = payload[i] ?? {};
    const id = row.id;
    const question = row.question;
    const a = row.a;
    const b = row.b;
    const c = row.c;
    const d = row.d;
    const correct = normalizeCorrectValue(row.correct);
    const sourceTypeRaw = row.source_type ?? row.sourceType ?? "manual";
    const source_type = String(sourceTypeRaw).trim() || "manual";
    // Keep verification conservative: manual/imported are treated as verified, AI_inferred as unverified.
    // (This matches sqlite migration logic.)
    const is_verified = ["manual", "imported"].includes(source_type);

    const inference_confidence_raw = row.inference_confidence ?? row.confidence ?? null;
    const inference_confidence =
      inference_confidence_raw === null || inference_confidence_raw === undefined
        ? null
        : Number(inference_confidence_raw);
    if (
      inference_confidence !== null &&
      (!Number.isFinite(inference_confidence) || inference_confidence < 0 || inference_confidence > 1)
    ) {
      return { ok: false, error: `Row ${i}: invalid inference_confidence (expected 0..1)` };
    }

    const inference_evidence_basis = row.inference_evidence_basis ?? row.evidence_basis ?? null;
    if (
      inference_evidence_basis !== null &&
      inference_evidence_basis !== undefined &&
      typeof inference_evidence_basis !== "string"
    ) {
      return { ok: false, error: `Row ${i}: invalid inference_evidence_basis (string expected)` };
    }

    const inference_insufficient_evidence_raw =
      row.inference_insufficient_evidence ?? row.insufficient_evidence ?? null;
    const inference_insufficient_evidence =
      inference_insufficient_evidence_raw === null || inference_insufficient_evidence_raw === undefined
        ? null
        : Boolean(inference_insufficient_evidence_raw);

    const inference_matched_question_ids_raw =
      row.inference_matched_question_ids ?? row.matched_question_ids ?? null;
    let inference_matched_question_ids = null;
    if (inference_matched_question_ids_raw === null || inference_matched_question_ids_raw === undefined) {
      inference_matched_question_ids = [];
    } else if (Array.isArray(inference_matched_question_ids_raw)) {
      if (inference_matched_question_ids_raw.some((x) => typeof x !== "string")) {
        return { ok: false, error: `Row ${i}: invalid inference_matched_question_ids (string[])` };
      }
      inference_matched_question_ids = inference_matched_question_ids_raw;
    } else {
      return { ok: false, error: `Row ${i}: invalid inference_matched_question_ids (expected array)` };
    }

    if (typeof id !== "string" || id.trim().length < 1) return { ok: false, error: `Row ${i}: invalid id` };
    if (typeof question !== "string" || question.trim().length < 1) return { ok: false, error: `Row ${i}: invalid question` };
    if (typeof a !== "string") return { ok: false, error: `Row ${i}: invalid a` };
    if (typeof b !== "string") return { ok: false, error: `Row ${i}: invalid b` };
    if (typeof c !== "string") return { ok: false, error: `Row ${i}: invalid c` };
    if (typeof d !== "string") return { ok: false, error: `Row ${i}: invalid d` };
    if (!correct) return { ok: false, error: `Row ${i}: invalid correct (expected A-D or 1-4)` };

    out.push({
      id: id.trim(),
      question: question.trim(),
      a: a.trim(),
      b: b.trim(),
      c: c.trim(),
      d: d.trim(),
      correct,
      source_type,
      is_verified,
      inference_confidence,
      inference_evidence_basis,
      inference_insufficient_evidence,
      inference_matched_question_ids,
    });
  }

  return { ok: true, value: out };
}

function dedupeQuestionsById(rows, label = "questions") {
  const seen = new Set();
  const deduped = [];
  const droppedDuplicates = [];

  for (const row of rows) {
    const normId = normalizeQuestionId(row.id);
    if (seen.has(normId)) {
      droppedDuplicates.push(row.id);
      continue;
    }
    seen.add(normId);
    deduped.push(row);
  }

  if (droppedDuplicates.length > 0) {
    console.warn(
      `Duplicate question IDs detected in ${label}: dropped ${droppedDuplicates.length} item(s).`,
      { example: droppedDuplicates.slice(0, 5) }
    );
  }

  return { deduped, droppedDuplicates };
}

function loadQuestions() {
  try {
    const data = fs.readFileSync(questionsFile, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.warn("Failed to load questions, starting with empty list", err);
    return [];
  }
}

function saveQuestions(questions) {
  try {
    // Atomic-ish write to avoid partially written JSON on crashes.
    const tempPath = `${questionsFile}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(questions, null, 2), "utf8");
    fs.renameSync(tempPath, questionsFile);
  } catch (err) {
    console.error("Failed to save questions", err);
  }
}

let questions = loadQuestions();
const initialValidation = validateQuestionsArray(questions);
if (!initialValidation.ok) {
  console.warn(
    "questions.json had invalid data; attempting to salvage valid rows:",
    initialValidation.error
  );
  if (Array.isArray(questions)) {
    const sanitized = [];
    for (const row of questions) {
      const rowValidation = validateQuestionsArray([row]);
      if (rowValidation.ok) {
        sanitized.push(rowValidation.value[0]);
      } else {
        console.warn("Dropping invalid row from questions.json:", rowValidation.error);
      }
    }
    const dedupeRes = dedupeQuestionsById(sanitized, "questions.json (salvage)");
    questions = dedupeRes.deduped;
  } else {
    questions = [];
  }
} else {
  const dedupeRes = dedupeQuestionsById(initialValidation.value, "questions.json");
  questions = dedupeRes.deduped;
}

async function queryGemini(questionText) {
  // Caller provides full instruction + question content (including JSON contract).
  const prompt = questionText.trim();

  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    googleApiKey
  )}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${response.statusText} — ${errBody}`);
  }

  const data = await response.json();

  function extractText(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj === "string") return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = extractText(item);
        if (found) return found;
      }
      return null;
    }
    // common fields
    const candidates = obj.candidates || obj.candidate || obj.responses || obj.response;
    if (candidates) return extractText(candidates);

    const content = obj.content || obj.contents;
    if (content) return extractText(content);

    const parts = obj.parts || obj.part;
    if (parts) return extractText(parts);

    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.output === "string") return obj.output;

    // fallback: check all values
    for (const key of Object.keys(obj)) {
      const found = extractText(obj[key]);
      if (found) return found;
    }
    return null;
  }

  // Prefer deterministic fields, but keep a safe fallback.
  const preferred =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text)
      .filter((t) => typeof t === "string")
      .join("") ?? null;

  const text = preferred || extractText(data);

  if (!text || typeof text !== "string") {
    console.error("Gemini response (unexpected):", JSON.stringify(data, null, 2));
    throw new Error("Unexpected Gemini response format");
  }

  return text.trim();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/answer", async (req, res) => {
  const { questionText } = req.body || {};
  if (!questionText || typeof questionText !== "string") {
    return sendApiError(res, 400, "INVALID_PAYLOAD", "Invalid request payload");
  }

  const content = questionText.trim();
  if (content.length < 5) {
    return sendApiError(res, 400, "INVALID_QUESTION_TEXT", "Question text is too short");
  }
  if (content.length > 8000) {
    return sendApiError(res, 400, "QUESTION_TEXT_TOO_LONG", "Question text is too long");
  }

  const provider = openai ? "openai" : "gemini";

  // Retrieval is used to provide explainable references to the model.
  let retrieval = null;
  try {
    retrieval = await store.retrieveSimilarQuestions({ questionText: content, topN: 5 });
  } catch (e) {
    console.warn("Retrieval failed, continuing without references:", e?.message ?? e);
  }

  const systemHint =
    "You are an expert EASA ATPL question reranker.\n" +
    "You MUST use ONLY the provided retrieval evidence (similar examples) to decide the answer.\n" +
    "Do NOT use general knowledge as a substitute.\n" +
    "If retrieval evidence is weak, set insufficient_evidence=true and use low confidence.\n" +
    "Return ONLY strict JSON that matches this schema:\n" +
    '{"suggested_answer":"A"|"B"|"C"|"D","confidence":0..1,"evidence_basis":"string","matched_question_ids":"string[]","insufficient_evidence":true|false}\n' +
    "No extra keys. No Markdown. No explanation.\n";

  const referencesBlock = retrieval?.candidates?.length
    ? retrieval.candidates
        .slice(0, 5)
        .map((c, idx) => {
          const A = c.options?.A?.option_text ?? "";
          const B = c.options?.B?.option_text ?? "";
          const C = c.options?.C?.option_text ?? "";
          const D = c.options?.D?.option_text ?? "";
          const matchedId = c.matched_question_id ?? c.matched_external_id ?? "";
          return (
            `Similar example ${idx + 1}:\n` +
            `Matched id: ${matchedId}\n` +
            `Subject: ${c.subject_code ?? "unknown"} / ${c.topic_code ?? "unknown"}\n` +
            `Correct: ${c.known_correct ?? "?"}\n` +
            `Question: ${safeTruncate(c.question_text ?? "", 300)}\n` +
            `A) ${safeTruncate(A, 180)}\n` +
            `B) ${safeTruncate(B, 180)}\n` +
            `C) ${safeTruncate(C, 180)}\n` +
            `D) ${safeTruncate(D, 180)}`
          );
        })
        .join("\n\n") + "\n\n"
    : "";

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const qText = lines[0] ?? "";
  const optA = lines[1] ?? "";
  const optB = lines[2] ?? "";
  const optC = lines[3] ?? "";
  const optD = lines[4] ?? "";

  // Bypass LLM if retrieval has a strong near-exact signal.
  const top = retrieval?.candidates?.[0];
  if (
    top?.known_correct &&
    ["A", "B", "C", "D"].includes(String(top.known_correct).trim().toUpperCase()) &&
    top?.similarity_evidence?.combined_sim >= 0.95 &&
    top?.similarity_evidence?.option_sim >= 0.95
  ) {
    return res.json({
      answer: String(top.known_correct).trim().toUpperCase(),
      confidence: Math.min(0.99, Math.max(0.7, Number(top.similarity_score) || 0.9)),
      insufficient_evidence: false,
      matched_question_ids: [top.matched_question_id ?? top.matched_external_id].filter(Boolean),
      llm_used: false,
      evidence_basis: "High-similarity retrieval match; bypassed LLM reranking.",
      retrieval: {
        classification: retrieval?.classification ?? null,
        candidates: (retrieval?.candidates ?? []).slice(0, 5),
      },
    });
  }

  // If no AI provider is configured, still provide a conservative retrieval-only fallback.
  if (!openai && !googleApiKey) {
    const topLetter = top?.known_correct ? String(top.known_correct).trim().toUpperCase() : null;
    if (topLetter && ["A", "B", "C", "D"].includes(topLetter)) {
      const conf = Number(top?.similarity_score) || 0.3;
      return res.json({
        answer: topLetter,
        confidence: Math.min(0.6, Math.max(0.1, conf * 0.5)),
        insufficient_evidence: true,
        matched_question_ids: [top.matched_question_id ?? top.matched_external_id].filter(Boolean),
        llm_used: false,
        evidence_basis: "No AI provider configured; returning retrieval top-candidate only (insufficient evidence).",
        retrieval: {
          classification: retrieval?.classification ?? null,
          candidates: (retrieval?.candidates ?? []).slice(0, 5),
        },
      });
    }

    return sendApiError(
      res,
      503,
      "NO_PROVIDER",
      "No AI provider configured and retrieval evidence is insufficient to produce an answer."
    );
  }

  const userPrompt =
    `New question:\n${qText}\n\n` +
    `A) ${optA}\n` +
    `B) ${optB}\n` +
    `C) ${optC}\n` +
    `D) ${optD}\n\n` +
    `Retrieved similar examples (your only evidence for reranking):\n${referencesBlock}` +
    "Select the best answer option for the NEW question based on the retrieved evidence.\n" +
    "Return strict JSON only.";

  let raw = "";
  try {
    let parsedAnswer;

    if (openai) {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemHint },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 64,
      });

      raw = response.choices?.[0]?.message?.content ?? "";
      parsedAnswer = parseStrictRerankerJson(raw);
    } else if (googleApiKey) {
      raw = await queryGemini(`${systemHint}\n${userPrompt}`);
      parsedAnswer = parseStrictRerankerJson(raw);
    }

    // Enforce explainability: matched ids must come from retrieved candidates.
    const allowedMatchedIds = new Set(
      (retrieval?.candidates ?? [])
        .slice(0, 5)
        .map((c) => c.matched_question_id ?? c.matched_external_id)
        .filter(Boolean)
    );
    const filteredMatched = (parsedAnswer.matched_question_ids ?? []).filter((x) => allowedMatchedIds.has(x));
    if (!parsedAnswer.insufficient_evidence && filteredMatched.length < 1) {
      throw new Error("matched_question_ids must reference retrieved candidates");
    }
    parsedAnswer.matched_question_ids = filteredMatched;

    logModelInteraction({
      provider,
      questionText: content,
      rawResponse: raw,
      parsedAnswer: parsedAnswer?.suggested_answer ?? null,
      error: undefined,
    });

    // Persist attempt history & "seen count" for future ranking/recall.
    try {
      store.recordAiAttempt({
        questionText: content,
        provider,
        answerChoice: parsedAnswer?.suggested_answer,
        rawResponse: raw,
      });
    } catch (e) {
      // Not fatal: answer endpoint should still work.
      console.warn("Failed to record AI attempt to SQLite:", e?.message ?? e);
    }

    return res.json({
      answer: parsedAnswer.suggested_answer,
      confidence: parsedAnswer.confidence,
      evidence_basis: parsedAnswer.evidence_basis,
      matched_question_ids: parsedAnswer.matched_question_ids,
      insufficient_evidence: parsedAnswer.insufficient_evidence,
      llm_used: true,
      retrieval: {
        classification: retrieval?.classification ?? null,
        candidates: (retrieval?.candidates ?? []).slice(0, 5),
      },
    });
  } catch (err) {
    const errMsg = err?.message ?? "Unknown error";

    logModelInteraction({
      provider,
      questionText: content,
      rawResponse: raw,
      parsedAnswer: undefined,
      error: err,
    });

    if (
      err instanceof SyntaxError ||
      errMsg.toLowerCase().includes("model json") ||
      errMsg.toLowerCase().includes("suggested_answer") ||
      errMsg.toLowerCase().includes("insufficient_evidence") ||
      errMsg.toLowerCase().includes("confidence")
    ) {
      return sendApiError(
        res,
        422,
        "MODEL_INVALID_JSON_OR_CONTRACT",
        "Model returned an invalid response. Please retry.",
        { rawResponsePreview: safeTruncate(raw, 200) }
      );
    }

    console.error("AI answer error", err);
    return sendApiError(res, 500, "AI_PROVIDER_ERROR", "Failed to get answer from AI");
  }
});

// Retrieval-only endpoint (for inspectable candidate matches).
app.post("/api/retrieve", (req, res) => {
  const { questionText, topN } = req.body ?? {};
  if (!questionText || typeof questionText !== "string") {
    return sendApiError(res, 400, "INVALID_PAYLOAD", "Invalid request payload");
  }
  const n = Number(topN ?? 10);
  const safeTopN = Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : 10;

  try {
    const resultPromise = store.retrieveSimilarQuestions({ questionText, topN: safeTopN });
    // Handle async retrieval in a simple way.
    Promise.resolve(resultPromise)
      .then((result) => res.json(result))
      .catch((e) => {
        console.error("Retrieval endpoint error", e);
        res
          .status(500)
          .json({ error: "RETRIEVAL_ERROR", details: e?.message ?? String(e) });
      });
    return;
  } catch (e) {
    console.error("Retrieval endpoint error", e);
    return sendApiError(res, 500, "RETRIEVAL_ERROR", "Failed to retrieve candidates");
  }
});

// Build embeddings for active corpus (optional warm-up).
app.post("/api/embeddings/build", async (req, res) => {
  const { limit } = req.body ?? {};
  const n = Number(limit ?? 200);
  const safeLimit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 200;

  try {
    const result = await store.buildMissingEmbeddings({ limit: safeLimit });
    return res.json(result);
  } catch (e) {
    console.error("Embeddings build failed:", e);
    return sendApiError(res, 500, "EMBEDDINGS_BUILD_ERROR", "Failed to build embeddings");
  }
});

app.get("/api/questions", (req, res) => {
  try {
    const data = store.getActiveQuestions();
    console.log("Getting questions:", data.length, "items");
    return res.json(data);
  } catch (e) {
    console.error("Failed to load questions from SQLite", e);
    return sendApiError(res, 500, "DB_ERROR", "Failed to load questions");
  }
});

app.post("/api/questions", (req, res) => {
  const validation = validateQuestionsArray(req.body);
  if (!validation.ok) {
    console.error("Invalid data received:", validation.error);
    return sendApiError(res, 400, "INVALID_QUESTIONS_PAYLOAD", validation.error);
  }

  const incoming = validation.value;
  // Minimal duplicate detection: keep the first occurrence of the normalized external id.
  const seen = new Set();
  const deduped = [];
  const droppedDuplicates = [];

  for (const row of incoming) {
    const normId = normalizeQuestionId(row.id);
    if (seen.has(normId)) {
      droppedDuplicates.push(row.id);
      continue;
    }
    seen.add(normId);
    deduped.push(row);
  }

  if (droppedDuplicates.length > 0) {
    console.warn(
      `Duplicate question IDs detected while saving: dropped ${droppedDuplicates.length} item(s).`,
      { example: droppedDuplicates.slice(0, 5) }
    );
  }

  try {
    store.saveActiveQuestions({ rows: deduped });
    return res.json({ success: true, droppedDuplicates: droppedDuplicates.length });
  } catch (e) {
    console.error("Failed to save questions to SQLite", e);
    return sendApiError(res, 500, "DB_ERROR", "Failed to save questions");
  }
});

// Review/override classification for a known question (by external id).
app.post("/api/questions/:id/classification", (req, res) => {
  const externalId = req.params.id;
  const body = req.body ?? {};

  if (!externalId || typeof externalId !== "string") {
    return sendApiError(res, 400, "INVALID_EXTERNAL_ID", "Invalid question id");
  }

  const classification = {
    subject_code: body.subject_code,
    subject_name: body.subject_name,
    topic_code: body.topic_code,
    topic_name: body.topic_name,
    classification_confidence: body.classification_confidence,
    classification_evidence_json: body.classification_evidence_json,
  };

  try {
    const changed = store.setQuestionClassificationByExternalId({
      externalId,
      ...classification,
    });
    return res.json({ success: true, changedRows: changed.changedRows });
  } catch (e) {
    console.error("Failed to update classification:", e);
    return sendApiError(res, 500, "CLASSIFICATION_UPDATE_ERROR", "Failed to update classification");
  }
});

// Manual review/verification for a known question (by external id).
app.post("/api/questions/:id/review", (req, res) => {
  const externalId = req.params.id;
  const body = req.body ?? {};

  if (!externalId || typeof externalId !== "string") {
    return sendApiError(res, 400, "INVALID_EXTERNAL_ID", "Invalid question id");
  }

  const verified = body.verified;
  if (typeof verified !== "boolean") {
    return sendApiError(res, 400, "INVALID_VERIFIED", "`verified` must be boolean");
  }

  const unverifiedSourceType = body.unverified_source_type;
  if (
    unverifiedSourceType !== undefined &&
    unverifiedSourceType !== null &&
    typeof unverifiedSourceType !== "string"
  ) {
    return sendApiError(res, 400, "INVALID_SOURCE_TYPE", "`unverified_source_type` must be string");
  }

  try {
    const changed = store.setQuestionVerificationByExternalId({
      externalId,
      verified,
      unverifiedSourceType: unverifiedSourceType ?? undefined,
    });
    return res.json({ success: true, changedRows: changed.changedRows });
  } catch (e) {
    console.error("Failed to update review status:", e);
    return sendApiError(res, 500, "REVIEW_UPDATE_ERROR", "Failed to update review status");
  }
});

// Export `app` for integration tests (tests can bind the port themselves).
export { app };

if (process.env.EASA_START_SERVER !== "false") {
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}
