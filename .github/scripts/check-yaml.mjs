#!/usr/bin/env node
// 檢查所有 workflow 的 YAML 語法與關鍵 job 名稱。
// 原因：YAML 打錯時 GitHub 不會在 PR 上報錯，只會在 Actions 頁面顯示「有錯誤的工作流檔案」，
//       整套門檻就默默失效，這是最難查的一類故障。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const EXPECT = {
  "ci.yml": { mustHaveJobs: ["check", "ci-ok"], requiredCheckName: "ci-ok" },
  "risk-gate.yml": { mustHaveJobs: ["classify", "risk-gate", "auto-merge"], requiredCheckName: "risk-gate" },
  "risk-label.yml": { mustHaveJobs: ["label"] },
  "weekly-review-stats.yml": { mustHaveJobs: ["stats"] },
  "pipeline-tests.yml": { mustHaveJobs: ["verify"] },
  "coderabbit-probe.yml": { mustHaveJobs: ["probe"] },
  "observation-period.yml": { mustHaveJobs: ["conclude"] },
};

const problems = [];
const files = readdirSync(".github/workflows").filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

for (const f of files) {
  const path = join(".github", "workflows", f);
  let doc;
  try {
    doc = yaml.load(readFileSync(path, "utf8"));
  } catch (err) {
    problems.push(`${f}: YAML 解析失敗 → ${err.message.split("\n")[0]}`);
    continue;
  }
  const jobs = Object.keys(doc.jobs ?? {});
  console.log(`OK   ${f}  觸發事件：${Object.keys(doc.on ?? doc.true ?? {}).join(", ")}  job：${jobs.join(", ")}`);

  const exp = EXPECT[f];
  if (!exp) {
    problems.push(`${f}: 不在檢查清單內，請補進 EXPECT`);
    continue;
  }
  for (const j of exp.mustHaveJobs) {
    if (!jobs.includes(j)) problems.push(`${f}: 缺少 job「${j}」`);
  }
  if (exp.requiredCheckName) {
    // required status check 用的是 job 的 name（沒寫 name 時才是 job id）
    const named = exp.mustHaveJobs.map((j) => `${j} → ${doc.jobs[j]?.name ?? j}`).join("；");
    console.log(`     名稱對應：${named}`);
  }
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    if (!job?.["runs-on"] && !job?.uses) problems.push(`${f}/${id}: 沒有 runs-on，無法執行`);
    const cond = String(job?.if ?? "");
    if ((cond.match(/\$\{\{/g) ?? []).length !== (cond.match(/\}\}/g) ?? []).length) {
      problems.push(`${f}/${id}: if 表達式的 \${{ }} 沒有正確閉合`);
    }
  }
}

console.log("\n=== 在 GitHub 設定 required check 時，要選的是「job 的 name」===");
console.log("  CI 那關請選：ci-ok");
console.log("  門檻那關請選：risk-gate（不是 classify，也不是 auto-merge 或 risk-label）");

if (problems.length) {
  console.error(`\n發現 ${problems.length} 個問題：`);
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  process.exit(1);
}
console.log(`\n${files.length} 個 workflow 全部可解析，沒有問題`);
