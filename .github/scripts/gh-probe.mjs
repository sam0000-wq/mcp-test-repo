#!/usr/bin/env node
// =============================================================
// gh-probe.mjs —— 檢查憑證可用範圍，不建立、不修改任何東西
//
// token 只從環境變數 GH_TOKEN / GITHUB_TOKEN 讀取，
// 不接受命令列參數（避免被複製到指令紀錄裡），也不印出任何一部分的內容。
// =============================================================
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
if (!TOKEN) {
  console.log("FAIL 環境變數 GH_TOKEN 未設定");
  process.exit(1);
}
// 只顯示前綴與長度，用來判斷是 classic(pto_) 還是 fine-grained(github_pat_) 格式
console.log(`token 格式：${TOKEN.startsWith("github_pat_") ? "fine-grained" : TOKEN.startsWith("ghp_") ? "classic" : "其他"}，長度 ${TOKEN.length}`);

const base = "https://api.github.com";
const opts = { headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "probe", Accept: "application/vnd.github+json" } };

async function probe(label, path, { show = () => "" } = {}) {
  try {
    const res = await fetch(base + path, opts);
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    const hint = show(body, res);
    console.log(`${res.ok ? "OK  " : "BLOCK"} ${res.status} | ${label}${hint ? " → " + hint : ""}`);
    return { ok: res.ok, status: res.status, body, res };
  } catch (e) {
    console.log(`FAIL      | ${label} → ${e.message}`);
    return { ok: false, error: e.message };
  }
}

(async () => {
  console.log("=== 身分與權限探測（唯讀） ===");

  const me = await probe("我是誰 /user", "/user", (b) => (b?.login ? `${b.login}（${b.type}，id ${b.id}）` : b?.message));

  // classic token 會在標頭洩露 scopes；fine-grained 不會
  const info = await probe("根端點 /", "/", () => "");
  const scopes = info.res?.headers?.get?.("x-oauth-scopes");
  const accepted = info.res?.headers?.get?.("x-accepted-oauth-scopes");
  console.log(`     X-OAuth-Scopes: ${scopes ?? "（無 → 代表不是 classic token）"}`);
  console.log(`     X-Accepted-OAuth-Scopes: ${accepted ?? "（無）"}`);

  await probe("能否列出我的 repo /user/repos?per_page=1", "/user/repos?per_page=1", (b) =>
    Array.isArray(b) ? `抓到 ${b.length} 個（代表可以列 repo）` : b?.message
  );

  const rl = await probe("速率限制 /rate_limit", "/rate_limit", (b) =>
    b?.resources?.core ? `core 剩 ${b.resources.core.remaining}/${b.resources.core.limit}， resets ${new Date(b.resources.core.reset * 1000).toLocaleTimeString()}` : b?.message
  );

  // 建立 repo 的能力：fine-grained token 歷史上不支援 POST /user/repos，
  // 這裡只做「預檢」——用一個故意不合法的 body 讓它在權限檢查階段就回 403/422，
  // 但不真的建立（缺少必填 name 之外的條件時 GitHub 會先掃權限）。
  // 為了完全不產生副作用，改看「是否取得 Administration 相关能力」的線索：
  await probe("看我有沒有被授權任何 repo（/installation 類端點應為 403/404）", "/repos/octocat/Hello-World", (b) =>
    b?.permissions ? `公開 repo 可見，push=${b.permissions.push}，admin=${b.permissions.admin}` : b?.message
  );

  const login = me.body?.login;
  console.log("\n=== 結論 ===");
  if (!me.ok) {
    console.log("token 無效或已被撤銷／被 GitHub 因為外洩偵測而停用。");
  } else {
    console.log(`帳號：${login}`);
    console.log(scopes ? `classic scopes：${scopes}` : "fine-grained：沒有 scopes 可查，能力受限於建立時勾選的 repo 與權限。");
  }
  console.log(rl.ok ? "API 可呼叫。" : "API 呼叫受阻。");
  if (info.res?.headers?.get("github-authentication-token-expiration")) {
    console.log(`到期時間：${info.res.headers.get("github-authentication-token-expiration")}`);
  }
  process.exit(me.ok ? 0 : 2);
})();
