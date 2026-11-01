# 變更日誌

## 2026-11-01
- 建立審核管線範例專案：金流（`src/payments/`）、認證（`src/auth/`）、資料庫遷移（`migrations/`）。
- `docs/` 與 `tests/` 屬於低風險路徑，CI 與 CodeRabbit 通過後自動合併。
- `src/payments/`、`src/auth/`、`migrations/`、`.github/`、`.ai-review/` 屬高風險，需 2 位人工核准。

## 2026-10-31
- 補上折扣欄位與冪等鍵（`migrations/001_add_order_discount.sql`）。
