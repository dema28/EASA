// Shared strict contracts for LLM outputs.

export function normalizeCorrectValue(value) {
  // Accept "A"-"D" (any case) and "1"-"4" for backwards compatibility.
  const s = String(value ?? "").trim().toUpperCase();
  const map = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const letter = map[s] ?? s;
  if (!["A", "B", "C", "D"].includes(letter)) return null;
  return letter;
}

export function parseStrictRerankerJson(rawResponse) {
  // Strict reranker contract: the whole model output must be valid JSON.
  const trimmed = String(rawResponse ?? "").trim();
  const parsed = JSON.parse(trimmed);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model JSON must be an object");
  }

  const allowedAnswer = normalizeCorrectValue(parsed.suggested_answer ?? parsed.answer);
  if (!allowedAnswer) throw new Error("Model JSON must include suggested_answer 'A'|'B'|'C'|'D'");

  const confidence = parsed.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Model JSON must include confidence as a number in [0..1]");
  }

  const evidenceBasis = parsed.evidence_basis;
  if (typeof evidenceBasis !== "string" || evidenceBasis.trim().length < 5) {
    throw new Error("Model JSON must include evidence_basis (min 5 chars)");
  }

  const matchedQuestionIds = parsed.matched_question_ids;
  if (!Array.isArray(matchedQuestionIds) || matchedQuestionIds.some((x) => typeof x !== "string")) {
    throw new Error("Model JSON must include matched_question_ids as string[]");
  }

  const insufficientEvidence = parsed.insufficient_evidence;
  if (typeof insufficientEvidence !== "boolean") {
    throw new Error("Model JSON must include insufficient_evidence as boolean");
  }

  if (insufficientEvidence && confidence > 0.6) {
    throw new Error("insufficient_evidence=true requires confidence <= 0.6");
  }

  // When evidence is insufficient, matched ids can be empty; otherwise require >=1.
  if (!insufficientEvidence && matchedQuestionIds.length < 1) {
    throw new Error("matched_question_ids must be non-empty when evidence is sufficient");
  }

  return {
    suggested_answer: allowedAnswer,
    confidence: Number(confidence),
    evidence_basis: evidenceBasis.trim(),
    matched_question_ids: matchedQuestionIds,
    insufficient_evidence: insufficientEvidence,
  };
}

