// 金額一律以「分」為單位的整數處理，避免浮點數誤差。
// 這是金流模組的地基，改這裡等於改全公司的帳。
export function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`金額不是合法數字：${amount}`);
  return Math.round(n * 100);
}

export function addCents(...values) {
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error(`金額必須是整數（單位：分），收到 ${v}`);
  }
  return values.reduce((a, b) => a + b, 0);
}

export function applyDiscount(cents, percent) {
  if (!Number.isInteger(cents)) throw new Error(`金額必須是整數（單位：分）：${cents}`);
  if (percent < 0 || percent > 100) throw new Error(`折扣百分比超出範圍：${percent}`);
  return Math.round(cents * (1 - percent / 100));
}

export function formatTwd(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}NT$${whole}.${frac}`;
}
