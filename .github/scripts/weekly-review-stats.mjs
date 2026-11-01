#!/usr/bin/env node
// =============================================================
// weekly-review-stats.mjs —— AI 審核意見的品質統計（每週一次）
//
// 為什麼需要：AI 審核最大的死因不是漏報，而是「無效意見太多」，
// 工程師看慣了就直接全數忽略，於是真正的阻斷級問題也被一起忽略。
// 這支腳本把「哪些意見被採納 / 被標不適用 / 沒人理」統計出來，
// 直接告訴你把哪幾條規則該寫進忽略清單。
//
// 子命令：
//   selftest          驗證統計邏輯（verify-all 會跑到）
//   --demo            用內建範例資料產出一份可看的報告
//   --comments <檔>   從檔案讀意見資料（GitHub API 格式整理後的樣子）
//   --prs <檔>        從檔案讀 PR 資料（算自動合併與 revert）
//   --fetch           用 gh api 直接抓線上資料（需要先 gh auth login）
//   --out / --html    輸出 JSON / HTML
// =============================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// 「不適用」的判定詞：工程師實務上會這樣回覆
export const FP_KEYWORDS = ["不適用", "故意", "不是問題", "已有原因", "不用改", "wontfix", "false positive", "無關"];
// 「已修正」的判定詞
export const FIX_KEYWORDS = ["已修正", "已改", "改了", "fixed", "good catch", "有道理"];

export const DEFAULT_THRESHOLDS = {
  minSamplesForRule: 5, // 樣本少於這個數就不下結論，避免小樣本誤殺
  fpRateToIgnore: 0.5, // 某規則/目錄誤報率超過這個比例 → 建議進忽略清單
  autoMergeRevertTolerance: 0, // 自動合併的 PR 被 revert 超過 0 件就警告
};

// ---------- 核心統計（純函式，方便本地測試） ----------
export function classifyComment(c, th = DEFAULT_THRESHOLDS) {
  const minus1 = c.reactions?.["-1"] ?? c.minus1 ?? 0;
  const replies = (c.replies ?? []).map((r) => String(r.body ?? ""));
  const allText = [String(c.body ?? ""), ...replies].join(" ");
  if (minus1 >= 1) return { verdict: "false-positive", why: `被按 ${minus1} 次 👎` };
  if (replies.some((r) => FP_KEYWORDS.some((k) => r.toLowerCase().includes(k.toLowerCase()))))
    return { verdict: "false-positive", why: "作者回覆不適用" };
  if (c.codeChangedAfter || replies.some((r) => FIX_KEYWORDS.some((k) => r.toLowerCase().includes(k.toLowerCase()))))
    return { verdict: "adopted", why: c.codeChangedAfter ? "該行隨後被修改" : "作者回覆已修正" };
  if (c.outdated || c.resolved === false) return { verdict: "stale", why: "未處理即過期" };
  return { verdict: "stale", why: "無人回應" };
}

function pct(n, d) {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function dirOf(path = "") {
  const segs = path.split("/").filter(Boolean);
  // 深度不超過 2 時只取第一層目錄（否則會退化成「單一檔案」而不是目錄，統計不到東西）
  if (segs.length <= 2) return segs[0] || "(根目錄)";
  return segs.slice(0, 2).join("/");
}

export function ruleSignature(body = "") {
  // 用意見的第一行前 40 字当作「規則簽名」，用來找出反覆出現的煩人規則
  const first = String(body).split("\n")[0].replace(/[#*`>-]/g, "").trim();
  return first.slice(0, 40) || "(空意見)";
}

export function computeStats(comments, prs, th = DEFAULT_THRESHOLDS) {
  const rows = comments.map((c) => ({ ...c, ...classifyComment(c, th) }));
  const total = rows.length;
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const adopted = count("adopted");
  const fp = count("false-positive");
  const stale = count("stale");

  const byDir = {};
  for (const r of rows) {
    const d = dirOf(r.path);
    byDir[d] ??= { total: 0, fp: 0, adopted: 0 };
    byDir[d].total++;
    if (r.verdict === "false-positive") byDir[d].fp++;
    if (r.verdict === "adopted") byDir[d].adopted++;
  }

  const byRule = {};
  for (const r of rows) {
    const s = ruleSignature(r.body);
    byRule[s] ??= { total: 0, fp: 0 };
    byRule[s].total++;
    if (r.verdict === "false-positive") byRule[s].fp++;
  }

  const suggestions = [];
  for (const [d, v] of Object.entries(byDir)) {
    if (v.total >= th.minSamplesForRule && v.fp / v.total >= th.fpRateToIgnore) {
      suggestions.push(`目錄 ${d} 的誤報率 ${pct(v.fp, v.total)}%（${v.fp}/${v.total}）→ 建議把相關規則寫進 .ai-review/rules.md 的忽略清單`);
    }
  }
  for (const [s, v] of Object.entries(byRule)) {
    if (v.total >= th.minSamplesForRule && v.fp / v.total >= th.fpRateToIgnore) {
      suggestions.push(`高頻誤報意見「${s}」出現 ${v.fp}/${v.total} 次不被採納 → 該條提示詞要收斂`);
    }
  }

  const merged = (prs ?? []).filter((p) => p.merged_at);
  const auto = merged.filter((p) => p.labels?.includes("risk:low") || p.auto_merged);
  const reverted = auto.filter((p) => p.reverted);
  const durations = merged
    .map((p) => (new Date(p.merged_at) - new Date(p.created_at)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b);
  const medianMin = durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null;

  if (reverted.length > th.autoMergeRevertTolerance) {
    suggestions.push(`自動合併（risk:low）中有 ${reverted.length} 件被 revert → risk-paths.json 可能放得太寬，檢查這些路徑`);
  }

  return {
    window: { total, adopted, "false-positive": fp, stale },
    rates: {
      採納率: pct(adopted, total),
      誤報率: pct(fp, total),
      未處理率: pct(stale, total),
      信號比: pct(adopted, adopted + fp), // 被採納的意見佔「有明確結論的意見」多少
    },
    byDir,
    byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1].fp - a[1].fp)),
    prs: {
      已合併: merged.length,
      自動合併件數: auto.length,
      自動合併後revert件數: reverted.length,
      合併中位時間_分鐘: medianMin,
    },
    suggestions,
    detail: rows.map((r) => ({ pr: r.pr, path: r.path, verdict: r.verdict, why: r.why, rule: ruleSignature(r.body) })),
  };
}

// ---------- 範例資料（--demo 與 selftest 共用） ----------
export const DEMO_COMMENTS = [
  { pr: 101, path: "docs/CHANGELOG.md", body: "建議：標題層級不一致", minus1: 1, replies: [] },
  { pr: 101, path: "docs/README.md", body: "建議：可考慮補充範例程式", minus1: 0, replies: [{ body: "不適用，這是內部文件" }] },
  { pr: 102, path: "src/utils/money.js", body: "建議：改用 Map 會更好讀", minus1: 0, replies: [] },
  { pr: 102, path: "src/utils/money.js", body: "建議：可考慮補充範例程式", minus1: 0, replies: [] },
  { pr: 103, path: "tests/money.test.js", body: "測試中有 console.log 需要移除", minus1: 0, replies: [{ body: "不適用，除錯用" }] },
  { pr: 103, path: "tests/money.test.js", body: "建議：可考慮補充範例程式", minus1: 1, replies: [] },
  { pr: 104, path: "src/payments/charge.js", body: "[阻斷] 金額使用浮點數會產生誤差", minus1: 0, codeChangedAfter: true, replies: [] },
  { pr: 104, path: "src/payments/charge.js", body: "[阻斷] 缺少冪等鍵會重複扣款", minus1: 0, replies: [{ body: "已修正，加上 idempotencyKey" }] },
  { pr: 105, path: "src/auth/login.js", body: "[阻斷] 未檢查 session 是否過期", minus1: 0, codeChangedAfter: true, replies: [] },
  { pr: 105, path: "src/auth/login.js", body: "建議：可考慮補充範例程式", minus1: 0, replies: [{ body: "不用改" }] },
  { pr: 106, path: "src/utils/format.js", body: "建議：可考慮補充範例程式", minus1: 0, replies: [] },
  { pr: 106, path: "src/utils/format.js", body: "建議：函式參數過多可拆物件", minus1: 0, replies: [] },
  { pr: 107, path: "docs/API.md", body: "建議：可考慮補充範例程式", minus1: 0, replies: [] },
  { pr: 107, path: "docs/API.md", body: "建議：標題層級不一致", minus1: 0, replies: [] },
  { pr: 108, path: "docs/ARCH.md", body: "建議：標題層級不一致", minus1: 1, replies: [] },
];
export const DEMO_PRS = [
  { number: 101, created_at: "2026-10-26T09:00:00Z", merged_at: "2026-10-26T09:12:00Z", labels: ["risk:low"], auto_merged: true, reverted: false },
  { number: 102, created_at: "2026-10-26T10:00:00Z", merged_at: "2026-10-27T11:00:00Z", labels: ["risk:medium"], auto_merged: false, reverted: false },
  { number: 103, created_at: "2026-10-27T08:00:00Z", merged_at: "2026-10-27T08:20:00Z", labels: ["risk:low"], auto_merged: true, reverted: false },
  { number: 104, created_at: "2026-10-28T02:00:00Z", merged_at: "2026-10-28T06:30:00Z", labels: ["risk:high"], auto_merged: false, reverted: false },
  { number: 105, created_at: "2026-10-29T03:00:00Z", merged_at: "2026-10-29T07:00:00Z", labels: ["risk:high"], auto_merged: false, reverted: false },
  { number: 106, created_at: "2026-10-30T01:00:00Z", merged_at: "2026-10-30T01:30:00Z", labels: ["risk:low"], auto_merged: true, reverted: true },
  { number: 107, created_at: "2026-10-30T05:00:00Z", merged_at: "2026-10-30T05:09:00Z", labels: ["risk:low"], auto_merged: true, reverted: false },
];

// ---------- 格式化 ----------
export function toMarkdown(s) {
  const lines = [
    "### AI 審核意見品質（本週）",
    "",
    "| 指標 | 數值 | 判讀 |",
    "| --- | --- | --- |",
    `| 意見總數 | ${s.window.total} | | |`,
    `| 採納率 | ${s.rates["採納率"]}% | 太低代表意見沒價值，太高代表只敢提明顯問題 |`,
    `| 誤報率 | ${s.rates["誤報率"]}% | 超過 30% 就要收斂提示詞 |`,
    `| 未處理率 | ${s.rates["未處理率"]}% | 高代表大家在跳過，審核正在失效 |`,
    `| 已合併 PR | ${s.prs["已合併"]} 件 | 其中自動合併 ${s.prs["自動合併件數"]} 件 |`,
    `| 自動合併後 revert | ${s.prs["自動合併後revert件數"]} 件 | 不該是 0 以外；出現就要收緊 risk-paths |`,
    `| PR 合併中位時間 | ${s.prs["合併中位時間_分鐘"] ?? "無資料"} 分鐘 | 對比導入前的基線 |`,
    "",
    "#### 按目錄的意見分佈",
    "",
    "| 目錄 | 意見數 | 誤報 | 採納 | 誤報率 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [d, v] of Object.entries(s.byDir)) {
    lines.push(`| \`${d}\` | ${v.total} | ${v.fp} | ${v.adopted} | ${pct(v.fp, v.total)}% |`);
  }
  lines.push("", "#### 本週該處理的事");
  lines.push("", ...(s.suggestions.length ? s.suggestions.map((x) => `- ${x}`) : ["- 沒有異常，維持目前規則"]));
  return lines.join("\n");
}

function esc(x) {
  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toHtml(s) {
  const rows = s.detail
    .map((d) => `<tr><td>${d.pr}</td><td>${esc(d.path)}</td><td class="${d.verdict}">${d.verdict}</td><td>${esc(d.why)}</td><td>${esc(d.rule)}</td></tr>`)
    .join("\n");
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>AI 審核意見統計</title>
<style>body{font-family:"Microsoft JhengHei",sans-serif;margin:24px;max-width:1000px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #d0d7de;padding:6px 8px}
.false-positive{background:#ffebe9}.adopted{background:#dafbe1}.stale{background:#fff8c5}
h2{font-size:16px;margin-top:28px}.big{font-size:28px;font-weight:800}</style>
<h1>AI 審核意見品質統計</h1>
<p class="big">誤報率 ${s.rates["誤報率"]}% · 採納率 ${s.rates["採納率"]}% · 未處理率 ${s.rates["未處理率"]}%</p>
<h2>結論與本週該處理的事</h2><ul>${s.suggestions.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>沒有異常</li>"}</ul>
<h2>按目錄分佈</h2><table><tr><th>目錄</th><th>意見數</th><th>誤報</th><th>採納</th></tr>
${Object.entries(s.byDir).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.total}</td><td>${v.fp}</td><td>${v.adopted}</td></tr>`).join("")}</table>
<h2>PR 面</h2><pre>${esc(JSON.stringify(s.prs, null, 2))}</pre>
<h2>逐條意見判定（${s.detail.length} 條）</h2>
<table><tr><th>PR</th><th>檔案</th><th>判定</th><th>依據</th><th>規則簽名</th></tr>${rows}</table>
</html>`;
}

// 把 pulls/comments 的原資料整理成統計用的格式：
// 只留 AI 發的頂層意見，並把靠 in_reply_to_id 掛進來的回覆附到對應意見上。
export function toStatComments(rawComments, aiUser = "coderabbit") {
  const threads = new Map();
  for (const c of rawComments) {
    if (!c.in_reply_to_id) continue;
    const arr = threads.get(c.in_reply_to_id) ?? [];
    arr.push({ user: c.user?.login, body: c.body });
    threads.set(c.in_reply_to_id, arr);
  }
  const out = [];
  for (const c of rawComments) {
    if (c.in_reply_to_id) continue; // 回覆不當作獨立意見
    const login = String(c.user?.login ?? "").toLowerCase();
    const isAI = login.includes(aiUser.toLowerCase()) || c.user?.type === "Bot";
    if (!isAI) continue; // 人類審查者的意見不混進來
    out.push({
      pr: c.pull_request_url?.split("/").pop(),
      path: c.path,
      body: c.body,
      minus1: c.reactions?.["-1"] ?? 0,
      replies: threads.get(c.id) ?? [],
      outdated: c.outdated ?? false,
    });
  }
  return out;
}

// ---------- 線上抓資料（需要 gh auth login） ----------
// 重點：對行內意見的「回覆」也出現在 pulls/comments 裡，靠 in_reply_to_id 串成執行緒，
// 因此一次 API 呼叫就能拿到「AI 意見 + 對應的作者回覆」，不需要逐 PR 抓。
export function fetchFromGithub(repo, days, aiUser = "coderabbit") {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const out = { comments: [], prs: [] };
  const run = (args) => {
    const res = spawnSync("gh", args, { encoding: "utf8", shell: process.platform === "win32" });
    if (res.status !== 0) throw new Error(`gh ${args.join(" ")} 失敗：${res.stderr}`);
    return JSON.parse(res.stdout);
  };

  const raw = run(["api", `repos/${repo}/pulls/comments?since=${since}`, "--paginate"]);
  out.comments = toStatComments(raw, aiUser);

  const prs = run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`]);
  for (const p of prs) {
    if (!p.merged_at || p.merged_at < since) continue;
    out.prs.push({
      number: p.number,
      created_at: p.created_at,
      merged_at: p.merged_at,
      labels: (p.labels ?? []).map((l) => l.name),
      auto_merged: !!p.auto_merge,
      reverted: false, // REST 沒有直接欄位；要精準請另行比對 main 上的 revert commit
    });
  }
  return out;
}

// ---------- selftest ----------
function cmdSelftest() {
  const s = computeStats(DEMO_COMMENTS, DEMO_PRS);
  const expect = { total: 15, fp: 6, adopted: 3, stale: 6, fpRate: 40, merged: 7, auto: 4, medianMin: 30 };
  const checks = [
    ["意見總數 15", s.window.total === expect.total],
    ["採納數 3", s.window.adopted === expect.adopted],
    ["誤報數 6", s.window["false-positive"] === expect.fp],
    ["未處理數 6", s.window.stale === expect.stale],
    ["誤報率 40%", s.rates["誤報率"] === expect.fpRate],
    ["docs 目錄被建議進忽略清單", s.suggestions.some((x) => x.includes("docs"))],
    ["「可考慮補充範例程式」被點名為高頻誤報規則", s.suggestions.some((x) => x.includes("可考慮補充範例程式"))],
    ["自動合併 revert 被警告", s.suggestions.some((x) => x.includes("revert"))],
    ["樣本不足 5 條的目錄不下結論", !s.suggestions.some((x) => x.includes("tests"))],
    ["已合併 PR 數 7", s.prs["已合併"] === expect.merged],
    ["自動合併件數 4", s.prs["自動合併件數"] === expect.auto],
    ["revert 件數 1", s.prs["自動合併後revert件數"] === 1],
    ["合併中位時間 30 分鐘", s.prs["合併中位時間_分鐘"] === expect.medianMin],
  ];

  // 另外驗證「線上資料整理」的兩個易錯點：回覆串接與只留 AI 意見
  const rawMock = [
    { id: 1, path: "src/a.js", body: "[阻斷] 未檢查空值", user: { login: "coderabbitai[bot]", type: "Bot" }, reactions: { "-1": 0 }, pull_request_url: "https://api.github.com/repos/o/r/pulls/9" },
    { id: 2, path: "src/a.js", body: "不適用，這裡保證不為空", in_reply_to_id: 1, user: { login: "alice", type: "User" } },
    { id: 3, path: "src/a.js", body: "這裡我來改", in_reply_to_id: 1, user: { login: "bob", type: "User" } },
    { id: 4, path: "src/b.js", body: "-human review 意見", user: { login: "carol", type: "User" } },
    { id: 5, path: "src/c.js", body: "建議：排版", user: { login: "coderabbitai[bot]", type: "Bot" }, reactions: { "-1": 2 } },
    { id: 6, path: "src/d.js", body: "建議：補充文件", user: { login: "coderabbitai[bot]", type: "Bot" }, reactions: { "+1": 1, total_count: 1 } },
  ];
  const shaped = toStatComments(rawMock, "coderabbit");
  checks.push(["只留 AI 的頂層意見（3 條）", shaped.length === 3]);
  checks.push(["回覆依 in_reply_to_id 掛回原意見", (shaped[0].replies ?? []).length === 2]);
  checks.push(["人類 reviewer 的意見不混入", !shaped.some((x) => x.body.includes("human review"))]);
  const s2 = computeStats(shaped, []);
  const fp2 = s2.detail.filter((d) => d.verdict === "false-positive");
  checks.push(["有 👎 的意見被歸為誤報", fp2.some((d) => d.why.includes("👎"))]);
  checks.push(["作者回覆不適用的意見被歸為誤報", fp2.some((d) => d.why.includes("作者回覆不適用"))]);
  checks.push(["只有 👎 才計為誤報（一般 👍 不算）", fp2.length === 2 && s2.window.stale === 1]);
  console.log("=== weekly-review-stats selftest ===");
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
  }
  console.log(`\n結果：${checks.length - bad}/${checks.length} 通過`);
  if (bad) console.log(JSON.stringify({ window: s.window, rates: s.rates, suggestions: s.suggestions }, null, 2));
  return bad === 0 ? 0 : 1;
}

// ---------- 進入點 ----------
function main(argv) {
  const get = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] === "selftest") return cmdSelftest();

  let comments, prs;
  if (argv.includes("--fetch")) {
    const data = fetchFromGithub(get("repo") || process.env.GH_REPO, Number(get("days") || 7), get("ai-user") || "coderabbit");
    comments = data.comments;
    prs = data.prs;
    console.log(`從線上抓到 ${comments.length} 條 AI 意見、${prs.length} 個已合併 PR`);
    if (!comments.length) console.log("提示：若為 0，通常是 reviewer 帳號不包含 --ai-user 關鍵字，或視窗內沒有意見");
  } else if (argv.includes("--demo") || argv.length === 0) {
    comments = DEMO_COMMENTS;
    prs = DEMO_PRS;
    console.log("使用內建範例資料（--demo）");
  } else {
    comments = JSON.parse(readFileSync(get("comments"), "utf8"));
    prs = get("prs") ? JSON.parse(readFileSync(get("prs"), "utf8")) : [];
  }

  const th = { ...DEFAULT_THRESHOLDS };
  if (get("min-samples")) th.minSamplesForRule = Number(get("min-samples"));
  if (get("fp-rate")) th.fpRateToIgnore = Number(get("fp-rate"));

  const stats = computeStats(comments, prs, th);
  console.log(toMarkdown(stats));

  const out = get("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ ...stats, thresholds: th, ranAt: new Date().toISOString() }, null, 2));
    console.log(`\nJSON：${out}`);
  }
  const html = get("html");
  if (html) {
    mkdirSync(dirname(html), { recursive: true });
    writeFileSync(html, toHtml(stats));
    console.log(`HTML：${html}`);
  }
  const md = get("md");
  if (md) writeFileSync(md, toMarkdown(stats));
  return 0;
}

if (process.argv[1]?.endsWith("weekly-review-stats.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
