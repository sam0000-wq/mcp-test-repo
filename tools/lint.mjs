// 取代 ESLint 的輕量檢查（範例專案不裝相依，仍能真的擋住壞程式）。
// 檢查三件事：
//   1. 語法是否可解析（node --check）
//   2. 是否出現 eval（高風險寫法）
//   3. 是否把密鑰寫進程式碼（常見洩漏樣式）
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";

const SCAN_DIRS = ["src", "tools", "tests", "migrations", ".github/scripts"];
const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /^(?:ghp|github_pat)_[0-9A-Za-z]{20,}/m,
  /password\s*[:=]\s*["'][^"']{6,}["']/i,
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目錄不存在就跳過
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.has(extname(name))) out.push(full);
    else if (name.endsWith(".sql") || name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(d));
const problems = [];

for (const file of files) {
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (err) {
      problems.push(`${file}: 語法錯誤 → ${String(err.stderr || err.message).split("\n")[0]}`);
      continue;
    }
  }
  if (file.endsWith(".sql")) continue;
  const text = readFileSync(file, "utf8");
  if (/\beval\s*\(/.test(text)) problems.push(`${file}: 出現動態執行程式碼的寫法，屬高風險`);
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) problems.push(`${file}: 疑似把密鑰寫進程式碼（${re}）`);
  }
}

console.log(`[lint] 掃描 ${files.length} 個檔案`);
files.forEach((f) => console.log(`  · ${f}`));

if (problems.length) {
  console.error(`\n[lint] 發現 ${problems.length} 個問題：`);
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  process.exit(1);
}
console.log("[lint] 通過");
