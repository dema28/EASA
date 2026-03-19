// Pure parsing utilities for the "bulk input" format in the UI.
// This is intentionally DOM-free so it can be unit-tested in Node.

export function normalizeOptionText(text) {
  return String(text ?? "").replace(/^\s*[ABCDabcd]\s*\)?\s*/i, "").trim();
}

export function parseQuestionBlocks(inputText) {
  const lines = String(inputText ?? "")
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

    // Options may be marked as correct by prefixing '+' to the line.
    // The '+' marker must not be saved as part of the option text.
    let a = lines[index + 2];
    let b = lines[index + 3];
    let c = lines[index + 4];
    let d = lines[index + 5];

    const correctMap = { 2: "A", 3: "B", 4: "C", 5: "D" };
    let correct = null;

    [a, b, c, d].forEach((opt, idx) => {
      if (String(opt ?? "").trim().startsWith("+")) {
        correct = correctMap[idx + 2];
      }
    });

    a = String(a ?? "").replace(/^\s*\+\s*/, "");
    b = String(b ?? "").replace(/^\s*\+\s*/, "");
    c = String(c ?? "").replace(/^\s*\+\s*/, "");
    d = String(d ?? "").replace(/^\s*\+\s*/, "");

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

