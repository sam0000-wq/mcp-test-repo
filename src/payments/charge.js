// 高風險模組：扣款。任何改動都需要 2 位人工核准（見 .github/risk-paths.json）。
import { toCents, addCents } from "../utils/money.js";

// store 由外部注入，方便測試與替換（不要在模組內藏全域狀態）
export function charge({ orderId, amount, idempotencyKey, discountPercent = 0, store }) {
  if (!orderId) throw new Error("缺少 orderId");
  if (!idempotencyKey) throw new Error("缺少 idempotencyKey：重複請求會重複扣款");
  if (!store) throw new Error("缺少 store（扣款記錄）");

  // 冪等：同一把 key 重複呼叫，直接回傳原本結果，不會再扣一次
  const existing = store.get(idempotencyKey);
  if (existing) return { ...existing, replayed: true };

  const gross = toCents(amount);
  const cents = discountPercent > 0 ? Math.round(gross * (1 - discountPercent / 100)) : gross;
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`扣款金額必須是正整數（單位：分），收到 ${cents}`);
  }

  const receipt = {
    orderId,
    cents,
    idempotencyKey,
    status: "succeeded",
    chargedAt: new Date().toISOString(),
  };

  // 先寫記錄再回傳：寫入失敗就視為扣款失敗，不能出現「扣了錢但沒記錄」
  store.set(idempotencyKey, receipt);
  store.appendAudit?.({ event: "charge", ...receipt });
  return receipt;
}

export function refund({ idempotencyKey, amount, store }) {
  const original = store.get(idempotencyKey);
  if (!original) throw new Error(`找不到原扣款記錄：${idempotencyKey}`);
  const cents = toCents(amount);
  if (cents > original.cents) throw new Error("退款金額超過原扣款金額");
  const record = { ...original, cents: -cents, status: "refunded", refundedAt: new Date().toISOString() };
  store.set(`${idempotencyKey}:refund`, record);
  store.appendAudit?.({ event: "refund", ...record });
  return record;
}

export function totalOf(receipts) {
  return addCents(...receipts.map((r) => r.cents));
}
