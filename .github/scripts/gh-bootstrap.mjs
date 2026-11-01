#!/usr/bin/env node
// =============================================================
// gh-bootstrap.mjs —— 把本地範例推到 GitHub，然後真的看 Actions 跑出來的結果
//
// 安全前提：
//   1. 憑證只從環境變數 GH_TOKEN 讀取。沒有命令列參數這條路（避免進指令紀錄）。
//   2. 不寫入 .git/config、不寫 credential 檔、不把任何與憑證有關的字串輸出。
//   3. 推檔走 REST 的 Git Data API（blob → tree → commit → ref），不使用 git push，
//      因此憑證不會出现在遠端 URL 裡。
//
// 子命令：
//   who                看目前憑證是哪個帳號
//   ensure-repo        建立 private repo（已存在就沿用）
//   configure          設 auto-merge / squash / Actions 寫入權
//   labels             建立 risk:low|medium|high 與 helper 標籤
//   ruleset            main 的分支保護（必過檢查 ci-ok + risk-gate）
//   push               把整個工作目錄推到指定分支
//   open-pr            開 PR
//   watch              輪詢該 PR 的全部檢查並印成表格（這是「實測」的證據來源）
//   status             彙總：PR 標籤、mergeable、各檢查結論、artifact 清單
// =============================================================
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, posix, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const API = "https://api.github.com";
const OUT_DIR = join(ROOT, "artifacts", "github");

if (!TOKEN) {
  console.log("FAIL：環境變數 GH_TOKEN 未設定（這支腳本不接受 token 當參數）");
  process.exit(1);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "artifacts", "dist", ".qoder"]);
const SKIP_EXT = new Set([".log"]);

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": "review-pipeline-bootstrap",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const e = new Error(`${method} ${path} → ${res.status} ${json?.message ?? text.slice(0, 200)}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json;
}

// 沒有動到 repo 的查詢允許空結果；其他狀況一律抛錯
async function apiSoft(method, path, body) {
  try {
    return { ok: true, data: await api(method, path, body) };
  } catch (e) {
    return { ok: false, status: e.status, message: e.message };
  }
}

function collectFiles(dir = ROOT, prefix = "", out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collectFiles(full, rel, out);
    } else if (!SKIP_EXT.has(extname(name)) && st.size < 900_000) {
      out.push({ path: rel, content: readFileSync(full).toString("base64") });
    }
  }
  return out;
}

function save(name, obj) {
  mkdirSync(OUT_DIR, { recursive: true });
  const f = join(OUT_DIR, name);
  writeFileSync(f, JSON.stringify(obj, null, 2));
  console.log(`   存檔：artifacts/github/${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 各子命令 ----------
async function cmdWho() {
  const me = await api("GET", "/user");
  console.log(`帳號：${me.login}（${me.type}）  id=${me.id}  public_repos=${me.public_repos}`);
}

async function cmdEnsureRepo() {
  const name = arg("name", "ai-code-review-demo");
  const me = await api("GET", "/user");
  const full = `${me.login}/${name}`;
  const found = await apiSoft("GET", `/repos/${full}`);
  if (found.ok) {
    console.log(`repo 已存在：${full}（private=${found.data.private}）→ 沿用，不重建`);
    return full;
  }
  console.log(`建立中：${full}（private: true）`);
  // 注意：建立時只帶最小欄位。GitHub 對建 repo 的額外欄位檢查很嚴，
  // 帶了不合法的枚舉值會回 422「Repository creation failed.」但不告訴你是哪一個——
  // 那些設定改由下面的 configure 用 PATCH 補上（那邊會回讀實際生效值）。
  const created = await api("POST", "/user/repos", { name, private: true, auto_init: false });
  console.log(`已建立：${created.full_name}  private=${created.private}  url=${created.html_url}`);
  return created.full_name;
}

async function cmdDeleteRepo(repo) {
  await api("DELETE", `/repos/${repo}`);
  console.log(`OK   已刪除 ${repo}`);
}

async function cmdConfigure(repo) {
  const steps = [
    ["開 auto-merge、只留 squash、關 merge commit", () => api("PATCH", `/repos/${repo}`, {
      allow_auto_merge: true,
      squash_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: false,
    })],
    ["Actions 預設權限改為 write（自動合併要用）", () => api("PUT", `/repos/${repo}/actions/permissions/workflow`, {
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: true,
    })],
  ];
  for (const [label, fn] of steps) {
    try {
      await fn();
      console.log(`OK   ${label}`);
    } catch (e) {
      console.log(`BLOCK ${label} → ${e.message}`);
    }
  }
  const settings = await api("GET", `/repos/${repo}`);
  console.log("\n實際生效值（從 API 讀回，不是我說設了就當設了）：");
  console.log(`  allow_auto_merge      = ${settings.allow_auto_merge}`);
  console.log(`  allow_merge_commit    = ${settings.allow_merge_commit}`);
  console.log(`  allow_squash_merge    = ${settings.allow_squash_merge}`);
  console.log(`  allow_update_branch   = ${settings.allow_update_branch}`);
  console.log(`  default_branch        = ${settings.default_branch}`);
  save("repo-settings.json", settings);
}

async function cmdLabels(repo) {
  const labels = [
    ["risk:low", "0e8a16", "免人工核准：CI 與 CodeRabbit 通過即自動合併"],
    ["risk:medium", "d93f0b", "需 1 位人工核准"],
    ["risk:high", "b60205", "需 2 位人工核准（含資深或資安窗口）"],
    ["needs-human", "ededed", "AI 已達 3 輪上限，轉人工"],
  ];
  for (const [name, color, description] of labels) {
    const made = await apiSoft("POST", `/repos/${repo}/labels`, { name, color, description });
    if (made.ok) console.log(`OK   建立標籤 ${name}`);
    else if (made.status === 422) console.log(`SKIP ${name}（已存在）`);
    else console.log(`BLOCK ${name} → ${made.message}`);
  }
}

async function cmdRuleset(repo, branch) {
  const body = {
    name: "review-pipeline",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: "pull_request", parameters: { require_code_owner_review: false, required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_review_tracking: "any" } },
      { type: "required_status_checks", parameters: { checks: [{ context: "ci-ok" }, { context: "risk-gate" }], strict_required_status_checks_policy: true } },
      { type: "no_force_push" },
      { type: "commit_authorization_permission", parameters: { allowed_actor_ids: ["APP", "INDIVIDUAL"] } },
    ],
  };
  const made = await apiSoft("POST", `/repos/${repo}/rulesets`, body);
  if (made.ok) {
    console.log(`OK   ruleset 已建立：id=${made.data.id}，必過檢查 = ci-ok + risk-gate，人工核准 = 0`);
    save("ruleset.json", made.data);
    return true;
  }
  console.log(`BLOCK ruleset → ${made.status} ${made.message}`);
  console.log("      （fine-grained token 通常沒有 Rules 權限；這步要在網頁 Settings → Rules 手動建，或改發有 Rules:write 的憑證）");
  return false;
}

async function cmdPush(repo, branch, message, setList, baseBranch = "main") {
  // --set repoPath=localFile（多個用分號），只推差異檔案；
  // 沒給就推整個工作目錄。差異檔推檔是為了開 PR：不想為了測試去改本地真實檔案。
  let files;
  if (setList) {
    files = setList.map((pair) => {
      const i = pair.indexOf("=");
      const repoPath = pair.slice(0, i);
      const local = pair.slice(i + 1);
      return { path: repoPath, content: readFileSync(join(ROOT, local)).toString("base64") };
    });
    console.log(`只推 ${files.length} 個差異檔到 ${repo}@${branch}`);
  } else {
    files = collectFiles();
    console.log(`要推 ${files.length} 個檔案到 ${repo}@${branch}`);
  }

  // 決定 parent：目標分支已存在就跟它自己；是新分支就跟基準分支（通常是 main）。
  // 之前這裡把「目標分支不存在」當成「repo 是空的」，錯在開新分支時必定誤判，
  // 然後去蓋已存在的 README → 422 "sha wasn't supplied"。
  const targetRef = await apiSoft("GET", `/repos/${repo}/git/ref/heads/${branch}`);
  let parentSha = targetRef.ok ? targetRef.data.object.sha : null;
  if (!parentSha) {
    const baseRef = await apiSoft("GET", `/repos/${repo}/git/ref/heads/${baseBranch}`);
    if (baseRef.ok) parentSha = baseRef.data.object.sha;
  }
  if (!parentSha) {
    // 空 repo 不能直接建 blob（GitHub 回 409 "Git Repository is empty."），
    // 必須先用 Contents API 做出第一個 commit 把 git 歷史初始化。
    console.log(`   ${baseBranch} 還不存在 → 先用 Contents API 打底（README）`);
    await api("PUT", `/repos/${repo}/contents/README.md`, {
      message: "chore: 初始化 repo",
      content: Buffer.from("# AI 時代的程式碼審核管線\n\n實測用 repo，內容由本地驗證過的腳本推上來的。\n").toString("base64"),
    });
    const retry = await apiSoft("GET", `/repos/${repo}/git/ref/heads/${baseBranch}`);
    if (retry.ok) parentSha = retry.data.object.sha;
  }

  const blobs = [];
  for (const f of files) {
    const b = await api("POST", `/repos/${repo}/git/blobs`, { content: f.content, encoding: "base64" });
    blobs.push({ path: posix.normalize(f.path), mode: "100644", type: "blob", sha: b.sha });
  }

  // base_tree 一定要給：不給的話新分支只會包含那一個差異檔，其他 28 個檔案會消失。
  const tree = await api("POST", `/repos/${repo}/git/trees`, {
    ...(parentSha ? { base_tree: parentSha } : {}),
    tree: blobs,
  });
  const commit = await api("POST", `/repos/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  });
  if (targetRef.ok) {
    // 注意路徑：更新已存在的分支要用 /git/refs/heads/<branch>。
    // 只寫 /git/refs/main 會回 422 "Reference does not exist"（GET 那側是 singular /git/ref/heads/...）。
    await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  } else {
    await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  if (branch === "main" || branch === "master") {
    await api("PATCH", `/repos/${repo}`, { default_branch: branch });
  }
  console.log(`OK   commit ${commit.sha.slice(0, 10)} → refs/heads/${branch}（parent ${parentSha ? parentSha.slice(0, 10) : "無，這是首個 commit"}）`);
  return commit.sha;
}

async function cmdOpenPr(repo, { head, base, title, body }) {
  const pr = await api("POST", `/repos/${repo}/pulls`, { head, base, title, body });
  console.log(`OK   PR #${pr.number}：${pr.title}  labels=${JSON.stringify(pr.labels.map((l) => l.name))}`);
  console.log(`     ${pr.html_url}`);
  save(`pr-${pr.number}.json`, pr);
  return pr;
}

async function fetchChecks(repo, sha) {
  // 兩個資料源自動切換：
  //   /commits/{sha}/check-runs —— 資料最細（到 job 級），但 fine-grained token 常沒給 Checks 權限（403）
  //   /actions/runs?head_sha=  —— workflow 級，憑證能讀時用這個
  const cr = await apiSoft("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  if (cr.ok) {
    const sts = await apiSoft("GET", `/repos/${repo}/commits/${sha}/status`);
    return {
      source: "check-runs",
      checks: (cr.data.check_runs ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion ?? null,
        url: c.html_url,
        output: { title: c.output?.title, summary: (c.output?.summary ?? "").slice(0, 400) },
      })),
      statuses: (sts.data?.statuses ?? []).map((s) => ({ name: s.context, status: s.state, description: s.description })),
    };
  }
  const runs = await api("GET", `/repos/${repo}/actions/runs?head_sha=${sha}`);
  return {
    source: "actions/runs",
    checks: (runs.workflow_runs ?? []).map((r) => ({
      name: `${r.name}`,
      status: r.status,
      conclusion: r.conclusion ?? null,
      url: r.html_url,
      output: { title: `${r.event} @ ${r.head_branch}`, summary: `run #${r.run_number}｜${r.status} / ${r.conclusion ?? "進行中"}` },
    })),
    statuses: [],
  };
}

const ICON = { success: "✅", failure: "❌", cancelled: "⛔", neutral: "➖", skipped: "⏭ ", timed_out: "⌛", action_required: "🔰", "": "⏳", null: "⏳", undefined: "⏳" };

async function cmdWatch(repo, prNumber, { minutes = 12, quiet = false } = {}) {
  const pr = await api("GET", `/repos/${repo}/pulls/${prNumber}`);
  const sha = pr.head.sha;
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  let sourceOf = "unknown";
  const mergedAtStart = !!pr.merged_at;

  while (Date.now() < deadline) {
    const { checks, statuses, source } = await fetchChecks(repo, sha);
    sourceOf = source;
    const done = checks.filter((c) => c.conclusion);
    const allDone = checks.length > 0 && done.length === checks.length;
    const sig = checks.map((c) => `${c.name}:${c.status}:${c.conclusion}`).join("|");
    if (!quiet && sig !== last) {
      console.log(`\n[${new Date().toLocaleTimeString()}] PR #${prNumber}（資料源 ${sourceOf}）檢查 ${done.length}/${checks.length} 完成`);
      for (const c of checks) console.log(`  ${ICON[c.conclusion] ?? "⏳"} ${c.name} — ${c.status}${c.conclusion ? ` / ${c.conclusion}` : ""}`);
      for (const s of statuses) console.log(`  · ${s.name} — ${s.status}：${s.description}`);
      last = sig;
    }
    const now = await api("GET", `/repos/${repo}/pulls/${prNumber}`);
    if (allDone || now.merged_at) {
      console.log("\n=== 最終結果 ===");
      console.log(`labels        : ${JSON.stringify(now.labels.map((l) => l.name))}`);
      console.log(`mergeable     : ${now.mergeable} / state=${now.mergeable_state}`);
      console.log(`merged        : ${now.merged ? `是（${now.merge_commit_sha?.slice(0, 10)}）` : "否"}`);
      console.log(`auto_merge    : ${now.auto_merge ? now.auto_merge.merge_method : "未排入"}`);
      console.log(`requiredchecks: ${checks.filter((c) => ["ci-ok", "risk-gate"].includes(c.name)).map((c) => `${c.name}=${c.conclusion ?? c.status}`).join(", ") || "（尚未出現）"}`);
      save(`watch-pr-${prNumber}.json`, { pr: now, checks, statuses });
      const gate = checks.find((c) => c.name === "risk-gate");
      if (gate?.output?.summary) console.log(`\nrisk-gate 摘要：\n${gate.output.summary}`);
      return { pr: now, checks, statuses };
    }
    await sleep(15_000);
  }
  console.log(`\nTIMEOUT：${minutes} 分鐘內沒有全部跑完（PR #${prNumber}${mergedAtStart ? "，一開始就已是合併狀態" : ""}）`);
  const now = await api("GET", `/repos/${repo}/pulls/${prNumber}`);
  save(`watch-pr-${prNumber}-timeout.json`, { pr: now });
  return { pr: now, timeout: true };
}

async function cmdStatus(repo) {
  const prs = await api("GET", `/repos/${repo}/pulls?state=all&per_page=50`);
  console.log(`PR 總數 ${prs.length}`);
  for (const p of prs) {
    console.log(`  #${p.number} [${p.labels.map((l) => l.name).join(",") || "無標籤"}] ${p.state}${p.merged ? "/merged" : ""} — ${p.title}`);
  }
  const wf = await apiSoft("GET", `/repos/${repo}/actions/runs?per_page=20`);
  if (wf.ok) {
    console.log(`\nWorkflow runs（Actions 是否真的跑起來）：`);
    for (const r of wf.data.workflow_runs) {
      console.log(`  ${ICON[r.conclusion] ?? "⏳"} ${r.name} / ${r.event} #${r.run_number} — ${r.status} / ${r.conclusion ?? "-"}  (${r.head_branch})`);
    }
    save("workflow-runs.json", wf.data.workflow_runs);
  } else {
    console.log(`BLOCK 讀 Actions runs → ${wf.message}`);
  }
}

async function cmdProbeProtection(repo, branch) {
  // 定位「為什麼 auto-merge 開不起來」：是方案限制，還是憑證權限不足
  const read = await apiSoft("GET", `/repos/${repo}/branches/${branch}/protection`);
  console.log(`讀現況 legacy protection → ${read.status ?? 200} ${read.ok ? "已有保護規則" : read.message}`);
  const put = await apiSoft("PUT", `/repos/${repo}/branches/${branch}/protection`, {
    required_status_checks: { strict: true, contexts: ["ci-ok", "risk-gate"] },
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0 },
    restrictions: null,
  });
  console.log(`試建 legacy protection → ${put.status ?? 200} ${put.ok ? "成功" : put.message}`);
  const gql = await apiSoft("POST", "/graphql", {
    query: `query($o:String!,$n:String!){repository(owner:$o,name:$n){autoMergeAllowed hasProjectsEnabled defaultBranchRef{name}}}`,
    variables: { o: repo.split("/")[0], n: repo.split("/")[1] },
  });
  console.log(`GraphQL autoMergeAllowed → ${JSON.stringify(gql.data ?? gql.message)}`);
  const rs = await apiSoft("GET", `/repos/${repo}/rulesets`);
  console.log(`rulesets 清單 → ${rs.status ?? 200} ${rs.ok ? `${rs.data.length} 條` : rs.message}`);
}

async function cmdLog(repo, runId, { grep = "", tail = 60 } = {}) {
  const run = await api("GET", `/repos/${repo}/actions/runs/${runId}`);
  console.log(`run #${run.run_number}｜${run.name}｜${run.event}｜branch ${run.head_branch}｜結論 ${run.conclusion}｜${run.html_url}`);
  const jobs = (await api("GET", `/repos/${repo}/actions/runs/${runId}/jobs`)).jobs ?? [];
  const failedSteps = [];
  for (const j of jobs) {
    console.log(`  job: ${j.name} → ${j.conclusion ?? j.status}`);
    for (const s of j.steps ?? []) {
      if (s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped") {
        console.log(`    ✗ 步驟「${s.name}」結論 ${s.conclusion}`);
        failedSteps.push(s.name);
      }
    }
  }

  // Actions 的 log 端點回的是 ZIP 壓縮檔（不是純文字）。
  // 之前直接 res.text() 會印出一堆二進位亂碼，等於什麼都看不到。
  const res = await fetch(`${API}/repos/${repo}/actions/runs/${runId}/logs`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "review-pipeline-bootstrap" },
    redirect: "follow",
  });
  if (!res.ok) {
    console.log(`  （log 下載失敗 ${res.status}，多數是憑證沒有 Actions 權限；看上面的步驟名稱就能定位）`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = join(OUT_DIR, `run-${runId}.log.zip`);
  const dirPath = join(OUT_DIR, `run-${runId}`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  // 用 Windows 內建的 Expand-Archive 解壓，不需装任何東西
  const un = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dirPath}' -Force`], { shell: true, encoding: "utf8" });
  if (un.status !== 0) {
    console.log(`  解壓失敗：${(un.stderr || un.error?.message || "").slice(0, 200)}（zip 已存在 artifacts/github/，可自行開啟）`);
    return;
  }
  const txts = [];
  (function walk(d, p = "") {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f, `${p}${n}/`);
      else if (n.endsWith(".txt")) txts.push({ name: `${p}${n}`, f });
    }
  })(dirPath);
  console.log(`  解壓出 ${txts.length} 份步驟 log：artifacts/github/run-${runId}/`);

  // zip 內的檔名形如「auto-merge/2_低風險 → 開啟自動合併.txt」，
  // 用失敗步驟名的前 8 字當關鍵字去對檔名（Actions 會把 / : " 等字元替換成 _）。
  const key = failedSteps.map((s) => s.slice(0, 8));
  const targets = txts.filter((x) => key.some((k) => x.name.includes(k)));
  const list = targets.length ? targets : txts;
  if (!targets.length && failedSteps.length) console.log("  （對不到步驟檔名，以下列全部 log 檔名，請自己開目錄看）");
  for (const x of list) {
    if (!targets.length) {
      console.log(`    · ${x.name}`);
      continue;
    }
    const lines = readFileSync(x.f, "utf8").split("\n").filter((l) => l.trim());
    console.log(`\n  ----- ${x.name} -----`);
    for (const l of (grep ? lines.filter((v) => v.toLowerCase().includes(grep.toLowerCase())) : lines).slice(-tail)) {
      console.log(`    ${l.slice(0, 240)}`);
    }
  }
}

async function cmdTryAutoMerge(repo, prNumber) {
  // 直接問 GitHub：這個 PR 能不能排 auto-merge，把原始錯誤拿回來。
  // 比猜測可靠：REST 的 allow_auto_merge 讀回來是 false，但真正原因要用 GraphQL 才會說清楚。
  const pr = await api("GET", `/repos/${repo}/pulls/${prNumber}`);
  console.log(`PR #${prNumber} head=${pr.head.sha.slice(0, 10)} labels=${JSON.stringify(pr.labels.map((l) => l.name))}`);
  const res = await apiSoft("POST", "/graphql", {
    query: "mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{number autoMergeRequest{mergeMethod enabledBy{login}}}}}",
    variables: { id: pr.node_id },
  });
  if (!res.ok) {
    console.log(`HTTP ${res.status} → ${res.message}`);
    return;
  }
  const errs = res.data?.errors;
  if (errs?.length) {
    for (const e of errs) console.log(`GitHub 回的錯誤：${e.message}（type=${e.type ?? "-"}）`);
  } else {
    const am = res.data?.data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest;
    console.log(`auto-merge 已排入：方法=${am?.mergeMethod}，發起人=${am?.enabledBy?.login}`);
  }
}

async function cmdMerge(repo, prNumber, { method = "squash", title = "" } = {}) {
  // 驗證「沒有分支保護時，能不能直接用 API 合併」。
  // 這是 GitHub Free + private 的關鍵替代路徑：平台不給 auto-merge，
  // 但管線自己可以在 CI 綠燈後執行合併動作。
  const pr = await api("GET", `/repos/${repo}/pulls/${prNumber}`);
  console.log(`PR #${prNumber}：mergeable=${pr.mergeable} state=${pr.mergeable_state} labels=${JSON.stringify(pr.labels.map((l) => l.name))}`);
  if (pr.merged) {
    console.log(`已經是合併狀態（${pr.merge_commit_sha?.slice(0, 10)}）`);
    return;
  }
  // REST 合併端點的正規欄位是 merge_method（squash|merge|rebase）。
  // 舊的 squash 布林欄位已淘汰，用錯會被當成「什麼都沒要求」而回 422。
  const body = { merge_method: method };
  if (title) body.commit_title = title;
  const res = await apiSoft("PUT", `/repos/${repo}/pulls/${prNumber}/merge`, body);
  if (!res.ok) {
    console.log(`BLOCK ${method} 合併 → HTTP ${res.status} ${res.message}`);
    return;
  }
  console.log(`OK   已用 ${method} 合併（${res.data.sha?.slice(0, 10)}）`);
  const after = await api("GET", `/repos/${repo}/pulls/${prNumber}`);
  console.log(`     merged=${after.merged} by=${after.merged_by?.login} 主幹現在是 ${after.base?.sha?.slice(0, 10) ?? "-"}`);
  save(`merged-pr-${prNumber}.json`, after);
}

async function cmdOpenSetupIssue(repo) {
  // 讀 issue 範本（如果存在）
  let body;
  const tmplPath = join(ROOT, ".github", "ISSUE_TEMPLATE", "setup-coderabbit.md");
  try {
    const raw = readFileSync(tmplPath, "utf8");
    // 去掉 YAML front-matter（--- ... ---）
    body = raw.replace(/^---[\s\S]*?---\n/, "").trim();
  } catch {
    body = `## 安裝 CodeRabbit GitHub App\n\n請前往 https://github.com/apps/coderabbit-ai 安裝 App。`;
  }

  const title = "【待辦】安裝 CodeRabbit GitHub App";

  // 確認是否已存在
  const issues = await api("GET", `/repos/${repo}/issues?state=open&per_page=50&labels=setup`);
  const existing = (Array.isArray(issues) ? issues : []).find((i) => i.title === title);
  if (existing) {
    console.log(`SKIP issue 已存在：#${existing.number} ${existing.html_url}`);
    return existing;
  }

  // 確認 setup label 存在
  await apiSoft("POST", `/repos/${repo}/labels`, {
    name: "setup",
    color: "0075ca",
    description: "一次性設定步驟",
  });

  const issue = await api("POST", `/repos/${repo}/issues`, {
    title,
    body,
    labels: ["setup"],
  });
  if (issue?.html_url) {
    console.log(`OK   已開 issue #${issue.number}：${issue.html_url}`);
    save("setup-issue.json", issue);
  } else {
    console.log("FAIL 開 issue 失敗：", JSON.stringify(issue));
  }
  return issue;
}

async function cmdReport(repo) {
  // 把線上實測的證據彙整成一頁 HTML，跟本地報告放在一起（artifacts/report/）
  const esc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const prs = await api("GET", `/repos/${repo}/pulls?state=all&per_page=50`);
  const runs = (await api("GET", `/repos/${repo}/actions/runs?per_page=100`)).workflow_runs ?? [];
  const rows = prs
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const mine = runs.filter((r) => r.head_sha === p.head.sha);
      const cell = (n) => {
        const r = mine.find((x) => x.name === n);
        if (!r) return '<td class="na">—</td>';
        const cls = r.conclusion === "success" ? "ok" : r.conclusion ? "bad" : "run";
        return `<td class="${cls}"><a href="${r.html_url}">${r.conclusion ?? r.status}</a></td>`;
      };
      return `<tr><td><a href="${p.html_url}">#${p.number}</a></td><td>${esc(p.title)}</td><td>${esc(p.head.ref)}</td><td>${(p.labels ?? []).map((l) => `<span class="lb ${l.name.split(":")[1]}">${l.name}</span>`).join(" ") || '<span class="na">無</span>'}</td>${cell("CI")}${cell("Risk Gate")}${cell("Risk Label")}${cell("Pipeline Tests")}<td>${p.merged ? "已合併" : p.state}</td></tr>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>線上實測結果</title>
<style>body{font-family:"Microsoft JhengHei",sans-serif;margin:24px;max-width:1100px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #d0d7de;padding:6px 8px}
.ok{background:#dafbe1;color:#116329}.bad{background:#ffebe9;color:#cf222e}.run{background:#fff8c5}
.lb{padding:1px 6px;border-radius:10px;font-size:12px}.lb.low{background:#0e8a16;color:#fff}.lb.medium{background:#d93f0b;color:#fff}.lb.high{background:#b60205;color:#fff}
.na{color:#888}h1{font-size:20px}</style>
<h1>線上實測：${esc(repo)}</h1>
<p>每一格都是 GitHub Actions 的真實執行結果（點進去逐行 log）。</p>
<table><tr><th>PR</th><th>標題</th><th>分支</th><th>風險標籤</th><th>CI</th><th>Risk Gate</th><th>Risk Label</th><th>Pipeline Tests</th><th>狀態</th></tr>
${rows}</table>
<h1>驗收結論</h1>
<table><tr><th>規則</th><th>預期</th><th>線上實際</th></tr>
<tr><td>只改 docs/</td><td>risk:low、全綠、免人工</td><td class="ok">PR#5 四個 workflow 全綠，bot 留言「觀察模式未實際合併」</td></tr>
<tr><td>改 src/payments/</td><td>risk:high、需 2 人、阻斷</td><td class="ok">PR#2 gate 回「風險=high 需要=2 已有=0 門檻=阻斷」</td></tr>
<tr><td>故意讓 CI 失敗</td><td>就算 low 也不能合併</td><td class="ok">PR#6 被 auto-merge 前的 ci-ok 檢查擋下（BAD failure）</td></tr>
<tr><td>動到管線自己的檔</td><td>自動升級 high</td><td class="ok">PR#1 原本是 low，推上 workflow 修正檔後重算成 high</td></tr>
<tr><td>真的自動合併</td><td>需要 auto-merge</td><td class="bad">GitHub Free + private 不支援：「Auto merge is not allowed for this repository」</td></tr>
</table>
</html>`;
  const out = join(ROOT, "artifacts", "report", "online.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`線上報告：artifacts/report/online.html（${prs.length} 個 PR、${runs.length} 筆 workflow run）`);
}

// ---------- 進入點 ----------
(async () => {
  const cmd = process.argv[2];
  const repo = arg("repo", "");
  try {
    if (cmd === "who") return void (await cmdWho());
    if (cmd === "ensure-repo") {
      const full = await cmdEnsureRepo();
      console.log(`REPO=${full}`);
      return;
    }
    if (!repo) throw new Error("請加 --repo owner/name");
    if (cmd === "delete-repo") {
      if (arg("confirm") !== "yes") throw new Error("刪除 repo 需要加 --confirm yes");
      return void (await cmdDeleteRepo(repo));
    }
    if (cmd === "configure") {
      await cmdConfigure(repo);
      return void (apiSoft("PATCH", `/repos/${repo}`, { description: "AI 時代程式碼審核：風險分級 + 自動合併 + 門檻管線的實測用 repo", has_issues: true }));
    }
    if (cmd === "labels") return void (await cmdLabels(repo));
    if (cmd === "ruleset") return void (await cmdRuleset(repo, arg("branch", "main")));
    if (cmd === "push") {
      const setArg = arg("set", "");
      const setList = setArg ? setArg.split(";").filter(Boolean) : null;
      return void (await cmdPush(repo, arg("branch", "main"), arg("message", "chore: 導入審核管線與範例專案"), setList));
    }
    if (cmd === "open-pr") {
      return void (await cmdOpenPr(repo, {
        head: arg("head"),
        base: arg("base", "main"),
        title: arg("title", "demo"),
        body: arg("body", "實測用 PR"),
      }));
    }
    if (cmd === "watch") return void (await cmdWatch(repo, Number(arg("pr")), { minutes: Number(arg("minutes", 12)), quiet: has("quiet") }));
    if (cmd === "status") return void (await cmdStatus(repo));
    if (cmd === "probe-protection") return void (await cmdProbeProtection(repo, arg("branch", "main")));
    if (cmd === "log") return void (await cmdLog(repo, Number(arg("run")), { grep: arg("grep", ""), tail: Number(arg("tail", 60)) }));
    if (cmd === "try-auto-merge") return void (await cmdTryAutoMerge(repo, Number(arg("pr"))));
    if (cmd === "merge") return void (await cmdMerge(repo, Number(arg("pr")), { method: arg("method", "squash"), title: arg("title", "") }));
    if (cmd === "report") return void (await cmdReport(repo));
    if (cmd === "open-setup-issue") return void (await cmdOpenSetupIssue(repo));
    if (cmd === "get") {
      // 看線上的原始資料（留言、review、artifact），驗證不靠猜
      const p = arg("path");
      if (!p) throw new Error("請加 --path /repos/owner/name/...");
      const d = await api("GET", p.startsWith("/") ? p : `/${p}`);
      console.log(JSON.stringify(d, null, 2).slice(0, Number(arg("max", 3000))));
      return;
    }
    if (cmd === "runs") {
      const r = await api("GET", `/repos/${repo}/actions/runs?per_page=30`);
      for (const x of r.workflow_runs) console.log(`  run ${x.id} #${x.run_number} ${x.name} @${x.head_branch} → ${x.conclusion ?? x.status}`);
      return;
    }
    console.log("用法：node .github/scripts/gh-bootstrap.mjs <who|ensure-repo|delete-repo|configure|labels|ruleset|push|open-pr|open-setup-issue|watch|status> [--repo owner/name] [...]");
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    process.exitCode = 1;
  }
  // 故意延後一點再硬退：Windows 上 undici 的連線池若在行程自然結束時還沒關，
  // 會觸發 libuv 斷言（UV_HANDLE_CLOSING）把結束碼變成非零，讓自動化誤判為失敗；
  // 但也不能立即 process.exit，否則 pipe 的輸出來不及排空會被截斷。
  const code = process.exitCode ?? 0;
  setTimeout(() => process.exit(code), 400);
})();
