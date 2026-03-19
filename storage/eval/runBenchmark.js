import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { initSqliteStore } from "../sqliteStore.js";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const dbPath = path.join(repoRoot, "data", "easa-atpl.sqlite");
const questionsJsonPath = path.join(repoRoot, "questions.json");
const logsDir = path.join(repoRoot, "logs");
fs.mkdirSync(logsDir, { recursive: true });

function arg(name, defaultValue) {
  const found = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!found) return defaultValue;
  if (found.includes("=")) return found.split("=")[1];
  const next = process.argv[process.argv.indexOf(found) + 1];
  return next ?? defaultValue;
}

function normalizeCorrectLetter(value) {
  const s = String(value ?? "").trim().toUpperCase();
  const map = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const letter = map[s] ?? s;
  if (!["A", "B", "C", "D"].includes(letter)) return null;
  return letter;
}

function safeShort(text, maxLen = 160) {
  const s = String(text ?? "");
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function parseStrictRerankerJson(rawResponse) {
  const trimmed = String(rawResponse ?? "").trim();
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model JSON must be an object");
  }

  const allowedAnswer = normalizeCorrectLetter(parsed.suggested_answer ?? parsed.answer);
  if (!allowedAnswer) throw new Error("Model JSON must include suggested_answer 'A'|'B'|'C'|'D'");

  const confidence = parsed.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Model JSON must include confidence in [0..1]");
  }

  const evidenceBasis = parsed.evidence_basis;
  if (typeof evidenceBasis !== "string" || evidenceBasis.trim().length < 5) {
    throw new Error("Model JSON must include evidence_basis");
  }

  const matchedQuestionIds = parsed.matched_question_ids;
  if (!Array.isArray(matchedQuestionIds) || matchedQuestionIds.some((x) => typeof x !== "string")) {
    throw new Error("Model JSON must include matched_question_ids as string[]");
  }

  const insufficientEvidence = parsed.insufficient_evidence;
  if (typeof insufficientEvidence !== "boolean") {
    throw new Error("Model JSON must include insufficient_evidence boolean");
  }

  if (insufficientEvidence && confidence > 0.6) {
    throw new Error("insufficient_evidence=true requires confidence <= 0.6");
  }

  return {
    suggested_answer: allowedAnswer,
    confidence: Number(confidence),
    evidence_basis: evidenceBasis.trim(),
    matched_question_ids: matchedQuestionIds,
    insufficient_evidence: insufficientEvidence,
  };
}

function legacyParseDirectAnswer(rawResponse) {
  const s = String(rawResponse ?? "");
  const m = s.match(/[ABCDabcd1234]/);
  if (!m) return null;
  const token = m[0].toUpperCase();
  return normalizeCorrectLetter(token);
}

function shuffleByPermutation(originalOptions, correctKey, perm) {
  // perm defines which original key goes into new keys A,B,C,D in order.
  const newKeys = ["A", "B", "C", "D"];
  const newOptions = {};
  for (let i = 0; i < 4; i++) {
    newOptions[newKeys[i]] = originalOptions[perm[i]];
  }
  // Correct key becomes whichever new key got the original correct option.
  const correctIndex = perm.indexOf(correctKey);
  const newCorrect = correctIndex >= 0 ? newKeys[correctIndex] : null;
  return { newOptions, newCorrect };
}

function buildQuestionText(question, options) {
  return [question, options.A, options.B, options.C, options.D].join("\n");
}

async function predictWithReranker({ openai, retrieval, contentText, questionText }) {
  // bypass logic (must mimic server safety)
  const top = retrieval?.candidates?.[0];
  if (
    top?.known_correct &&
    ["A", "B", "C", "D"].includes(String(top.known_correct).trim().toUpperCase()) &&
    top?.similarity_evidence?.combined_sim >= 0.95 &&
    top?.similarity_evidence?.option_sim >= 0.95
  ) {
    return {
      answer: String(top.known_correct).trim().toUpperCase(),
      llm_used: false,
      confidence: Math.min(0.99, Math.max(0.7, Number(top.similarity_score) || 0.9)),
      insufficient_evidence: false,
      evidence_basis: "High-similarity retrieval match; bypassed LLM reranking.",
      matched_question_ids: [top.matched_question_id ?? top.matched_external_id].filter(Boolean),
    };
  }

  if (!openai) {
    const topLetter = top?.known_correct ? String(top.known_correct).trim().toUpperCase() : null;
    if (topLetter && ["A", "B", "C", "D"].includes(topLetter)) {
      const conf = Number(top?.similarity_score) || 0.3;
      return {
        answer: topLetter,
        llm_used: false,
        confidence: Math.min(0.6, Math.max(0.1, conf * 0.5)),
        insufficient_evidence: true,
        evidence_basis: "No AI provider configured; returning retrieval only (insufficient evidence).",
        matched_question_ids: [top.matched_question_id ?? top.matched_external_id].filter(Boolean),
      };
    }
    return {
      answer: null,
      llm_used: false,
      confidence: 0.1,
      insufficient_evidence: true,
      evidence_basis: "No AI provider configured and no retrieval candidates.",
      matched_question_ids: [],
    };
  }

  const lines = String(questionText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const qText = lines[0] ?? "";
  const optA = lines[1] ?? "";
  const optB = lines[2] ?? "";
  const optC = lines[3] ?? "";
  const optD = lines[4] ?? "";

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
            `Question: ${safeShort(c.question_text ?? "", 300)}\n` +
            `A) ${safeShort(A, 180)}\n` +
            `B) ${safeShort(B, 180)}\n` +
            `C) ${safeShort(C, 180)}\n` +
            `D) ${safeShort(D, 180)}`
          );
        })
        .join("\n\n") + "\n\n"
    : "";

  const userPrompt =
    `New question:\n${qText}\n\n` +
    `A) ${optA}\n` +
    `B) ${optB}\n` +
    `C) ${optC}\n` +
    `D) ${optD}\n\n` +
    `Retrieved similar examples (your only evidence for reranking):\n${referencesBlock}` +
    "Select the best answer option for the NEW question based on the retrieved evidence.\n" +
    "Return strict JSON only.";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemHint },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 120,
  });

  const raw = response.choices?.[0]?.message?.content ?? "";
  const parsed = parseStrictRerankerJson(raw);

  // Filter matched ids to those in retrieved candidates for transparency.
  const allowedMatchedIds = new Set(
    (retrieval?.candidates ?? [])
      .slice(0, 5)
      .map((c) => c.matched_question_id ?? c.matched_external_id)
      .filter(Boolean)
  );
  const filteredMatched = (parsed.matched_question_ids ?? []).filter((x) => allowedMatchedIds.has(x));
  if (!parsed.insufficient_evidence && filteredMatched.length < 1) {
    throw new Error("matched_question_ids must reference retrieved candidates");
  }

  return {
    answer: parsed.suggested_answer,
    llm_used: true,
    confidence: parsed.confidence,
    insufficient_evidence: parsed.insufficient_evidence,
    evidence_basis: parsed.evidence_basis,
    matched_question_ids: filteredMatched,
  };
}

async function predictWithLegacyDirectLLM({ openai, questionText }) {
  if (!openai) return null;
  const systemHint =
    "You are an expert in EASA ATPL theoretical exam questions.\n" +
    "Choose the single best correct option.\n" +
    "Return ONLY the correct option as A, B, C or D (or 1, 2, 3, 4).\n" +
    "Do not include any explanation.";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemHint },
      { role: "user", content: questionText },
    ],
    temperature: 0,
    max_tokens: 32,
  });

  const raw = response.choices?.[0]?.message?.content ?? "";
  const ans = legacyParseDirectAnswer(raw);
  return { answer: ans, raw };
}

async function main() {
  const limitQuestions = Number(arg("limit", 20));
  const maxVariants = Number(arg("variants", 2)); // 2 variants: exact + shuffled
  const topN = Number(arg("topN", 10));
  const outModes = (arg("modes", "all") || "all").split(",").map((s) => s.trim());

  const semanticOn = openaiAvailable();

  const store = initSqliteStore({ dbPath, questionsJsonPath });
  const all = store.getActiveQuestions();
  const datasetBase = all.filter((r) => Boolean(r.is_verified) && normalizeCorrectLetter(r.correct));

  // Deterministic subset: sort by external id.
  datasetBase.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const dataset = datasetBase.slice(0, Math.max(1, limitQuestions));

  // OpenAI availability.
  const openaiKey = process.env.OPENAI_API_KEY;
  const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

  const variants = [
    { name: "exact", permIndex: 0 },
    { name: "shuffled", permIndex: 1 },
  ].slice(0, maxVariants);

  const permutations = [
    ["A", "B", "C", "D"],
    ["B", "A", "D", "C"],
    ["C", "D", "A", "B"],
  ];

  const modes = normalizeModes(outModes, semanticOn, Boolean(openai));

  const report = {
    started_at: new Date().toISOString(),
    config: {
      limitQuestions,
      maxVariants,
      topN,
      modes,
    },
    dataset: {
      verified_records: dataset.length,
      variants: variants.map((v) => v.name),
    },
    results: {},
    subject_classification_accuracy: {
      available: false,
      reason: "No ground-truth subject/topic labels in current repo; evaluation can only report coverage/confidence distribution later.",
    },
  };

  for (const mode of modes) {
    const metrics = initMetrics();
    for (let i = 0; i < dataset.length; i++) {
      const row = dataset[i];
      const originalOptions = { A: row.a, B: row.b, C: row.c, D: row.d };
      const gtCorrectKey = normalizeCorrectLetter(row.correct);

      for (const variant of variants) {
        const perm = permutations[variant.permIndex % permutations.length];
        const { newOptions, newCorrect } = shuffleByPermutation(originalOptions, gtCorrectKey, perm);
        const questionText = buildQuestionText(row.question, newOptions);

        const retrieval = await store.retrieveSimilarQuestions({
          questionText,
          topN,
          semanticMode: mode === "lexical_retrieval" ? "off" : mode === "hybrid_retrieval" ? "on" : "auto",
        });

        const candidates = retrieval?.candidates ?? [];
        const top1 = candidates[0];
        const top3 = candidates.slice(0, 3);

        const gt = newCorrect;
        const top1Correct = Boolean(top1?.known_correct && String(top1.known_correct).trim().toUpperCase() === gt);
        const top3Correct = top3.some(
          (c) => c?.known_correct && String(c.known_correct).trim().toUpperCase() === gt
        );

        metrics.total += 1;
        if (top1Correct) metrics.top1_accuracy += 1;
        if (top3Correct) metrics.top3_accuracy += 1;
        if (top1Correct && variant.name === "exact" && top1?.similarity_evidence) {
          const ev = top1.similarity_evidence;
          if (ev.question_sim >= 0.9999 && ev.option_sim >= 0.9999) metrics.exact_hit += 1;
          else if (ev.combined_sim >= 0.8) metrics.near_hit += 1;
        } else if (variant.name === "exact" && top1?.similarity_evidence && top1Correct) {
          const ev = top1.similarity_evidence;
          if (ev.combined_sim >= 0.8) metrics.near_hit += 1;
        }

        // For retrieval-only modes: no LLM confidence.
        if (mode === "lexical_retrieval" || mode === "hybrid_retrieval") continue;

        // LLM reranker or legacy direct.
        if (mode === "retrieval_rerank") {
          const pred = await predictWithReranker({
            openai,
            retrieval,
            contentText: questionText,
            questionText,
          });
          if (!pred || !pred.answer) {
            metrics.low_confidence += 1;
            metrics.needs_manual_review += 1;
            continue;
          }

          const predCorrect = pred.answer === gt;
          metrics.llm_used += pred.llm_used ? 1 : 0;
          metrics.rerank_top1_accuracy += predCorrect ? 1 : 0;

          const lowConf = pred.insufficient_evidence || (pred.confidence !== null && pred.confidence < 0.6);
          if (lowConf) metrics.low_confidence += 1;
          if (lowConf || !predCorrect) metrics.needs_manual_review += 1;
        } else if (mode === "legacy_direct") {
          const pred = await predictWithLegacyDirectLLM({ openai, questionText });
          if (!pred || !pred.answer) {
            metrics.low_confidence += 1;
            metrics.needs_manual_review += 1;
            continue;
          }

          const predCorrect = pred.answer === gt;
          // Legacy has no confidence; approximate with "always unknown".
          metrics.rerank_top1_accuracy += predCorrect ? 1 : 0;
          metrics.llm_used += 1;
          metrics.low_confidence += 1;
          metrics.needs_manual_review += predCorrect ? 0 : 1;
        }
      }
    }

    report.results[mode] = finalizeMetrics(metrics);
    report.results[mode].dataset_size = metrics.total;
  }

  const reportPath = path.join(logsDir, `eval-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Eval report written to:", reportPath);
  console.log(JSON.stringify(report, null, 2));

  function openaiAvailable() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  function normalizeModes(reqModes, semOn, hasOpenai) {
    if (reqModes.length === 1 && reqModes[0] === "all") {
      const base = ["lexical_retrieval", "hybrid_retrieval"];
      if (hasOpenai) base.push("retrieval_rerank");
      return base.concat(hasOpenai ? ["legacy_direct"] : []);
    }
    // allow explicit modes
    const out = [];
    for (const m of reqModes) {
      if (m === "hybrid_retrieval" && !semOn) continue;
      if ((m === "retrieval_rerank" || m === "legacy_direct") && !hasOpenai) continue;
      out.push(m);
    }
    return out;
  }

  function initMetrics() {
    return {
      total: 0,
      top1_accuracy: 0,
      top3_accuracy: 0,
      exact_hit: 0,
      near_hit: 0,
      low_confidence: 0,
      needs_manual_review: 0,
      llm_used: 0,
      rerank_top1_accuracy: 0,
    };
  }

  function finalizeMetrics(m) {
    const datasetSize = m.total || 1;
    return {
      top1_accuracy: Number((m.top1_accuracy / datasetSize).toFixed(4)),
      top3_accuracy: Number((m.top3_accuracy / datasetSize).toFixed(4)),
      exact_hit_rate: Number((m.exact_hit / Math.max(1, datasetSize)).toFixed(4)),
      near_hit_rate: Number((m.near_hit / Math.max(1, datasetSize)).toFixed(4)),
      low_confidence_rate: Number((m.low_confidence / Math.max(1, datasetSize)).toFixed(4)),
      needs_manual_review_rate: Number((m.needs_manual_review / Math.max(1, datasetSize)).toFixed(4)),
      llm_used_rate: Number((m.llm_used / Math.max(1, datasetSize)).toFixed(4)),
      rerank_top1_accuracy: m.rerank_top1_accuracy ? Number((m.rerank_top1_accuracy / Math.max(1, datasetSize)).toFixed(4)) : null,
    };
  }
}

main().catch((e) => {
  console.error("Benchmark failed:", e);
  process.exit(1);
});

