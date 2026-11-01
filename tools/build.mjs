// 建置：把程式碼清單彙整成 dist/build-info.json，作為「建置成功」的具體產物。
import { readdirSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (extname(name) === ".js") out.push(full);
  }
  return out;
}

const files = walk("src");
const modules = files.map((f) => ({
  path: f.split("\\").join("/"),
  lines: readFileSync(f, "utf8").split("\n").length,
}));

mkdirSync("dist", { recursive: true });
const info = {
  builtAt: new Date().toISOString(),
  moduleCount: modules.length,
  totalLines: modules.reduce((a, m) => a + m.lines, 0),
  modules,
};
writeFileSync("dist/build-info.json", JSON.stringify(info, null, 2));
console.log(`[build] 打包 ${info.moduleCount} 個模組，共 ${info.totalLines} 行 → dist/build-info.json`);
