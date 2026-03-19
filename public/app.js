import { parseQuestionBlocks, normalizeOptionText } from "./questionInputParser.js";

const questionInput = document.getElementById("questionInput");
const parseBtn = document.getElementById("parseBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");

const statusEl = document.getElementById("status");
const qaTableBody = document.querySelector("#qaTable tbody");
const evidencePanel = document.getElementById("evidencePanel");

let rows = [];

(async () => {
  rows = await loadRows();
  renderTable();
})();

async function loadRows() {
  try {
    console.log('Loading rows from server...');
    const response = await fetch('/api/questions');
    if (response.ok) {
      const data = await response.json();
      console.log('Loaded rows:', data);
      return data;
    } else {
      console.error('Failed to load rows, status:', response.status);
    }
  } catch (e) {
    console.error("Failed to load questions from server", e);
  }
  return [];
}

async function saveRows() {
  try {
    console.log("Saving rows to server:", rows);
    const response = await fetch("/api/questions", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error ?? `Failed to save rows (HTTP ${response.status})`);
    }

    // Refresh from server so deduplication/normalization is reflected in UI.
    rows = await loadRows();
    return { droppedDuplicates: data?.droppedDuplicates ?? 0 };
  } catch (e) {
    console.error("Failed to save questions to server", e);
    throw e;
  }
}

function renderTable() {
  qaTableBody.innerHTML = "";
  const ids = rows.map((r) => (r.id || "").trim().toLowerCase().replace(/:/g, ''));
  rows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    const isDuplicate =
      ids.filter((id) => id === (row.id || "").trim().toLowerCase().replace(/:/g, '')).length > 1;

    const makeCell = (text) => {
      const td = document.createElement("td");
      td.textContent = text ?? "";
      return td;
    };

    const idTd = makeCell(row.id || "");
    if (isDuplicate) idTd.classList.add("duplicate-id");
    tr.appendChild(idTd);
    tr.appendChild(makeCell(row.question));
    tr.appendChild(makeCell(row.a));
    tr.appendChild(makeCell(row.b));
    tr.appendChild(makeCell(row.c));
    tr.appendChild(makeCell(row.d));
    tr.appendChild(makeCell(row.correct));

    tr.appendChild(makeCell(formatConfidence(row.inference_confidence)));
    const review = computeReviewState(row);
    const reviewTd = document.createElement("td");
    const reviewLabel = review.label === "needs_manual_review" ? "needs_manual_review" : review.label;
    reviewTd.textContent = reviewLabel;
    if (review.className) reviewTd.classList.add(...review.className.split(" "));
    tr.appendChild(reviewTd);

    tr.appendChild(
      makeCell(
        row.inference_evidence_basis ? safeShort(row.inference_evidence_basis, 80) : ""
      )
    );

    tr.appendChild(makeCell(row.subject_name ?? ""));
    tr.appendChild(makeCell(row.topic_name ?? ""));

    const actionTd = document.createElement("td");
    actionTd.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "small-btn";
    editBtn.textContent = "Изменить";
    editBtn.addEventListener("click", () => startEditRow(idx));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "small-btn";
    deleteBtn.textContent = "Удалить";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Удалить эту строку?")) return;
      rows.splice(idx, 1);
      try {
        await saveRows();
      } catch (e) {
        setStatus(e?.message ?? "Не удалось сохранить изменения", "error");
        return;
      }
      renderTable();
    });

    actionTd.appendChild(editBtn);

    if (row?.inference_evidence_basis) {
      const whyBtn = document.createElement("button");
      whyBtn.type = "button";
      whyBtn.className = "small-btn";
      whyBtn.textContent = "Почему";
      whyBtn.addEventListener("click", () => showEvidenceForRow(row));
      actionTd.appendChild(whyBtn);
    }

    if (!row.is_verified) {
      const verifyBtn = document.createElement("button");
      verifyBtn.type = "button";
      verifyBtn.className = "small-btn";
      verifyBtn.textContent = "Проверено";
      verifyBtn.addEventListener("click", async () => {
        if (!confirm("Пометить как проверенное?")) return;
        try {
          const resp = await fetch(`/api/questions/${encodeURIComponent(row.id)}/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ verified: true }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error ?? "Не удалось обновить статус проверки");
          }
          rows = await loadRows();
          renderTable();
          setStatus("Статус обновлён: verified", "success");
        } catch (e) {
          setStatus(e?.message ?? "Не удалось обновить статус", "error");
        }
      });
      actionTd.appendChild(verifyBtn);
    }

    actionTd.appendChild(deleteBtn);
    tr.appendChild(actionTd);

    qaTableBody.appendChild(tr);
  });
}

async function fetchCorrectAnswer(questionText) {
  const response = await fetch("/api/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionText }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error ?? "Не удалось получить ответ от сервера");
  }

  const data = await response.json();
  const ans = data?.answer;
  if (!["A", "B", "C", "D"].includes(String(ans ?? "").trim().toUpperCase())) {
    throw new Error(`Некорректный ответ модели: ${safePreview(ans)}`);
  }

  return {
    answer: String(ans).trim().toUpperCase(),
    confidence: data?.confidence ?? null,
    evidence_basis: data?.evidence_basis ?? null,
    matched_question_ids: Array.isArray(data?.matched_question_ids)
      ? data.matched_question_ids.filter((x) => typeof x === "string")
      : [],
    insufficient_evidence: Boolean(data?.insufficient_evidence),
    llm_used: Boolean(data?.llm_used),
    retrieval: data?.retrieval ?? null,
  };
}

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.style.color = type === "error" ? "#b91c1c" : type === "success" ? "#0f5132" : "#1f2937";
}

function formatConfidence(conf) {
  if (conf === null || conf === undefined || conf === "") return "";
  const num = Number(conf);
  if (!Number.isFinite(num)) return "";
  return `${Math.round(num * 100)}%`;
}

function computeReviewState(row) {
  const isVerified = Boolean(row?.is_verified);
  const sourceType = String(row?.source_type ?? "");
  const insufficient = Boolean(row?.inference_insufficient_evidence);
  const confidence = row?.inference_confidence;
  const confNum = confidence === null || confidence === undefined ? null : Number(confidence);
  const needsByConfidence = confNum !== null && Number.isFinite(confNum) && confNum < 0.6;
  const needsBySource = sourceType.includes("needs_review");

  if (isVerified) return { label: "verified", className: "status-verified" };
  if (insufficient || needsByConfidence || needsBySource) {
    return { label: "needs_manual_review", className: "status-needs-review" };
  }
  if (sourceType.startsWith("AI_inferred")) return { label: "ai_inferred", className: "status-ai-inferred" };
  if (sourceType.startsWith("imported")) return { label: "imported_unverified", className: "status-needs-review" };
  return { label: "unknown", className: "" };
}

function safeShort(text, maxLen = 90) {
  const s = String(text ?? "");
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function showEvidenceForRow(row) {
  if (!evidencePanel) return;

  const state = computeReviewState(row);
  const summary = {
    review_state: state.label,
    source_type: row?.source_type ?? null,
    is_verified: row?.is_verified ?? false,
    suggested_answer: row?.correct ?? null,
    confidence: row?.inference_confidence ?? null,
    insufficient_evidence: Boolean(row?.inference_insufficient_evidence),
    evidence_basis: row?.inference_evidence_basis ?? null,
    matched_question_ids: row?.inference_matched_question_ids ?? [],
  };

  evidencePanel.textContent = JSON.stringify(summary, null, 2);
}

function renderResultCard({ row, aiResult, retrieval }) {
  const card = document.getElementById("resultCard");
  const summaryEl = document.getElementById("resultSummary");
  const matchesEl = document.getElementById("resultMatches");
  const actionsEl = document.getElementById("resultActions");
  if (!card || !summaryEl || !matchesEl || !actionsEl) return;

  if (!row) {
    card.style.display = "none";
    return;
  }

  card.style.display = "block";
  const top = (retrieval?.candidates ?? [])[0];
  const strong =
    top?.known_correct &&
    ["A", "B", "C", "D"].includes(String(top.known_correct).trim().toUpperCase()) &&
    top?.similarity_evidence?.combined_sim >= 0.95 &&
    top?.similarity_evidence?.option_sim >= 0.95;

  const classification = retrieval?.classification ?? {};
  const subject =
    row.subject_name ??
    row.subject_code ??
    classification.subject_name ??
    classification.subject_code ??
    "unknown";
  const topic =
    row.topic_name ??
    row.topic_code ??
    classification.topic_name ??
    classification.topic_code ??
    "unknown";

  const stateLabel = row.is_verified
    ? "verified"
    : strong
      ? "strong_match"
      : row.source_type?.includes("needs_review") ||
          aiResult?.insufficient_evidence ||
          (aiResult?.confidence !== null && aiResult?.confidence !== undefined && aiResult?.confidence < 0.6)
        ? "needs_manual_review"
        : aiResult?.llm_used && aiResult?.confidence !== null && aiResult?.confidence !== undefined && aiResult?.confidence < 0.8
          ? "weak_match"
        : aiResult?.llm_used
          ? "ai_inferred"
          : "unknown";

  const confidenceText =
    aiResult?.confidence === null || aiResult?.confidence === undefined
      ? ""
      : `Confidence: ${formatConfidence(aiResult.confidence)}${strong ? " (strong match)" : ""}`;

  summaryEl.textContent = "";
  summaryEl.textContent =
    `Subject: ${subject} | Topic: ${topic}\n` +
    `Question: ${row.question}\n` +
    `A) ${row.a}\n` +
    `B) ${row.b}\n` +
    `C) ${row.c}\n` +
    `D) ${row.d}\n` +
    `Suggested: ${row.correct}\n` +
    `${confidenceText}\n` +
    `Status: ${stateLabel}\n` +
    `Evidence: ${aiResult?.evidence_basis ?? ""}`;

  // Matches
  matchesEl.textContent = "";
  const list = document.createElement("div");
  (retrieval?.candidates ?? []).slice(0, 5).forEach((c, idx) => {
    const item = document.createElement("div");
    item.style.marginBottom = "8px";
    const known = c.known_correct ?? "?";
    const ev = c.similarity_evidence ?? {};
    item.textContent =
      `#${idx + 1} ${c.matched_external_id ?? c.matched_question_id}\n` +
      `  ${c.subject_code ?? "unknown"} / ${c.topic_code ?? "unknown"}\n` +
      `  known_correct: ${known} | score: ${Number(c.similarity_score).toFixed(4)}\n` +
      `  question_sim: ${ev.question_sim ?? ""} | option_sim: ${ev.option_sim ?? ""} | combined: ${ev.combined_sim ?? ""}`;
    item.style.whiteSpace = "pre-wrap";
    item.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    list.appendChild(item);
  });
  matchesEl.appendChild(list);

  // Actions: why/show & review
  actionsEl.innerHTML = "";

  const whyBtn = document.createElement("button");
  whyBtn.type = "button";
  whyBtn.className = "small-btn";
  whyBtn.textContent = "Почему";
  whyBtn.addEventListener("click", () => showEvidenceForRow(row));
  actionsEl.appendChild(whyBtn);

  const verifyBtn = document.createElement("button");
  verifyBtn.type = "button";
  verifyBtn.className = "small-btn";
  verifyBtn.textContent = "Проверено";
  verifyBtn.addEventListener("click", async () => {
    if (!confirm("Пометить как проверенное?")) return;
    await fetch(`/api/questions/${encodeURIComponent(row.id)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    rows = await loadRows();
    renderTable();
    renderResultCard({ row: rows.find((r) => r.id === row.id), aiResult, retrieval });
  });
  actionsEl.appendChild(verifyBtn);

  const needsReviewBtn = document.createElement("button");
  needsReviewBtn.type = "button";
  needsReviewBtn.className = "small-btn";
  needsReviewBtn.textContent = "На ручную проверку";
  needsReviewBtn.addEventListener("click", async () => {
    if (!confirm("Пометить как needs_manual_review?")) return;
    await fetch(`/api/questions/${encodeURIComponent(row.id)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified: false, unverified_source_type: "AI_inferred_needs_review" }),
    });
    rows = await loadRows();
    renderTable();
    renderResultCard({ row: rows.find((r) => r.id === row.id), aiResult, retrieval });
  });
  actionsEl.appendChild(needsReviewBtn);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "small-btn";
  editBtn.textContent = "Редактировать";
  editBtn.addEventListener("click", () => {
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx >= 0) startEditRow(idx);
  });
  actionsEl.appendChild(editBtn);
}

async function onParseClicked() {
  setStatus("");
  parseBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    const items = parseQuestionBlocks(questionInput.value);

    for (const item of items) {
      let final = item.correct;
      let sourceType = final ? "manual" : "AI_inferred";
      let inference_confidence = null;
      let inference_evidence_basis = null;
      let inference_insufficient_evidence = null;
      let inference_matched_question_ids = [];
      let inferenceRetrieval = null;
      let llm_used = false;

      if (!final) {
        const questionText = [
          item.question,
          item.a,
          item.b,
          item.c,
          item.d,
        ].join("\n");

        const ai = await fetchCorrectAnswer(questionText);
        final = ai.answer;
        inference_confidence = ai.confidence;
        inference_evidence_basis = ai.evidence_basis;
        inference_insufficient_evidence = ai.insufficient_evidence;
        inference_matched_question_ids = ai.matched_question_ids ?? [];
        inferenceRetrieval = ai.retrieval ?? null;
        llm_used = ai.llm_used ?? false;

        const confNum = inference_confidence === null || inference_confidence === undefined ? null : Number(inference_confidence);
        const needsReview =
          Boolean(inference_insufficient_evidence) ||
          (confNum !== null && Number.isFinite(confNum) && confNum < 0.6);
        sourceType = needsReview ? "AI_inferred_needs_review" : "AI_inferred";
      }

      const newRow = {
        id: item.id,
        question: item.question,
        a: normalizeOptionText(item.a),
        b: normalizeOptionText(item.b),
        c: normalizeOptionText(item.c),
        d: normalizeOptionText(item.d),
        correct: final,
        source_type: sourceType,
        inference_confidence,
        inference_evidence_basis,
        inference_insufficient_evidence,
        inference_matched_question_ids,
      };

      // Ensure subject/topic are at least present (backend will have them), but for instant UI we can compute placeholders.
      if (inferenceRetrieval?.classification) {
        newRow.subject_code = inferenceRetrieval.classification.subject_code ?? newRow.subject_code;
        newRow.subject_name = inferenceRetrieval.classification.subject_name ?? newRow.subject_name;
        newRow.topic_code = inferenceRetrieval.classification.topic_code ?? newRow.topic_code;
        newRow.topic_name = inferenceRetrieval.classification.topic_name ?? newRow.topic_name;
      }

      rows.unshift(newRow);

      // Render explainable result card for AI-inferred rows.
      if (inferenceRetrieval) {
        renderResultCard({
          row: newRow,
          aiResult: {
            confidence: inference_confidence,
            insufficient_evidence: inference_insufficient_evidence,
            evidence_basis: inference_evidence_basis,
            llm_used,
          },
          retrieval: inferenceRetrieval,
        });
      }

      // Allow UI update between requests
      renderTable();
    }

    const saveRes = await saveRows();
    renderTable();
    if ((saveRes?.droppedDuplicates ?? 0) > 0) {
      setStatus(
        `Вопросы добавлены, но были отброшены дубликаты (${saveRes.droppedDuplicates}).`,
        "info"
      );
    } else {
      setStatus("Вопросы добавлены и ответы обновлены.", "success");
    }
  } catch (err) {
    setStatus(err.message ?? "Что-то пошло не так", "error");
  } finally {
    parseBtn.disabled = false;
    clearBtn.disabled = false;
  }
}

function safePreview(value) {
  const s = String(value ?? "");
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

async function startEditRow(index) {
  const row = rows[index];
  if (!row) return;

  const question = prompt("Вопрос:", row.question);
  if (question === null) return;

  const a = prompt("Ответ A:", row.a);
  if (a === null) return;
  const b = prompt("Ответ B:", row.b);
  if (b === null) return;
  const c = prompt("Ответ C:", row.c);
  if (c === null) return;
  const d = prompt("Ответ D:", row.d);
  if (d === null) return;
  const correct = prompt("Правильный вариант (A/B/C/D или 1-4):", row.correct);
  if (correct === null) return;

  const correctNormalized = String(correct).trim().toUpperCase();
  const mapping = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const mappedCorrect = mapping[correctNormalized] ?? correctNormalized;
  if (!["A", "B", "C", "D"].includes(mappedCorrect)) {
    setStatus("Некорректное значение правильного варианта", "error");
    return;
  }

  rows[index] = {
    id: row.id,
    question: question.trim(),
    a: a.trim(),
    b: b.trim(),
    c: c.trim(),
    d: d.trim(),
    correct: mappedCorrect,
    source_type: "manual",
    inference_confidence: null,
    inference_evidence_basis: null,
    inference_insufficient_evidence: null,
    inference_matched_question_ids: [],
  };

  try {
    await saveRows();
  } catch (e) {
    setStatus(e?.message ?? "Не удалось сохранить изменения", "error");
    return;
  }
  renderTable();
}

function downloadCsv() {
  const headers = [
    "ID",
    "Вопрос",
    "Ответ A",
    "Ответ B",
    "Ответ C",
    "Ответ D",
    "Правильный ответ",
    "Предмет",
    "Тема",
    "Confidence",
    "Статус",
    "Evidence",
  ];
  const rowsData = rows.map((r) => [
    r.id,
    r.question,
    r.a,
    r.b,
    r.c,
    r.d,
    r.correct,
    r.subject_name ?? "",
    r.topic_name ?? "",
    r.inference_confidence ?? "",
    computeReviewState(r).label,
    r.inference_evidence_basis ?? "",
  ]);
  const csvContent = [headers, ...rowsData]
    .map((r) => r.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "easa-atpl-questions.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

parseBtn.addEventListener("click", onParseClicked);
clearBtn.addEventListener("click", () => {
  questionInput.value = "";
});
exportBtn.addEventListener("click", downloadCsv);

renderTable();
