---
name: "【待辦】安裝 CodeRabbit GitHub App"
about: 一次性設定清單，安裝 CodeRabbit 並確認 AI 審核管線端到端通暢
title: "【待辦】安裝 CodeRabbit GitHub App"
labels: setup
assignees: ""
---

<!-- 這個 issue 由 coderabbit-probe workflow 自動建立，完成後會自動關閉 -->

## 目標

把 CodeRabbit AI 審核接進這個 repo，讓每個 PR 都有一位「永不請假的 AI 審查者」自動做第一輪審閱。

---

## 安裝步驟（一次性，約 5 分鐘）

### Step 1 — 安裝 GitHub App

前往 👉 **[github.com/apps/coderabbit-ai](https://github.com/apps/coderabbit-ai)**

- 點「Install」
- Repository access 選「Only select repositories」→ 選這個 repo
- 完成後 GitHub 會跳回 CodeRabbit 的 dashboard

> **免費方案**：public repo 完全免費；private repo 每月 50 次審核免費，之後 $12/月。

---

### Step 2 — 確認 `.coderabbit.yaml` 已就緒

這個 repo 根目錄已有 `.coderabbit.yaml`，不需要再建。
確認一下設定符合你的需求：

```bash
cat .coderabbit.yaml
```

重點項目：
- `language: zh-TW` — 意見用繁體中文輸出 ✓
- `profile: chill` — 只講重點，不輸出噪音 ✓
- `request_changes_workflow: false` — 不用「請求變更」卡 PR ✓
- `gitleaks.enabled: true` — 密鑰外洩掃描開啟 ✓

---

### Step 3 — 開一個測試 PR

任何小修改都可以，例如：

```bash
git checkout -b test/coderabbit-ping
echo "# ping" >> docs/CHANGELOG.md
git add docs/CHANGELOG.md
git commit -m "test: ping coderabbit"
git push origin test/coderabbit-ping
# 在 GitHub 上對 main 開 PR
```

等約 1–3 分鐘，CodeRabbit 應該會在 PR 上留下一則 review summary 和行內意見。

---

### Step 4 — 驗證管線端到端

打開那個測試 PR，確認以下全部打勾：

- [ ] PR 頁面出現 **coderabbitai[bot]** 的 review summary
- [ ] 有行內 code suggestion（至少一條）
- [ ] `risk-classify` check 跑完並顯示風險等級
- [ ] `risk-gate` check 通過（低風險 PR 不需要人工核准）
- [ ] （觀察期通過並經負責人核准後）低風險 PR 才會自動合併（目前 `DRY_RUN` 應維持 `true`）

---

### Step 5 — 觀察一週

安裝完成後，**觀察一週**再做最後確認：

- 每週一 [Weekly Review Stats](../../actions/workflows/weekly-review-stats.yml) 會自動統計本週意見品質
- 每週一 [Observation Period Check](../../actions/workflows/observation-period.yml) 會自動評估誤報率是否達標
- 若樣本數至少 5 且誤報率 < 30%，會自動開「觀察期通過」issue；由負責人核准後再啟用自動合併

---

## 管線現狀

| 項目 | 狀態 | 備註 |
| --- | --- | --- |
| `.coderabbit.yaml` | ✅ 已就緒 | 已調成繁中、chill profile、關噪音 |
| `CODEOWNERS` | ✅ 已設定 | 已改成真實帳號 |
| `risk-gate.yml` DRY_RUN | ✅ `"true"` | 觀察期只記錄、不自動合併；達標後由負責人核准啟用 |
| CodeRabbit App | ⚠️ **待安裝** | 請執行上面 Step 1 |
| 端到端驗證 | ⏳ 安裝後執行 | 請執行上面 Step 3–4 |

---

## 自動關閉

`coderabbit-probe` workflow 每天 11:00（台北）自動掃描，
偵測到 CodeRabbit bot 在這個 repo 有留下意見後，會自動關閉此 issue。

如果安裝後超過 24 小時仍未自動關閉，請手動到
[Actions → CodeRabbit Probe → Run workflow](../../actions/workflows/coderabbit-probe.yml) 觸發一次。
