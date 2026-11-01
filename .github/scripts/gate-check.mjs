#!/usr/bin/env node
// =============================================================
// gate-check.mjs —— 風險分級 + 合併門檻 + 自動合併決策的唯一實作
//
// GitHub Actions 與本地 CLI 用的是同一支腳本，所以「本地測過」＝「線上行為」。
//
// 子命令：
//   classify     依 PR 變更的檔案算出風險等級
//   decide       依風險等級 + review 狀態，決定能否合併 / 是否自動合併
//   selftest     跑內建的 21 個情境，驗證上面兩個動作的正確性
//   check-config 檢查管線設定檔是否還完整（欄位被誤刪、佔位符沒換等）
//
// Exit code：0 = 通過，1 = 阻斷（GitHub Actions 該步驟就會紅燈）
// =============================================================
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const RANK = { low: 1, medium: 2, high: 3 };
export const NEED_BY_RISK = { low: 0, medium: 1, high: 2 };
export const DEFAULT_LEVEL = "medium"; // 未命中任何規則時的保守預設

// ---------- 共用工具 ----------
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const parts = escaped
    .replace(/\*\*\//g, "@@ANYDIR@@") // **/ → 零或多層目錄
    .replace(/\*\*/g, "@@ANY@@") // **  → 任意字元
    .replace(/\*/g, "[^/]*") // *   → 同層任意字元
    .replace(/\?/g, "[^/]")
    .replace(/@@ANYDIR@@/g, "(?:.*/)?")
    .replace(/@@ANY@@/g, ".*");
  return new RegExp(`^${parts}$`);
}

export function loadRules(pathsFile = ".github/risk-paths.json") {
  const cfg = JSON.parse(readFileSync(pathsFile, "utf8"));
  const rules = [];
  for (const level of ["low", "medium", "high"]) {
    for (const glob of cfg[level] ?? []) rules.push({ level, glob, re: globToRegExp(glob) });
  }
  return rules;
}

export function classifyFiles(files, rules) {
  if (files.length === 0) {
    return { overall: DEFAULT_LEVEL, rows: [], note: "diff 為空，保守判定為 medium" };
  }
  const rows = files.map((file) => {
    const hits = rules.filter((r) => r.re.test(file));
    const level = hits.length
      ? hits.reduce((a, r) => (RANK[r.level] > RANK[a] ? r.level : a), "low")
      : DEFAULT_LEVEL;
    return { file, level, matched: hits.map((h) => h.glob) };
  });
  const overall = rows.reduce((a, r) => (RANK[r.level] > RANK[a] ? r.level : a), "low");
  return { overall, rows };
}

// gh api --slurp 會產出「分頁組成的陣列」，這裡一律攤平
export function extractFileNames(payload) {
  const flat = Array.isArray(payload?.[0]) ? payload.flat() : payload;
  return flat.map((f) => f.filename ?? f).filter((x) => typeof x === "string");
}

// 每位審查者只取最新一次意見；排除作者本人與機器人
export function tallyReviews(pages, author) {
  const flat = (Array.isArray(pages?.[0] ) ? pages.flat() : pages) ?? [];
  const latest = new Map();
  const skipped = [];
  for (const r of flat) {
    const login = r?.user?.login;
    if (!login) continue;
    if (login === author) {
      skipped.push({ login, why: "PR 作者本人，不算核准" });
      continue;
    }
    if (r.user.type === "Bot") {
      skipped.push({ login, why: "機器人（CodeRabbit/Actions），不算核准" });
      continue;
    }
    const prev = latest.get(login);
    if (!prev || new Date(r.submitted_at ?? 0) >= new Date(prev.submitted_at ?? 0)) latest.set(login, r);
  }
  const list = [...latest.values()];
  return {
    approvers: list.filter((r) => r.state === "APPROVED").map((r) => r.user.login).sort(),
    blockers: list.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.user.login).sort(),
    skipped,
    perUser: list.map((r) => ({ user: r.user.login, state: r.state, at: r.submitted_at })),
  };
}

export function decide({ risk, approvers = [], isDraft = false, isFork = false, ciPassed = true, dryRun = false }) {
  const need = NEED_BY_RISK[risk] ?? NEED_BY_RISK[DEFAULT_LEVEL];
  const got = approvers.length;
  const gatePass = got >= need;
  const reasons = [];
  if (risk !== "low") reasons.push(`風險等級為 ${risk}，不在免人工範圍`);
  if (isDraft) reasons.push("仍是 Draft");
  if (isFork) reasons.push("來自 fork 的 PR，基於安全不自動合併");
  if (!ciPassed) reasons.push("CI 未通過");
  return {
    risk,
    need,
    got,
    approvers,
    gatePass,
    autoMergeEligible: reasons.length === 0,
    blockAutoMergeReasons: reasons,
    dryRun,
  };
}

// ---------- 輸出與 Log ----------
function log(...args) {
  console.log("[gate]", ...args);
}

function toMarkdown(result, extra = {}) {
  const lines = [
    "### 合併門檻判定",
    "",
    "| 項目 | 內容 |",
    "| --- | --- |",
    `| 風險等級 | **${result.risk}** |`,
    `| 需要人工核准 | ${result.need} 位 |`,
    `| 目前人工核准 | ${result.got} 位${result.approvers.length ? `（${result.approvers.join(", ")}）` : ""} |`,
    `| 門檻 | ${result.gatePass ? "✅ 達成" : "❌ 未達成"} |`,
    `| 自動合併 | ${result.autoMergeEligible ? (result.dryRun ? "✅ 符合（觀察模式，未執行）" : "✅ 符合，已排隊") : `⛔ ${result.blockAutoMergeReasons.join("；")}`} |`,
    "",
  ];
  if (extra.rows?.length) {
    lines.push("#### 檔案判定", "", "| 檔案 | 等級 | 命中規則 |", "| --- | --- | --- |");
    for (const r of extra.rows) {
      lines.push(`| \`${r.file}\` | ${r.level} | ${r.matched.length ? r.matched.join(", ") : "（未命中 → medium）"} |`);
    }
    lines.push("");
  }
  if (extra.skipped?.length) {
    lines.push("#### 被排除的意見", "");
    for (const s of extra.skipped) lines.push(`- ${s.login}：${s.why}`);
    lines.push("");
  }
  return lines.join("\n");
}

function emit({ result, classification, tally, opts }) {
  const md = toMarkdown(result, { rows: classification?.rows, skipped: tally?.skipped });
  log(`風險=${result.risk} 需要=${result.need} 已有=${result.got} 門檻=${result.gatePass ? "通過" : "阻斷"} 自動合併=${result.autoMergeEligible ? (result.dryRun ? "符合(觀察模式)" : "符合") : "否"}`);
  if (classification) {
    for (const r of classification.rows) log(`  ${r.level.padEnd(6)} ${r.file}`);
  }
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify({ ...result, files: classification?.rows ?? [], tally }, null, 2));
    log(`結果寫入 ${opts.out}`);
  }
  if (opts.log) {
    mkdirSync(dirname(opts.log), { recursive: true });
    appendFileSync(opts.log, `[${new Date().toISOString()}] ${JSON.stringify(result)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY && !opts.quiet) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
}

function readArg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const hasFlag = (argv, name) => argv.includes(`--${name}`);

function loadFileList(opts) {
  if (opts.filesJson) {
    const payload = JSON.parse(readFileSync(opts.filesJson, "utf8"));
    const names = extractFileNames(payload).map((f) => f.split("\\").join("/"));
    log(`從 API 檔案清單取得 ${names.length} 個變更檔案`);
    return names;
  }
  if (opts.files) return opts.files.split(",").map((s) => s.trim()).filter(Boolean);
  if (opts.filesFile) {
    return readFileSync(opts.filesFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  }
  throw new Error("需要 --files / --files-file / --files-json 其中之一");
}

// ---------- 子命令：classify ----------
function cmdClassify(argv, opts) {
  const rules = loadRules(opts.paths);
  const files = loadFileList(opts);
  const classification = classifyFiles(files, rules);
  const result = {
    risk: classification.overall,
    need: NEED_BY_RISK[classification.overall],
    got: 0,
    approvers: [],
    gatePass: classification.overall === "low",
    autoMergeEligible: false,
    blockAutoMergeReasons: ["僅判定風險，尚未檢查核准狀態"],
    dryRun: hasFlag(argv, "dry-run"),
  };
  emit({ result, classification, opts });
  return 0;
}

// ---------- 子命令：decide ----------
function cmdDecide(argv, opts) {
  let risk = opts.risk;
  let classification;
  if (!risk) {
    const rules = loadRules(opts.paths);
    classification = classifyFiles(loadFileList(opts), rules);
    risk = classification.overall;
  }
  const pages = opts.reviews ? JSON.parse(readFileSync(opts.reviews, "utf8")) : [];
  const tally = tallyReviews(pages, opts.author ?? "");
  const result = decide({
    risk,
    approvers: tally.approvers,
    isDraft: hasFlag(argv, "draft"),
    isFork: hasFlag(argv, "fork"),
    ciPassed: !hasFlag(argv, "ci-failed"),
    dryRun: hasFlag(argv, "dry-run"),
  });
  emit({ result, classification, tally, opts });
  if (!result.gatePass) {
    console.error(`::error::風險等級 ${risk} 需要 ${result.need} 位人工核准，目前只有 ${result.got} 位`);
    return 1;
  }
  return 0;
}

// ---------- 子命令：selftest ----------
function rev(login, state, at, type = "User") {
  return { user: { login, type }, state, submitted_at: at };
}
function pages(...lists) {
  return lists; // 模擬 gh api --slurp 的多分頁輸出
}

export const CASES = [
  { name: "只改 docs → low，0 人即可自動合併", files: ["docs/CHANGELOG.md"], expect: { risk: "low", need: 0, gatePass: true, auto: true } },
  { name: "根目錄 README → low", files: ["README.md"], expect: { risk: "low", need: 0, gatePass: true, auto: true } },
  { name: "測試檔案 → low", files: ["tests/money.test.js"], expect: { risk: "low", need: 0, gatePass: true, auto: true } },
  { name: "樣式檔案（不在 src 下）→ low", files: ["public/theme/style.css"], expect: { risk: "low", need: 0, gatePass: true, auto: true } },
  { name: "src 下的樣式 → 被 src/** 拉高為 medium", files: ["src/theme/style.css"], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "一般邏輯 0 人核准 → medium 阻斷", files: ["src/utils/money.js"], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "一般邏輯 1 人核准 → 通過但不自動", files: ["src/utils/money.js"], reviews: [rev("alice", "APPROVED", "2026-11-01T01:00:00Z")], expect: { risk: "medium", need: 1, gatePass: true, auto: false } },
  { name: "金流 1 人核准 → high 阻斷", files: ["src/payments/charge.js"], reviews: [rev("alice", "APPROVED", "2026-11-01T01:00:00Z")], expect: { risk: "high", need: 2, gatePass: false, auto: false } },
  { name: "金流 2 人核准 → 通過", files: ["src/payments/charge.js"], reviews: [rev("alice", "APPROVED", "2026-11-01T01:00:00Z"), rev("bob", "APPROVED", "2026-11-01T02:00:00Z")], expect: { risk: "high", need: 2, gatePass: true, auto: false } },
  { name: "文件 + 認證混合 → 取最高 high", files: ["docs/CHANGELOG.md", "src/auth/login.js"], expect: { risk: "high", need: 2, gatePass: false, auto: false } },
  { name: "資料庫遷移 → high", files: ["migrations/001_add_order_discount.sql"], expect: { risk: "high", need: 2, gatePass: false, auto: false } },
  { name: "改審核規則本身 → high", files: [".ai-review/rules.md"], expect: { risk: "high", need: 2, gatePass: false, auto: false } },
  { name: "改 workflow → high", files: [".github/workflows/ci.yml"], expect: { risk: "high", need: 2, gatePass: false, auto: false } },
  { name: "未命中的新目錄 → 預設 medium，不會自動合併", files: ["unknown/dir/new.ts"], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "package.json → 預設 medium", files: ["package.json"], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "空 diff → 保守 medium", files: [], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "先核准、後要求變更 → 不算核准", files: ["src/utils/money.js"], reviews: [rev("alice", "APPROVED", "2026-11-01T01:00:00Z"), rev("alice", "CHANGES_REQUESTED", "2026-11-01T03:00:00Z")], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "先要求變更、後核准 → 算核准", files: ["src/utils/money.js"], reviews: [rev("alice", "CHANGES_REQUESTED", "2026-11-01T01:00:00Z"), rev("alice", "APPROVED", "2026-11-01T03:00:00Z")], expect: { risk: "medium", need: 1, gatePass: true, auto: false } },
  { name: "作者自己核准 → 排除", files: ["src/utils/money.js"], author: "alice", reviews: [rev("alice", "APPROVED", "2026-11-01T01:00:00Z")], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "CodeRabbit 機器人核准 → 排除", files: ["src/utils/money.js"], reviews: [rev("coderabbitai[bot]", "APPROVED", "2026-11-01T01:00:00Z", "Bot")], expect: { risk: "medium", need: 1, gatePass: false, auto: false } },
  { name: "多分頁 review 也能正確攤平", files: ["src/utils/money.js"], rawPages: pages([rev("alice", "COMMENTED", "2026-11-01T01:00:00Z")], [rev("bob", "APPROVED", "2026-11-01T02:00:00Z")]), expect: { risk: "medium", need: 1, gatePass: true, auto: false } },
  { name: "low 但來自 fork → 不自動合併", files: ["docs/CHANGELOG.md"], opts: { isFork: true }, expect: { risk: "low", need: 0, gatePass: true, auto: false } },
  { name: "low 但仍是 Draft → 不自動合併", files: ["docs/CHANGELOG.md"], opts: { isDraft: true }, expect: { risk: "low", need: 0, gatePass: true, auto: false } },
  { name: "low 但 CI 失敗 → 不自動合併", files: ["docs/CHANGELOG.md"], opts: { ciPassed: false }, expect: { risk: "low", need: 0, gatePass: true, auto: false } },
];

function cmdSelftest(argv, opts) {
  const rules = loadRules(opts.paths);
  const report = [];
  let failed = 0;
  console.log("=== gate-check selftest ===\n");
  for (const c of CASES) {
    const classification = classifyFiles(c.files, rules);
    const risk = classification.overall;
    const pagesData = c.rawPages ?? [c.reviews ?? []];
    const tally = tallyReviews(pagesData, c.author ?? "author");
    const result = decide({
      risk,
      approvers: tally.approvers,
      isDraft: c.opts?.isDraft ?? false,
      isFork: c.opts?.isFork ?? false,
      ciPassed: c.opts?.ciPassed ?? true,
    });
    const checks = {
      risk: result.risk === c.expect.risk,
      need: result.need === c.expect.need,
      gatePass: result.gatePass === c.expect.gatePass,
      autoMerge: result.autoMergeEligible === c.expect.auto,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failed++;
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => `${k}: 得到 ${result[risk === k ? "risk" : k] ?? "?"}`);
    console.log(`${ok ? "PASS" : "FAIL"} | ${risk.padEnd(6)} | 需 ${result.need} 有 ${result.got} | 門檻 ${result.gatePass ? "過" : "阻"} | 自動合併 ${result.autoMergeEligible ? "是" : "否"} | ${c.name}${ok ? "" : "  ← " + bad.join(", ")}`);
    report.push({ name: c.name, files: c.files, ok, checks, result, approvers: tally.approvers, skipped: tally.skipped });
  }
  const total = CASES.length;
  console.log(`\n=== 結果：${total - failed}/${total} 通過 ===`);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify({ total, failed, ranAt: new Date().toISOString(), cases: report }, null, 2));
    console.log(`詳細結果：${opts.out}`);
  }
  return failed === 0 ? 0 : 1;
}

// ---------- 子命令：check-config ----------
function cmdCheckConfig(argv, opts) {
  const problems = [];
  const warns = [];
  const read = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      problems.push(`找不到檔案：${p}`);
      return "";
    }
  };

  const rabbit = read(".coderabbit.yaml");
  for (const [key, why] of [
    ["auto_incremental_review: true", "少了這個，每一輪都會重翻舊帳（無限迴圈的來源）"],
    ["request_changes_workflow: false", "設 true 會讓 AI 意見直接卡住合併"],
    ["profile: chill", "設成 assertive 會產生大量無效意見"],
    ["drafts: false", "Draft 階段就開始審核會浪費預算"],
  ]) {
    if (!rabbit.includes(key)) problems.push(`.coderabbit.yaml 缺少 ${key} —— ${why}`);
  }

  const gate = read(".github/workflows/risk-gate.yml");
  if (!gate.includes("gate-check.mjs")) problems.push("risk-gate.yml 沒有呼叫 gate-check.mjs（判定邏輯可能分叉成兩份）");
  const dryRunLine = gate.match(/DRY_RUN:\s*"?(\w+)"?/);
  if (!dryRunLine) warns.push("risk-gate.yml 找不到 DRY_RUN 開關");
  else if (dryRunLine[1] === "true") warns.push("目前 DRY_RUN=true：低風險只留言不合併（觀察期正常）");

  const owners = read(".github/CODEOWNERS");
  const placeholders = owners.match(/@your-org\/[\w-]+/g) ?? [];
  if (placeholders.length) warns.push(`CODEOWNERS 有 ${placeholders.length} 個佔位 handle 未替換，GitHub 會直接忽略：${placeholders.slice(0, 3).join(", ")}…`);

  let paths;
  try {
    paths = JSON.parse(read(".github/risk-paths.json"));
  } catch {
    paths = {};
  }
  for (const k of ["high", "medium", "low"]) {
    if (!Array.isArray(paths[k]) || paths[k].length === 0) problems.push(`risk-paths.json 的 ${k} 欄位缺失`);
  }
  if (!paths.high?.includes(".ai-review/**")) warns.push("建議把 .ai-review/** 列為 high：改審核規則本身就是高風險");

  console.log("=== check-config ===");
  problems.forEach((p) => console.log(`  ✗ ${p}`));
  warns.forEach((w) => console.log(`  ! ${w}`));
  if (!problems.length && !warns.length) console.log("  全部正常");
  console.log(`--- 問題 ${problems.length} 件，提醒 ${warns.length} 件`);
  return problems.length ? 1 : 0;
}

// ---------- 進入點 ----------
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = {
    paths: readArg(argv, "paths") ?? ".github/risk-paths.json",
    out: readArg(argv, "out"),
    log: readArg(argv, "log"),
    files: readArg(argv, "files"),
    filesFile: readArg(argv, "files-file"),
    filesJson: readArg(argv, "files-json"),
    reviews: readArg(argv, "reviews"),
    author: readArg(argv, "author"),
    risk: readArg(argv, "risk"),
    quiet: hasFlag(argv, "quiet"),
  };
  switch (cmd) {
    case "classify":
      return cmdClassify(argv, opts);
    case "decide":
      return cmdDecide(argv, opts);
    case "selftest":
      return cmdSelftest(argv, opts);
    case "check-config":
      return cmdCheckConfig(argv, opts);
    default:
      console.log(
        [
          "用法：node gate-check.mjs <command> [options]",
          "",
          "  classify      --files a.js,b.js | --files-json <path>   判定風險等級",
          "  decide        --reviews <path> --author <login> [--risk high] [--draft] [--fork] [--ci-failed] [--dry-run]",
          "  selftest      跑內建情境測試",
          "  check-config  檢查管線設定檔完整性",
          "",
          "通用：--paths <risk-paths.json>  --out <result.json>  --log <file.log>  --quiet",
        ].join("\n")
      );
      return cmd ? 1 : 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("gate-check.mjs")) {
  process.exit(main());
}
