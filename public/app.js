const questionInput = document.getElementById("questionInput");
const parseBtn = document.getElementById("parseBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");
const statusEl = document.getElementById("status");
const qaTableBody = document.querySelector("#qaTable tbody");

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
    console.log('Saving rows to server:', rows);
    const response = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    if (response.ok) {
      console.log('Rows saved successfully');
    } else {
      console.error('Failed to save rows, status:', response.status);
    }
  } catch (e) {
    console.error("Failed to save questions to server", e);
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
      await saveRows();
      renderTable();
    });

    actionTd.appendChild(editBtn);
    actionTd.appendChild(deleteBtn);
    tr.appendChild(actionTd);

    qaTableBody.appendChild(tr);
  });
}

function parseInput(inputText) {
  const lines = inputText
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (lines.length < 6) {
    throw new Error("Нужно как минимум 6 строк (ID + вопрос + 4 варианта).");
  }

  const items = [];
  let index = 0;

  while (index + 5 < lines.length) {
    const id = lines[index];
    const question = lines[index + 1];
    let a = lines[index + 2];
    let b = lines[index + 3];
    let c = lines[index + 4];
    let d = lines[index + 5];

    const correctMap = { 2: "A", 3: "B", 4: "C", 5: "D" };
    let correct = null;

    [a, b, c, d].forEach((opt, idx) => {
      if (opt.trim().startsWith("+")) {
        correct = correctMap[idx + 2];
      }
    });

    items.push({ id, question, a, b, c, d, correct });
    index += 6;
  }

  if (index < lines.length) {
    throw new Error(
      "Неполный блок вопроса. Убедитесь, что после ID и вопроса идут 4 варианта ответа."
    );
  }

  return items;
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
  return data.answer;
}

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.style.color = type === "error" ? "#b91c1c" : type === "success" ? "#0f5132" : "#1f2937";
}

function normalizeOptionText(text) {
  return text.replace(/^\s*[ABCDabcd]\s*\)?\s*/i, "").trim();
}

async function onParseClicked() {
  setStatus("");
  parseBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    const items = parseInput(questionInput.value);

    for (const item of items) {
      let final = item.correct;

      if (!final) {
        const questionText = [
          item.question,
          item.a,
          item.b,
          item.c,
          item.d,
        ].join("\n");

        const ans = await fetchCorrectAnswer(questionText);
        const normalized = ans
          .toString()
          .trim()
          .toUpperCase()
          .replace(/[^ABCD1234]/g, "");

        const mapping = { 1: "A", 2: "B", 3: "C", 4: "D" };
        final = mapping[normalized] || normalized;
      }

      rows.unshift({
        id: item.id,
        question: item.question,
        a: normalizeOptionText(item.a),
        b: normalizeOptionText(item.b),
        c: normalizeOptionText(item.c),
        d: normalizeOptionText(item.d),
        correct: final,
      });

      // Allow UI update between requests
      renderTable();
    }

    await saveRows();
    renderTable();
    setStatus("Вопросы добавлены и ответы обновлены.", "success");
  } catch (err) {
    setStatus(err.message ?? "Что-то пошло не так", "error");
  } finally {
    parseBtn.disabled = false;
    clearBtn.disabled = false;
  }
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

  rows[index] = {
    id: row.id,
    question: question.trim(),
    a: a.trim(),
    b: b.trim(),
    c: c.trim(),
    d: d.trim(),
    correct: correct.trim().toUpperCase(),
  };

  await saveRows();
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
  ];
  const rowsData = rows.map((r) => [r.id, r.question, r.a, r.b, r.c, r.d, r.correct]);
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
