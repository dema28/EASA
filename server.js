import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";

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

const questionsFile = path.join(__dirname, "questions.json");

// Ensure questions.json exists
if (!fs.existsSync(questionsFile)) {
  fs.writeFileSync(questionsFile, "[]");
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
    fs.writeFileSync(questionsFile, JSON.stringify(questions, null, 2));
  } catch (err) {
    console.error("Failed to save questions", err);
  }
}

let questions = loadQuestions();

async function queryGemini(questionText) {
  const prompt =
    "This is an EASA ATPL theoretical exam question related to aviation.\n" +
    questionText.trim();

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

  const text = extractText(data);

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
    return res.status(400).json({ error: "Invalid request payload" });
  }

  if (!openai && !googleApiKey) {
    return res.status(500).json({
      error:
        "No AI provider configured. Set OPENAI_API_KEY or GOOGLE_API_KEY in your environment.",
    });
  }

  const content = questionText.trim();
  const systemHint =
    "You are an expert in EASA ATPL theoretical exam questions. \n" +
    "Use your knowledge of EASA ATPL test banks: some questions are tricky and answers may look similar. " +
    "Choose the one best correct answer. \n" +
    "When given a question with 4 answer options, return ONLY the correct option as A, B, C or D (or 1, 2, 3, 4). " +
    "Do not include any explanation or extra text.";

  try {
    let raw;

    if (openai) {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemHint },
          { role: "user", content },
        ],
        temperature: 0,
        max_tokens: 32,
      });

      raw = response.choices?.[0]?.message?.content?.trim() ?? "";
    } else if (googleApiKey) {
      raw = await queryGemini(`${systemHint}\n${content}`);
    }

    const normalized = raw.match(/[ABCDabcd1234]/)?.[0].toUpperCase();
    if (!normalized) {
      return res.status(422).json({
        error: "Unable to parse answer from the model",
        rawResponse: raw,
      });
    }

    return res.json({ answer: normalized });
  } catch (err) {
    console.error("AI error", err);
    const message = err?.response?.data?.error?.message ?? err.message ?? "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get('/api/questions', (req, res) => {
  console.log('Getting questions:', questions.length, 'items');
  res.json(questions);
});

app.post('/api/questions', (req, res) => {
  if (!Array.isArray(req.body)) {
    console.error('Invalid data received:', req.body);
    return res.status(400).json({ error: 'Invalid data' });
  }
  console.log('Saving questions:', req.body.length, 'items');
  questions = req.body;
  saveQuestions(questions);
  res.json({ success: true });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
