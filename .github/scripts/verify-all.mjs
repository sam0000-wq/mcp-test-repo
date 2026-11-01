#!/usr/bin/env node
// =============================================================
// verify-all.mjs —— 一條命令實測整套審核管線
//
//   npm run verify
//
// 覆蓋範圍：
//   A. 設定檔完整性（.coderabbit.yaml / risk-gate.yml / CODEOWNERS / risk-paths.json）
//   B. CI 四關真的跑（lint / test / build；typecheck 示範 --if-present 自動跳過）
//   C. 反向測試：故意放壞東西，CI 必須擋下來（這是「有保護」的關鍵證據）
//   D. 風險分級：餵 GitHub API 格式的檔案清單給 classify
//   E. 合併門檻與自動合併決策：餵 mock review 給 decide
//   F. 端到端：用真的 git 建立臨時 repo，跑出一個 PR 的 diff 再判定
//
// 產出（全部保留，供 GUI／瀏覽器檢視）：
//   artifacts/logs/verify-all.log      所有步驟的原始輸出
//   artifacts/results.json             結構化結果
//   artifacts/report/index.html        可视化報告（含每一步完整 log）
//   artifacts/mocks/*.json             餵給腳本的測試資料
// =============================================================
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFiles, loadRules, decide, CASES } from "./gate-check.mjs";

const ROOT = process.cwd();
const ART = join(ROOT, "artifacts");
const LOG_DIR = join(ART, "logs");
const MOCK_DIR = join(ART, "mocks");
const REPORT_DIR = join(ART, "report");
for (const d of [ART, LOG_DIR, MOCK_DIR, REPORT_DIR]) mkdirSync(d, { recursive: true });

const LOG_FILE = join(LOG_DIR, "verify-all.log");
writeFileSync(LOG_FILE, "");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE = process.execPath;
const GATE = join(".github", "scripts", "gate-check.mjs");

const results = [];
let seq = 0;

function log(...args) {
  const line = args.join(" ");
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function record(step) {
  results.push(step);
  const head = `${step.ok ? "PASS" : "FAIL"} | #${String(step.id).padStart(2, "0")} | ${step.group} | ${step.name}`;
  log(head);
  log(`      指令：${step.cmd}`);
  log(`      結束碼：${step.code}（預期 ${step.expectFail ? "非 0＝擋下" : "0＝通過"}） 用時 ${step.ms}ms`);
  const body = (step.stdout + step.stderr).trim().split("\n").slice(0, step.tail ?? 8);
  for (const l of body) log(`      │ ${l}`);
  log("");
}

function run(group, name, command, args, { expectFail = false, tail = 8 } = {}) {
  const id = ++seq;
  const t0 = Date.now();
  // Node 20 之後基於安全性修訂，Windows 上不能直接 spawn .cmd，需要走 shell
  const useShell = /\.(cmd|bat)$/.test(command);
  const res = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", shell: useShell });
  const spawnErr = res.error ? `\nspawn error: ${res.error.message}` : "";
  const stdout = res.stdout ?? "";
  const stderr = (res.stderr ?? "") + spawnErr;
  const code = res.status ?? (res.error ? 127 : -1);
  const ok = expectFail ? code !== 0 : code === 0;
  record({ id, group, name, cmd: [command, ...args].join(" "), code, expectFail, stdout, stderr, ok, ms: Date.now() - t0, tail });
  return { ok, code, stdout };
}

function section(title) {
  log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

// ---------- A. 設定檔完整性 ----------
section("A. 設定檔完整性");
run("A 設定", "檢查 .coderabbit.yaml / risk-gate.yml / CODEOWNERS / risk-paths.json", NODE, [GATE, "check-config"]);
run("A 設定", "三個 workflow 的 YAML 可解析且 job 名稱正確", NODE, [join(".github", "scripts", "check-yaml.mjs")], { tail: 12 });

// ---------- B. CI 真的跑 ----------
section("B. CI 六關（與 GitHub Actions 的 matrix 一模一樣）");
run("B CI", "install：npm ci 驗證 lockfile 可用", NPM, ["ci"]);
run("B CI", "lint：語法 + eval + 密鑰掃描", NPM, ["run", "lint"]);
run("B CI", "typecheck：專案沒有 TS → --if-present 自動跳過", NPM, ["run", "typecheck", "--if-present"]);
run("B CI", "test：node --test 跑全部單元測試", NPM, ["test"], { tail: 14 });
run("B CI", "build：產出 dist/build-info.json", NPM, ["run", "build"]);
run("B CI", "security：npm audit 高危漏洞阻斷", NPM, ["audit", "--audit-level=high"], { tail: 6 });

// ---------- C. 反向測試：CI 必須擋下壞東西 ----------
section("C. 反向測試（故意放壞東西，CI 必須擋下，否則等於沒保護）");
const bad = [
  {
    name: "語法錯誤的檔案必須被 lint 擋下",
    file: join("src", "utils", "__broken__.js"),
    content: "export function oops( { return 1 }\n",
    cmd: [NPM, ["run", "lint"]],
  },
  {
    name: "寫死密鑰的檔案必須被 lint 擋下",
    file: join("src", "utils", "__secret__.js"),
    // 密鑰字串在執行時組裝，否則 verify-all.mjs 自己會被自己的規則掃到而誤判
    content: `export const key = "${["AKIA", "IOSFODNN", "7EXAMPLE"].join("")}";\n`,
    cmd: [NPM, ["run", "lint"]],
  },
  {
    name: "測試失敗必須讓 test 關卡紅燈",
    file: join("tests", "__fail__.test.js"),
    content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("故意失敗", () => assert.equal(1, 2));\n',
    cmd: [NPM, ["test"]],
  },
];
for (const b of bad) {
  const abs = join(ROOT, b.file);
  writeFileSync(abs, b.content);
  run("C 反向", b.name, b.cmd[0], b.cmd[1], { expectFail: true, tail: 6 });
  rmSync(abs, { force: true });
}
// 清掉後必須恢復綠燈
run("C 反向", "移除壞檔案後 CI 重回綠燈（確認沒有殘留）", NPM, ["run", "lint"]);

// ---------- D. 風險分級（餵 GitHub API 的檔案清單格式） ----------
section("D. 風險分級：喂 GitHub API「pulls/N/files」的真實格式");
const apiFileLists = {
  "docs-only": ["docs/CHANGELOG.md"],
  "logic-change": ["src/utils/money.js", "tests/money.test.js"],
  "payments-change": ["src/payments/charge.js", "migrations/001_add_order_discount.sql"],
};
const expectLevels = [
  ["docs-only", "low"],
  ["logic-change", "medium"],
  ["payments-change", "high"],
];
for (const [label, names] of Object.entries(apiFileLists)) {
  // GitHub 的 `gh api pulls/N/files --paginate --slurp` 會產出「分頁組成的陣列」，這裡照同一個格式餵進去
  const rel = join("artifacts", "mocks", `files-${label}.json`);
  writeFileSync(join(ROOT, rel), JSON.stringify([names.map((filename) => ({ filename, status: "modified" }))], null, 2));
  run("D 分級", `變更檔案：${names.join(", ")}`, NODE, [GATE, "classify", "--files-json", rel, "--out", join("artifacts", `classify-${label}.json`), "--quiet"], { tail: 3 });
}
// 直接讀結果核對等級
const rules = loadRules(".github/risk-paths.json");
for (const [label, want] of expectLevels) {
  const outPath = join("artifacts", `classify-${label}.json`);
  const json = JSON.parse(readFileSync(join(ROOT, outPath), "utf8"));
  const ok = json.risk === want;
  results.push({ id: ++seq, group: "D 分級", name: `${label} 判定為 ${want}`, cmd: `read ${outPath}`, code: ok ? 0 : 1, expectFail: false, stdout: `判定結果：${json.risk}（預期 ${want}）\n` + (json.files ?? []).map((f) => `  ${f.level}  ${f.file}`).join("\n"), stderr: "", ok, ms: 0 });
  log(`${ok ? "PASS" : "FAIL"} | #${seq} | D 分級 | ${label} → 實際 ${json.risk}，預期 ${want}\n`);
}

// ---------- E. 門檻與自動合併決策 ----------
section("E. 合併門檻與自動合併決策（餵 mock review 資料）");
const R = (login, state, at, type = "User") => ({ user: { login, type }, state, submitted_at: at });
const gateCases = [
  { label: "low-0-approve", files: "docs/CHANGELOG.md", reviews: [], expect: { code: 0, risk: "low", auto: true } },
  { label: "medium-0-approve", files: "src/utils/money.js", reviews: [], expect: { code: 1, risk: "medium", auto: false } },
  { label: "medium-1-approve", files: "src/utils/money.js", reviews: [R("alice", "APPROVED", "2026-11-01T01:00:00Z")], expect: { code: 0, risk: "medium", auto: false } },
  { label: "high-1-approve", files: "src/payments/charge.js", reviews: [R("alice", "APPROVED", "2026-11-01T01:00:00Z")], expect: { code: 1, risk: "high", auto: false } },
  { label: "high-2-approve", files: "src/payments/charge.js", reviews: [R("alice", "APPROVED", "2026-11-01T01:00:00Z"), R("bob", "APPROVED", "2026-11-01T02:00:00Z")], expect: { code: 0, risk: "high", auto: false } },
  { label: "low-fork", files: "docs/CHANGELOG.md", reviews: [], extra: ["--fork"], expect: { code: 0, risk: "low", auto: false } },
  { label: "low-ci-failed", files: "docs/CHANGELOG.md", reviews: [], extra: ["--ci-failed"], expect: { code: 0, risk: "low", auto: false } },
  { label: "bot-approve-不算", files: "src/utils/money.js", reviews: [R("coderabbitai[bot]", "APPROVED", "2026-11-01T01:00:00Z", "Bot")], expect: { code: 1, risk: "medium", auto: false } },
];
for (const c of gateCases) {
  const revPath = join("artifacts", "mocks", `reviews-${c.label}.json`);
  writeFileSync(join(ROOT, revPath), JSON.stringify([c.reviews], null, 2));
  const args = [GATE, "decide", "--files", c.files, "--reviews", revPath, "--author", "author", "--out", join("artifacts", `decide-${c.label}.json`), "--dry-run", ...(c.extra ?? [])];
  const res = run("E 門檻", `${c.label}（${c.files}）`, NODE, args, { expectFail: c.expect.code !== 0, tail: 4 });
  const json = JSON.parse(readFileSync(join(ROOT, `artifacts/decide-${c.label}.json`), "utf8"));
  const okRisk = json.risk === c.expect.risk && json.autoMergeEligible === c.expect.auto && res.code === c.expect.code;
  results.push({ id: ++seq, group: "E 門檻", name: `${c.label} 結果核對：risk=${c.expect.risk}, autoMerge=${c.expect.auto}, exit=${c.expect.code}`, cmd: `read artifacts/decide-${c.label}.json`, code: okRisk ? 0 : 1, expectFail: false, stdout: `實際：risk=${json.risk}, need=${json.need}, got=${json.got}, gatePass=${json.gatePass}, autoMergeEligible=${json.autoMergeEligible}`, stderr: "", ok: okRisk, ms: 0 });
  log(`${okRisk ? "PASS" : "FAIL"} | #${seq} | E 門檻 | 核對 ${c.label} → risk=${json.risk} auto=${json.autoMergeEligible} exit=${res.code}\n`);
}

// ---------- F. 端到端：用真的 git 跑一次 ----------
section("F. 端到端：建一個臨時 git repo，模擬 PR 的 diff 來源");
const TMP = join(ART, "git-demo");
rmSync(TMP, { recursive: true, force: true });
function git(args, cwd = TMP) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr}`);
  return (r.stdout ?? "").trim();
}
let e2eOk = true;
let e2eDetail = "";
try {
  mkdirSync(TMP, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "demo@example.com"]);
  git(["config", "user.name", "demo"]);
  // 把管線設定與原始碼放進臨時 repo
  for (const f of [".github/risk-paths.json", ".github/scripts/gate-check.mjs"]) {
    const dst = join(TMP, f);
    mkdirSync(dst.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    writeFileSync(dst, readFileSync(join(ROOT, f), "utf8"));
  }
  mkdirSync(join(TMP, "docs"), { recursive: true });
  mkdirSync(join(TMP, "src/payments"), { recursive: true });
  writeFileSync(join(TMP, "docs/CHANGELOG.md"), "# demo\n");
  writeFileSync(join(TMP, "src/payments/charge.js"), "export const v = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  // PR 1：只改文件
  git(["checkout", "-q", "-b", "pr-docs"]);
  writeFileSync(join(TMP, "docs/CHANGELOG.md"), "# demo\n\n## 2026-11-01\n- 更新說明\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "docs only"]);
  const filesDocs = git(["diff", "--name-only", "main...HEAD"]);
  e2eDetail += `pr-docs 的 diff：${filesDocs}\n`;

  // PR 2：改金流
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "pr-payments"]);
  writeFileSync(join(TMP, "src/payments/charge.js"), "export const v = 2;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "change payments"]);
  const filesPay = git(["diff", "--name-only", "main...HEAD"]);
  e2eDetail += `pr-payments 的 diff：${filesPay}\n`;

  const r1 = classifyFiles(filesDocs.split("\n").filter(Boolean), rules).overall;
  const r2 = classifyFiles(filesPay.split("\n").filter(Boolean), rules).overall;
  e2eDetail += `判定：pr-docs=${r1}（預期 low）, pr-payments=${r2}（預期 high）`;
  e2eOk = r1 === "low" && r2 === "high";
} catch (err) {
  e2eOk = false;
  e2eDetail = "端到端測試失敗：" + err.message;
}
results.push({ id: ++seq, group: "F 端到端", name: "真實 git diff → 風險判定（docs=low / payments=high）", cmd: "git init + commit + diff --name-only main...HEAD", code: e2eOk ? 0 : 1, expectFail: false, stdout: e2eDetail, stderr: "", ok: e2eOk, ms: 0 });
log(`${e2eOk ? "PASS" : "FAIL"} | #${seq} | F 端到端 | ${e2eDetail.replace(/\n/g, " / ")}\n`);

// ---------- G. 單測情境總覽（gate-check selftest 的 24 案） ----------
section("G. 內建情境測試 24 案（同 selftest 指令）");
run("G 情境", "gate-check selftest", NODE, [GATE, "selftest", "--out", "artifacts/selftest.json"], { tail: 30 });

// ---------- H. 每週意見品質統計 ----------
section("H. 每週 AI 審核意見品質統計");
const STATS = join(".github", "scripts", "weekly-review-stats.mjs");
run("H 統計", "統計邏輯自我驗證（13 個期望值）", NODE, [STATS, "selftest"], { tail: 16 });
run("H 統計", "用範例資料產出報告（驗證輸出與 issue 判斷可用）", NODE, [
  STATS, "--demo",
  "--out", "artifacts/review-stats.json",
  "--md", "artifacts/review-stats.md",
  "--html", "artifacts/report/review-stats.html",
], { tail: 10 });

// ---------- 彙總與報告 ----------
const failed = results.filter((r) => !r.ok);
const summary = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((f) => f.name),
};
writeFileSync(join(ART, "results.json"), JSON.stringify({ summary, results }, null, 2));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const riskTable = CASES.map((c) => {
  const cls = classifyFiles(c.files, rules);
  const d = decide({ risk: cls.overall, approvers: [], isDraft: c.opts?.isDraft ?? false, isFork: c.opts?.isFork ?? false, ciPassed: c.opts?.ciPassed ?? true });
  return `<tr><td>${esc(c.name)}</td><td>${esc(c.files.join(", ") || "（空）")}</td><td class="lv-${d.risk}">${d.risk}</td><td>${d.need}</td><td>${d.gatePass ? "✅" : "⛔"}</td><td>${d.autoMergeEligible ? "✅" : "—"}</td></tr>`;
}).join("\n");

const steps = results
  .map(
    (r) => `<details><summary><span class="${r.ok ? "ok" : "bad"}">${r.ok ? "PASS" : "FAIL"}</span> #${r.id} [${esc(r.group)}] ${esc(r.name)} <em>${esc(r.cmd)}</em></summary>
<pre>結束碼：${r.code}（預期 ${r.expectFail ? "非 0" : "0"}）
$ ${esc(r.cmd)}
${esc(r.stdout)}${r.stderr ? "\n--- stderr ---\n" + esc(r.stderr) : ""}</pre></details>`
  )
  .join("\n");

const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>AI 審核管線實測報告</title>
<style>
body{font-family:-apple-system,"Microsoft JhengHei",sans-serif;margin:24px;color:#1f2328;max-width:1100px}
h1{font-size:20px}.pill{display:inline-block;padding:2px 10px;border-radius:12px;font-weight:700}
.ok{background:#dafbe1;color:#116321}.bad{background:#ffebe9;color:#a40e26}
summary{cursor:pointer;padding:6px 8px;border-bottom:1px solid #eee}
pre{background:#f6f8fa;padding:10px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #d0d7de;padding:6px 8px;text-align:left}
.lv-high{background:#ffebe9;font-weight:700}.lv-medium{background:#fff8c5}.lv-low{background:#dafbe1}
.big{font-size:32px;font-weight:800}
</style></head><body>
<h1>AI 時代程式碼審核架構 —— 實測報告</h1>
<p class="big">${summary.failed.length === 0 ? "✅ 全部通過" : "❌ 有 " + summary.failed.length + " 項未通過"}</p>
<p>共 ${summary.total} 項檢查 · 通過 ${summary.passed} 項 · 時間 ${esc(summary.ranAt)}</p>
${summary.failed.length ? `<p class="bad">未通過：${esc(summary.failed.join("；"))}</p>` : ""}
<h2>一、執行紀錄（每一項都可展開看完整 log）</h2>
${steps}
<h2>二、風險矩陣（${CASES.length} 個內建情境）</h2>
<table><thead><tr><th>情境</th><th>變更檔案</th><th>風險</th><th>需人工</th><th>門檻</th><th>可自動合併</th></tr></thead>
<tbody>${riskTable}</tbody></table>
<h2>三、相關報告</h2>
<p>AI 審核意見的每週統計（誤報率、採納率、該收斂哪幾條規則）：<a href="review-stats.html">artifacts/report/review-stats.html</a></p>
<h2>四、說明</h2>
<p>這份報告由 <code>npm run verify</code> 產生。同一支 <code>gate-check.mjs</code> 也被 GitHub Actions 直接呼叫，
因此這裡通过的行為等同於線上管線的行為。</p>
<p>線上版的 log 位置：<strong>GitHub → Actions → 點進任何一次執行 → 右上角 Summary</strong>（風險表格與判定結果會顯示在該頁，
Artifacts 区可下载 <code>gate-report</code>，内含同一份 HTML 與全部原始 log）。</p>
</body></html>`;
writeFileSync(join(REPORT_DIR, "index.html"), html);

log("=".repeat(70));
log(`總計 ${summary.total} 項檢查，通過 ${summary.passed} 項，未通過 ${summary.failed.length} 項`);
log(`報告：artifacts/report/index.html`);
log(`原始 log：artifacts/logs/verify-all.log`);
log(`結構化結果：artifacts/results.json`);
if (existsSync(TMP)) log(`（臨時 git repo 保留在 artifacts/git-demo，可自行查看）`);
process.exit(summary.failed.length ? 1 : 0);
