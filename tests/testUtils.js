import fs from "fs";
import os from "os";
import path from "path";

export function makeTempDir(prefix = "easa-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

