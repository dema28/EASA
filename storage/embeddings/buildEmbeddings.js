import path from "path";
import { fileURLToPath } from "url";
import { initSqliteStore } from "../sqliteStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const dbPath = path.join(repoRoot, "data", "easa-atpl.sqlite");
const questionsJsonPath = path.join(repoRoot, "questions.json");

const limit = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return 200;
  const v = Number(arg.split("=")[1]);
  if (!Number.isFinite(v)) return 200;
  return Math.min(Math.max(v, 1), 1000);
})();

async function main() {
  const store = initSqliteStore({ dbPath, questionsJsonPath });
  const result = await store.buildMissingEmbeddings({ limit });
  console.log("Embeddings build result:", result);
}

main().catch((e) => {
  console.error("Embeddings build failed:", e);
  process.exit(1);
});

